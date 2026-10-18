/**
 * Disaster-recovery validation tests (#62).
 *
 * The invariants are exercised against a fixture database that models the real
 * schema plus injected corruption, so each failure family — missing, orphaned,
 * duplicated, inconsistent — is proven to be detected without needing Postgres.
 * A healthy database must come back clean, and the command must never write.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_IDS_FOR_TEST,
  REQUIRED_TABLES,
  formatValidationReport,
  runRestoreValidation,
  type ValidationDatabase,
} from '../src/db/restore-validation';

/** Rows keyed by check id, so each test injects exactly one failure family. */
type Fixture = Record<string, any[]>;

function fakeDb(
  violating: Fixture = {},
  options: { tables?: string[]; countThrows?: string[] } = {}
): ValidationDatabase {
  const present = new Set(options.tables ?? [...REQUIRED_TABLES]);

  return {
    async query(text: string, params: unknown[] = []) {
      if (text.includes('pg_class')) {
        // The real query binds the wanted names; match the fake to that shape.
        const wanted = (params[0] as string[] | undefined) ?? [...present];
        return { rows: wanted.filter((t) => present.has(t)).map((name) => ({ name })) };
      }

      // Counted probe: `SELECT COUNT(*)::int AS count FROM (...) AS violations`
      const countMatch = /FROM \(\s*([\s\S]*?)\s*\)\s*AS violations/.exec(text);
      if (countMatch) {
        const id = identify(countMatch[1]);
        if (options.countThrows?.includes(id)) {
          throw new Error(`simulated permission denied for ${id}`);
        }
        return { rows: [{ count: (violating[id] ?? []).length }] };
      }

      // GROUP BY probes return one row per violation, so they are counted as-is.
      const id = identify(text);
      return { rows: violating[id] ?? [] };
    },
  };
}

/** Maps a statement back to the check it belongs to by its distinctive shape. */
function identify(sql: string): string {
  if (/GROUP\s+BY\s+memo/i.test(sql)) return 'invoices.duplicate-memo';
  if (/GROUP\s+BY\s+tx_hash/i.test(sql)) return 'transactions.duplicate-tx-hash';
  // The detached-invoice check also LEFT JOINs invoices, so it must be tested
  // before the orphaned-invoice rule or it is mislabelled.
  if (/WHERE t\.invoice_id IS NULL/i.test(sql)) return 'transactions.detached-from-invoice';
  if (/FROM transactions t\s+LEFT JOIN invoices i ON i\.id = t\.invoice_id/i.test(sql)) {
    return 'transactions.orphaned-invoice';
  }
  if (/FROM payment_events e/i.test(sql)) return 'payment-events.orphaned-invoice';
  if (/WHERE i\.status = 'PAID'\s+AND NOT EXISTS/i.test(sql)) return 'invoices.missing-transaction';
  if (/status = 'PAID' AND paid_at IS NULL/i.test(sql)) return 'invoices.paid-without-timestamp';
  if (/status <> 'PAID' AND paid_at IS NOT NULL/i.test(sql)) return 'invoices.unpaid-with-timestamp';
  if (/status = 'PAID' AND payment_tx_hash IS NULL/i.test(sql)) return 'invoices.paid-without-tx-hash';
  if (/status NOT IN/i.test(sql)) return 'invoices.unknown-status';
  if (/t\.amount IS DISTINCT FROM i\.amount/i.test(sql)) return 'invoices.amount-disagrees-with-settlement';
  if (/expires_at <= created_at/i.test(sql)) return 'invoices.expiry-not-after-creation';
  if (/version IS NULL OR version < 1/i.test(sql)) return 'invoices.version-invalid';
  if (/status = 'PAID' AND expires_at IS NOT NULL AND paid_at > expires_at/i.test(sql)) {
    return 'invoices.paid-but-overdue';
  }
  if (/FROM jobs\s+WHERE status = 'running'/i.test(sql)) return 'jobs.stale-running-lease';
  if (/status IN \('succeeded', 'dead'\) AND completed_at IS NULL/i.test(sql)) {
    return 'jobs.terminal-without-completion';
  }
  if (/status IN \('queued', 'running'\) AND completed_at IS NOT NULL/i.test(sql)) {
    return 'jobs.non-terminal-with-completion';
  }
  return 'unknown';
}

const CORRUPTION: Fixture = {
  'transactions.orphaned-invoice': [{ id: 't1', invoice_id: 'gone', tx_hash: 'a'.repeat(64) }],
  'payment-events.orphaned-invoice': [{ id: 'e1', invoice_id: 'gone', event_type: 'payment_detected' }],
  'invoices.missing-transaction': [{ id: 'i1', status: 'PAID', payment_tx_hash: 'b'.repeat(64), paid_at: 'x' }],
  'transactions.detached-from-invoice': [{ id: 't2', tx_hash: 'c'.repeat(64), invoice_id: null, memo: 'INV-1' }],
  'invoices.duplicate-memo': [{ memo: 'INV-1', copies: '2', first_id: 'i1', last_id: 'i2' }],
  'transactions.duplicate-tx-hash': [{ tx_hash: 'd'.repeat(64), copies: '2' }],
  'invoices.paid-without-timestamp': [{ id: 'i3', status: 'PAID', payment_tx_hash: 'e'.repeat(64) }],
  'invoices.unpaid-with-timestamp': [{ id: 'i4', status: 'PENDING', paid_at: '2026-01-01T00:00:00Z' }],
  'invoices.paid-without-tx-hash': [{ id: 'i5', status: 'PAID', paid_at: '2026-01-01T00:00:00Z' }],
  'invoices.unknown-status': [{ id: 'i6', status: 'REFUNDED' }],
  'invoices.amount-disagrees-with-settlement': [
    { invoice_id: 'i7', invoice_amount: '10.0000000', transaction_id: 't3', transaction_amount: '9.0000000' },
  ],
  'invoices.expiry-not-after-creation': [
    { id: 'i8', created_at: '2026-01-02T00:00:00Z', expires_at: '2026-01-01T00:00:00Z' },
  ],
  'invoices.version-invalid': [{ id: 'i9', version: 0 }],
  'invoices.paid-but-overdue': [
    { id: 'i10', paid_at: '2026-02-01T00:00:00Z', expires_at: '2026-01-01T00:00:00Z' },
  ],
  'jobs.stale-running-lease': [{ id: 'j1', type: 'invoices.expire-pending', locked_until: '2020-01-01T00:00:00Z', locked_by: 'w1' }],
  'jobs.terminal-without-completion': [{ id: 'j2', type: 'invoices.expire-pending', status: 'succeeded', updated_at: 'x' }],
  'jobs.non-terminal-with-completion': [
    { id: 'j3', type: 'invoices.expire-pending', status: 'queued', completed_at: '2026-01-01T00:00:00Z' },
  ],
};

describe('Restore validation — healthy database', () => {
  it('passes every invariant when nothing is corrupt', async () => {
    const report = await runRestoreValidation(fakeDb());

    assert.equal(report.ok, true);
    assert.equal(report.totalViolations, 0);
    const failed = report.results.filter((r) => r.status === 'FAIL');
    assert.deepEqual(failed, [], `unexpected failures: ${failed.map((f) => f.id).join(', ')}`);
  });

  it('covers all four failure families the issue requires', async () => {
    const report = await runRestoreValidation(fakeDb());
    const kinds = new Set(report.results.map((r) => r.kind));

    for (const kind of ['missing', 'orphaned', 'duplicated', 'inconsistent']) {
      assert.ok(kinds.has(kind as any), `no invariant covers "${kind}"`);
    }
  });

  it('checks every required table', async () => {
    const report = await runRestoreValidation(fakeDb());

    assert.deepEqual(report.tablesMissing, []);
    assert.deepEqual(report.tablesChecked, [...REQUIRED_TABLES]);
  });

  it('reports a partial restore instead of crashing', async () => {
    const report = await runRestoreValidation(fakeDb({}, { tables: ['invoices'] }));

    assert.ok(report.tablesMissing.includes('transactions'));
    assert.ok(report.tablesMissing.includes('jobs'));
  });

  it('skips checks whose table is absent when allowed', async () => {
    const report = await runRestoreValidation(fakeDb({}, { tables: ['invoices'] }), {
      allowMissingTables: true,
    });

    const skipped = report.results.filter((r) => r.status === 'SKIPPED');
    assert.ok(skipped.length > 0, 'checks against absent tables should be skipped, not failed');
    assert.ok(skipped.some((r) => r.id.startsWith('jobs.')));
  });
});

describe('Restore validation — detects corruption', () => {
  for (const [id, rows] of Object.entries(CORRUPTION)) {
    it(`detects ${id}`, async () => {
      const report = await runRestoreValidation(fakeDb({ [id]: rows }));
      const result = report.results.find((r) => r.id === id);

      assert.ok(result, `invariant ${id} did not run`);
      assert.equal(result.status, 'FAIL', `${id} should have failed`);
      assert.equal(result.count, rows.length);
      assert.ok(result.remediation.length > 0, `${id} must carry remediation guidance`);
      assert.equal(report.ok, false);
    });
  }

  it('aggregates violations by kind', async () => {
    const report = await runRestoreValidation(
      fakeDb({
        'invoices.duplicate-memo': CORRUPTION['invoices.duplicate-memo'],
        'transactions.duplicate-tx-hash': CORRUPTION['transactions.duplicate-tx-hash'],
        'transactions.orphaned-invoice': CORRUPTION['transactions.orphaned-invoice'],
        'invoices.unknown-status': CORRUPTION['invoices.unknown-status'],
      })
    );

    assert.equal(report.counts.duplicated, 2);
    assert.equal(report.counts.orphaned, 1);
    assert.equal(report.counts.inconsistent, 1);
    assert.equal(report.counts.missing, 0);
    assert.equal(report.totalViolations, 4);
  });

  it('treats an unevaluatable check as a failure, not a pass', async () => {
    // An unknown state after a restore is not a healthy one: reporting PASS
    // because the probe errored would hide the exact problem being looked for.
    const report = await runRestoreValidation(fakeDb({}, { countThrows: ['invoices.unknown-status'] }));
    const result = report.results.find((r) => r.id === 'invoices.unknown-status');

    assert.equal(result?.status, 'FAIL');
    assert.match(String(result?.error), /permission denied/);
    assert.equal(report.ok, false);
  });
});

describe('Restore validation — read-only guarantee', () => {
  it('issues only SELECT statements', async () => {
    const seen: string[] = [];
    const db: ValidationDatabase = {
      async query(text: string) {
        seen.push(text);
        return { rows: [] };
      },
    };

    await runRestoreValidation(db);

    assert.ok(seen.length > 0);
    for (const sql of seen) {
      assert.match(
        sql.trim(),
        /^(SELECT|WITH)\b/i,
        `non-SELECT statement issued by restore validation: ${sql.trim().slice(0, 80)}`
      );
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/i);
    }
  });

  it('rejects a mutating statement before it runs', async () => {
    const { assertReadOnlyForTest } = await import('../src/db/restore-validation');
    assert.throws(() => assertReadOnlyForTest('DELETE FROM invoices'), /not read-only/);
    assert.throws(() => assertReadOnlyForTest('UPDATE invoices SET status = 1'), /not read-only/);
    assert.doesNotThrow(() => assertReadOnlyForTest('SELECT 1'));
  });

  it('exports the invariants it enforces', () => {
    assert.ok(CHECK_IDS_FOR_TEST.length >= 10, 'expected a broad set of invariants');
    assert.equal(new Set(CHECK_IDS_FOR_TEST).size, CHECK_IDS_FOR_TEST.length, 'ids must be unique');
  });
});

describe('Restore validation — report formatting', () => {
  it('renders a healthy report', async () => {
    const output = formatValidationReport(await runRestoreValidation(fakeDb()));

    assert.match(output, /Restore invariants hold\./);
    assert.match(output, /total=0/);
  });

  it('renders violations with remediation and a non-zero summary', async () => {
    const report = await runRestoreValidation(fakeDb(CORRUPTION));
    const output = formatValidationReport(report);

    assert.match(output, /VIOLATED/);
    assert.match(output, /remediation:/);
    assert.match(output, /invoices\.duplicate-memo/);
    assert.match(output, new RegExp(`total=${report.totalViolations}`));
  });

  it('groups checks under their failure family', () => {
    const output = formatValidationReport({
      timestamp: '2026-01-01T00:00:00.000Z',
      ok: true,
      counts: { missing: 0, orphaned: 0, duplicated: 0, inconsistent: 0 },
      totalViolations: 0,
      tablesChecked: [...REQUIRED_TABLES],
      tablesMissing: [],
      results: [
        {
          id: 'x.y',
          kind: 'duplicated',
          status: 'PASS',
          count: 0,
          sample: [],
          message: 'fine',
          remediation: 'n/a',
        },
      ],
    });

    assert.match(output, /-- duplicated --/);
  });
});
