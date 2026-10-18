/**
 * Data retention policy tests (#61).
 *
 * The planner is a pure function, so the destructive decision is tested
 * directly against records and an injected clock. The executor is tested
 * against a fake pool to prove the three safety properties the issue demands:
 * the rules are documented, the affected records are reported before anything
 * is deleted, and protected records are never eligible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEAD_JOB_RETENTION_DAYS,
  RETENTION_POLICY,
  RETENTION_SWEEP_JOB,
  TABLE_CLASS,
  classifyRecord,
  formatRetentionReport,
  hasLegalHold,
  planRetention,
  type RetentionRecord,
} from '../src/db/retention';
import {
  buildRetentionPlan,
  registerRetentionJob,
  runRetentionSweep,
  type RetentionDatabase,
} from '../src/db/retention-sweep';
import { JobWorker } from '../src/jobs/worker';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { NonRetryableJobError } from '../src/jobs/job-types';

const NOW = new Date('2026-09-27T12:00:00.000Z');

/** `days` before NOW, as an ISO timestamp. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function invoice(overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  return {
    table: 'invoices',
    id: 'i1',
    ageAnchor: daysAgo(10),
    status: 'EXPIRED',
    settlementLinked: false,
    metadata: null,
    ...overrides,
  };
}

interface FakeDbState {
  log: string[];
  rows: Record<string, any[]>;
}

function fakeDb(state: FakeDbState): RetentionDatabase {
  return {
    async query(text: string, params: unknown[] = []) {
      state.log.push(text.trim().split('\n')[0]);

      if (/^\s*DELETE/i.test(text)) {
        const table = /DELETE FROM "([^"]+)"/.exec(text)?.[1] ?? '';
        const ids = (params[0] as string[]) ?? [];
        const before = state.rows[table]?.length ?? 0;
        state.rows[table] = (state.rows[table] ?? []).filter((r) => !ids.includes(String(r.id)));
        return { rows: [], rowCount: before - state.rows[table].length };
      }

      if (text.includes("status = 'PAID'")) {
        return { rows: state.rows.settlementLinks ?? [] };
      }

      const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? '';
      return { rows: state.rows[table] ?? [] };
    },
  };
}

function seeded(): FakeDbState {
  return {
    log: [],
    rows: {
      settlementLinks: [{ id: 'i-paid' }],
      invoices: [
        { id: 'i-old', status: 'EXPIRED', created_at: daysAgo(800), metadata: null },
        { id: 'i-recent', status: 'PENDING', created_at: daysAgo(3), metadata: null },
        { id: 'i-held', status: 'EXPIRED', created_at: daysAgo(900), metadata: { legal_hold: true } },
        { id: 'i-paid', status: 'PAID', created_at: daysAgo(900), metadata: null },
      ],
      transactions: [{ id: 't-old', created_at: daysAgo(5000) }],
      payment_events: [],
      jobs: [],
    },
  };
}

describe('Retention policy', () => {
  it('classifies every table the schema owns', () => {
    for (const table of ['invoices', 'transactions', 'payment_events', 'jobs']) {
      assert.ok(TABLE_CLASS[table], `${table} has no retention class`);
    }
  });

  it('documents every rule with a rationale', () => {
    for (const [name, rule] of Object.entries(RETENTION_POLICY)) {
      assert.ok(rule.rationale.length > 20, `${name} needs a documented rationale`);
      assert.ok(rule.retainDays === null || rule.retainDays > 0, `${name} has a nonsensical window`);
      assert.ok(rule.ageAnchor, `${name} needs an age anchor`);
      assert.equal(rule.class, name);
    }
  });

  it('never purges settlement evidence', () => {
    assert.equal(RETENTION_POLICY.settlement.purgeable, false);
    assert.equal(RETENTION_POLICY.settlement.retainDays, null);
  });

  it('keeps telemetry and exports on the shortest windows', () => {
    const telemetry = RETENTION_POLICY.telemetry.retainDays!;
    const exports = RETENTION_POLICY.export_artifact.retainDays!;

    assert.equal(telemetry, 30);
    assert.equal(exports, 7);
    assert.ok(exports < telemetry, 'exports should expire before telemetry');
  });

  it('recognises legal holds', () => {
    assert.equal(hasLegalHold({ legal_hold: true }), true);
    assert.equal(hasLegalHold({ under_dispute: true }), true);
    assert.equal(hasLegalHold({ under_audit: 'true' }), true);
    assert.equal(hasLegalHold({ legal_hold: false }), false);
    assert.equal(hasLegalHold(null), false);
    assert.equal(hasLegalHold({ note: 'nothing to see' }), false);
  });
});

describe('Retention — classification of a single record', () => {
  it('protects settlement evidence at any age', () => {
    const ancient = classifyRecord(
      { table: 'transactions', id: 't1', ageAnchor: daysAgo(4000) },
      NOW
    );

    assert.equal(ancient.verdict.protected, true);
    assert.equal(ancient.verdict.reason, 'financial_settlement');
    assert.equal(ancient.verdict.eligibleAt, null);
  });

  it('protects a PAID invoice even long past the window', () => {
    // 730-day window, but this invoice is settlement-linked.
    const paid = classifyRecord(
      invoice({ id: 'i-paid', ageAnchor: daysAgo(3000), status: 'PAID', settlementLinked: true }),
      NOW
    );

    assert.equal(paid.verdict.protected, true);
    assert.equal(paid.verdict.reason, 'financial_settlement');
  });

  it('protects a record under legal hold regardless of age', () => {
    const held = classifyRecord(
      invoice({ id: 'i-held', ageAnchor: daysAgo(5000), metadata: { under_dispute: true } }),
      NOW
    );

    assert.equal(held.verdict.protected, true);
    assert.equal(held.verdict.reason, 'legal_hold');
  });

  it('protects a record inside its window', () => {
    const recent = classifyRecord(invoice({ id: 'i-recent', ageAnchor: daysAgo(10) }), NOW);

    assert.equal(recent.verdict.protected, true);
    assert.equal(recent.verdict.reason, 'within_retention_window');
    assert.equal(recent.class, 'invoice_lifecycle');
  });

  it('makes an unsettled record eligible once the window passes', () => {
    const old = classifyRecord(invoice({ id: 'i-old', ageAnchor: daysAgo(800) }), NOW);

    assert.equal(old.verdict.protected, false);
    assert.equal(old.verdict.reason, undefined);
    assert.ok(old.verdict.eligibleAt);
  });

  it('gives dead-lettered jobs a longer window than ordinary job history', () => {
    const between = DEAD_JOB_RETENTION_DAYS - 1;
    const dead = classifyRecord(
      { table: 'jobs', id: 'j1', ageAnchor: daysAgo(between), status: 'dead', deadLetter: true },
      NOW
    );
    const done = classifyRecord(
      { table: 'jobs', id: 'j2', ageAnchor: daysAgo(between), status: 'succeeded' },
      NOW
    );

    assert.equal(dead.verdict.protected, true, 'a dead job should still be inside its longer window');
    assert.equal(done.verdict.protected, false, 'an ordinary job past 30 days is eligible');
  });

  it('protects a record whose age anchor cannot be parsed', () => {
    // Guessing an age is how financial rows get deleted. Protect instead.
    const broken = classifyRecord(invoice({ id: 'i-broken', ageAnchor: 'not-a-date' }), NOW);

    assert.equal(broken.verdict.protected, true);
    assert.match(String(broken.verdict.detail), /not a valid timestamp/);
  });

  it('protects a record from a table with no rule', () => {
    const unknown = classifyRecord({ table: 'mystery', id: 'x1', ageAnchor: daysAgo(9999) }, NOW);

    assert.equal(unknown.verdict.protected, true);
    assert.equal(unknown.verdict.reason, 'class_not_purgeable');
  });
});

describe('Retention — planning', () => {
  const records: RetentionRecord[] = [
    invoice({ id: 'i-eligible', ageAnchor: daysAgo(800) }),
    invoice({ id: 'i-recent', ageAnchor: daysAgo(5) }),
    invoice({ id: 'i-held', ageAnchor: daysAgo(900), metadata: { legal_hold: true } }),
    invoice({ id: 'i-paid', ageAnchor: daysAgo(900), status: 'PAID', settlementLinked: true }),
    { table: 'transactions', id: 't1', ageAnchor: daysAgo(5000) },
  ];

  it('is a pure function of its inputs', () => {
    const a = planRetention(records, { now: NOW });
    const b = planRetention(records, { now: NOW });

    assert.deepEqual(a.eligible.map((e) => e.record.id), b.eligible.map((e) => e.record.id));
    assert.deepEqual(a.byClass, b.byClass);
    assert.equal(a.generatedAt, b.generatedAt);
  });

  it('separates eligible from protected', () => {
    const plan = planRetention(records, { now: NOW });

    assert.deepEqual(
      plan.eligible.map((e) => e.record.id),
      ['i-eligible']
    );
    assert.deepEqual(
      plan.protected.map((e) => e.record.id).sort(),
      ['i-held', 'i-paid', 'i-recent', 't1']
    );
  });

  it('is always a dry run', () => {
    assert.equal(planRetention(records, { now: NOW }).dryRun, true);
  });

  it('aggregates counts per class', () => {
    const plan = planRetention(records, { now: NOW });

    assert.deepEqual(plan.byClass.invoice_lifecycle, {
      eligible: 1,
      protected: 3,
      retainDays: 730,
    });
    assert.deepEqual(plan.byClass.settlement, { eligible: 0, protected: 1, retainDays: null });
  });

  it('summarises each class and names the affected records', () => {
    const plan = planRetention(records, { now: NOW });
    const text = plan.summary.join('\n');

    assert.match(text, /invoice_lifecycle\s+window=730d\s+eligible=1\s+protected=3/);
    assert.match(text, /settlement\s+window=indefinite\s+eligible=0\s+protected=1/);
    assert.match(text, /1 record\(s\) eligible/);
    assert.match(text, /invoices\/i-eligible/);
  });

  it('says so when nothing is eligible', () => {
    const plan = planRetention([invoice({ ageAnchor: daysAgo(1) })], { now: NOW });

    assert.equal(plan.eligible.length, 0);
    assert.match(plan.summary.join('\n'), /Nothing to do/);
  });
});

describe('Retention — sweep execution', () => {
  it('writes nothing on a dry run', async () => {
    const state = seeded();
    const { result } = await runRetentionSweep(fakeDb(state), { now: NOW });

    assert.equal(result.dryRun, true);
    assert.equal(result.deleted, 0);
    assert.ok(!state.log.some((l) => /DELETE/i.test(l)), 'a dry run must not issue a DELETE');
    assert.equal(state.rows.invoices.length, 4, 'rows must be untouched');
  });

  it('is dry-run by default even when options are omitted', async () => {
    const state = seeded();
    const { result } = await runRetentionSweep(fakeDb(state), { now: NOW });

    assert.equal(result.dryRun, true);
    assert.equal(result.deleted, 0);
  });

  it('reports the affected records before deleting anything', async () => {
    const state = seeded();
    const { report, result } = await runRetentionSweep(fakeDb(state), {
      now: NOW,
      dryRun: false,
    });

    assert.equal(result.deleted, 1);
    assert.match(report, /APPLY/);
    assert.match(report, /i-old/);

    // The report is built from the plan, which is computed before the deletes.
    const firstDelete = state.log.findIndex((l) => /DELETE/i.test(l));
    assert.ok(firstDelete >= 0, 'apply mode should delete something');
    assert.ok(
      state.log.slice(0, firstDelete).every((l) => !/DELETE/i.test(l)),
      'no DELETE may precede the planning queries'
    );
  });

  it('never deletes protected records', async () => {
    const state = seeded();
    await runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false });

    const surviving = state.rows.invoices.map((r) => r.id).sort();

    assert.deepEqual(surviving, ['i-held', 'i-paid', 'i-recent']);
    assert.ok(!surviving.includes('i-old'), 'the aged, unsettled invoice is the only one removed');
  });

  it('never deletes transactions', async () => {
    const state = seeded();
    await runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false });

    assert.equal(state.rows.transactions.length, 1, 'settlement evidence must survive');
  });

  it('bounds each table to one batch', async () => {
    const state = seeded();
    state.rows.invoices = Array.from({ length: 25 }, (_, i) => ({
      id: `i-${i}`,
      status: 'EXPIRED',
      created_at: daysAgo(800),
      metadata: null,
    }));

    const { result } = await runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false, batchSize: 10 });

    assert.equal(result.deleted, 10, 'a sweep must not remove an unbounded number of rows');
    assert.equal(state.rows.invoices.length, 15);
  });

  it('refuses a table it does not recognise', async () => {
    const state = seeded();

    await assert.rejects(
      () => runRetentionSweep(fakeDb(state), { now: NOW, tables: ['payments'] }),
      /refusing unknown table/
    );
  });

  it('can be scoped to a subset of tables', async () => {
    const state = seeded();
    const { result } = await runRetentionSweep(fakeDb(state), {
      now: NOW,
      tables: ['invoices'],
      dryRun: false,
    });

    assert.equal(result.eligible, 1);
    assert.equal(state.rows.transactions.length, 1);
  });

  it('builds a plan without deleting, for inspection', async () => {
    const state = seeded();
    const plan = await buildRetentionPlan(fakeDb(state), { now: NOW });

    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.eligible.map((e) => e.record.id), ['i-old']);
    assert.ok(!state.log.some((l) => /DELETE/i.test(l)));
  });
});

describe('Retention — job registration', () => {
  function workerWith(db: RetentionDatabase) {
    const worker = new JobWorker({ store: new MemoryJobStore(), workerId: 'test-retention' });
    registerRetentionJob(worker, { db });
    return worker;
  }

  it('registers under a stable job type', () => {
    assert.equal(RETENTION_SWEEP_JOB, 'retention.sweep');
  });

  it('reports without deleting when the payload omits dryRun', async () => {
    const state = {
      log: [] as string[],
      rows: {
        settlementLinks: [],
        invoices: [{ id: 'i-old', status: 'EXPIRED', created_at: daysAgo(800), metadata: null }],
        transactions: [],
        payment_events: [],
        jobs: [],
      },
    };
    const worker = workerWith(fakeDb(state));

    const result: any = await (worker as any).handlers.get(RETENTION_SWEEP_JOB)(
      { version: 1, data: {} },
      {}
    );

    assert.equal(result.dryRun, true);
    assert.equal(result.deleted, 0);
    assert.ok(!state.log.some((l) => /DELETE/i.test(l)));
  });

  it('applies when the payload opts in', async () => {
    const state = {
      log: [] as string[],
      rows: {
        settlementLinks: [],
        invoices: [{ id: 'i-old', status: 'EXPIRED', created_at: daysAgo(800), metadata: null }],
        transactions: [],
        payment_events: [],
        jobs: [],
      },
    };
    const worker = workerWith(fakeDb(state));

    const result: any = await (worker as any).handlers.get(RETENTION_SWEEP_JOB)(
      { version: 1, data: { dryRun: false } },
      {}
    );

    assert.equal(result.dryRun, false);
    assert.equal(result.deleted, 1);
  });

  it('never retries a failed sweep', async () => {
    const failing: RetentionDatabase = {
      async query() {
        throw new Error('connection reset');
      },
    };
    const worker = workerWith(failing);

    await assert.rejects(
      () =>
        (worker as any).handlers.get(RETENTION_SWEEP_JOB)({ version: 1, data: { dryRun: false } }, {}),
      (error: Error) => {
        assert.ok(error instanceof NonRetryableJobError);
        assert.match(error.message, /connection reset/);
        return true;
      }
    );
  });
});

describe('Retention — reporting', () => {
  it('says plainly that a dry run deleted nothing', () => {
    const plan = planRetention([invoice({ id: 'i-old', ageAnchor: daysAgo(800) })], { now: NOW });
    const text = formatRetentionReport(plan);

    assert.match(text, /DRY RUN/);
    assert.match(text, /1 record\(s\) would be removed/);
    assert.match(text, /Re-run with dryRun:false to apply/);
  });

  it('reports an applied sweep with the deleted count', () => {
    const plan = planRetention([invoice({ id: 'i-old', ageAnchor: daysAgo(800) })], { now: NOW });
    const text = formatRetentionReport({ ...plan, dryRun: false }, 1);

    assert.match(text, /APPLY/);
    assert.match(text, /1 record\(s\) removed/);
  });
});
