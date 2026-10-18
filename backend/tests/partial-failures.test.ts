import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPartialFailureReport,
  jobsToOperations,
  redactSecrets,
} from '../src/domain/partial-failures.ts';
import type { PartialOperation } from '../src/domain/partial-failures.ts';
import type { Job } from '../src/jobs/job-types.ts';
import { DEFAULT_RETRY_POLICY } from '../src/jobs/job-types.ts';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function op(overrides: Partial<PartialOperation> = {}): PartialOperation {
  return {
    id: 'op-1',
    operationType: 'job.notify',
    internalState: 'FAILED',
    invoiceId: 'inv-1',
    startedAt: ago(10 * 60_000),
    attempts: 1,
    retryable: true,
    lastError: 'upstream timeout',
    ...overrides,
  };
}

describe('partial failure report', () => {
  it('lists a fresh retryable failure as an open warning with a retry link', () => {
    const report = buildPartialFailureReport([op()], { now: NOW });
    assert.equal(report.summary.unresolved, 1);
    const [f] = report.unresolved;
    assert.equal(f.severity, 'warning');
    assert.equal(f.stale, false);
    assert.equal(f.ageBucket, 'under_1h');
    assert.equal(f.recoveryAction, 'retry');
    assert.equal(f.links.retry, '/operations/op-1/retry');
    assert.equal(f.links.inspect, '/invoices/inv-1');
    assert.equal(f.links.remediation, 'docs/PARTIAL-FAILURES.md#job');
  });

  it('marks failures older than the stale window as stale errors', () => {
    const report = buildPartialFailureReport([op({ startedAt: ago(30 * HOUR) })], { now: NOW });
    const [f] = report.unresolved;
    assert.equal(f.stale, true);
    assert.equal(f.severity, 'error');
    assert.equal(f.ageBucket, 'over_24h');
    assert.equal(report.summary.byAge.over_24h, 1);
  });

  it('respects a custom stale window', () => {
    const report = buildPartialFailureReport([op({ startedAt: ago(2 * HOUR) })], { now: NOW, staleAfterMs: HOUR });
    assert.equal(report.unresolved[0].stale, true);
  });

  it('gives non retryable failures no retry link', () => {
    const report = buildPartialFailureReport([op({ retryable: false })], { now: NOW });
    assert.equal(report.unresolved[0].links.retry, null);
    assert.equal(report.unresolved[0].recoveryAction, 'inspect');
    assert.equal(report.unresolved[0].severity, 'error');
    assert.equal(report.summary.retryable, 0);
  });

  it('leaves resolved and manually ignored operations out of the unresolved list', () => {
    const report = buildPartialFailureReport(
      [
        op({ id: 'open' }),
        op({ id: 'done', resolvedAt: ago(HOUR) }),
        op({ id: 'skip', ignoredAt: ago(HOUR), ignoredReason: 'customer asked to stop' }),
      ],
      { now: NOW }
    );
    assert.deepEqual(report.unresolved.map((f) => f.id), ['open']);
    assert.equal(report.summary.resolved, 1);
    assert.equal(report.summary.ignored, 1);
  });

  it('marks resolved or ignored operations as requiring no user-visible recovery action', () => {
    const report = buildPartialFailureReport(
      [
        op({ id: 'done', resolvedAt: ago(HOUR) }),
        op({ id: 'skip', ignoredAt: ago(HOUR), ignoredReason: 'manual remediation completed' }),
      ],
      { now: NOW }
    );
    assert.equal(report.summary.resolved, 1);
    assert.equal(report.summary.ignored, 1);
    assert.equal(report.unresolved.length, 0);
  });

  it('ranks payment failures first and groups by operation type', () => {
    const report = buildPartialFailureReport(
      [
        op({ id: 'mail' }),
        op({ id: 'pay', operationType: 'payment.settlement', externalRef: 'a'.repeat(64), invoiceId: 'inv-2' }),
      ],
      { now: NOW }
    );
    assert.deepEqual(report.unresolved.map((f) => f.id), ['pay', 'mail']);
    assert.equal(report.unresolved[0].severity, 'critical');
    assert.equal(report.unresolved[0].externalRef, 'a'.repeat(64));
    assert.deepEqual(report.summary.byOperationType, { 'payment.settlement': 1, 'job.notify': 1 });
  });

  it('never returns secrets in error messages', () => {
    const seed = 'S' + 'A'.repeat(55);
    const report = buildPartialFailureReport(
      [op({ lastError: `auth failed for smtp://mailer:hunter2@smtp.example.com token=abc123 key ${seed}` })],
      { now: NOW }
    );
    const text = report.unresolved[0].lastError!;
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('abc123'));
    assert.ok(!text.includes(seed));
    assert.ok(text.includes('smtp.example.com'));
  });

  it('redacts bearer tokens', () => {
    assert.equal(redactSecrets('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [REDACTED]');
  });
});

describe('jobs as partial operations', () => {
  const base: Job = {
    id: 'j-1',
    type: 'notify',
    payload: { version: 1, data: { invoiceId: 'inv-1' } },
    status: 'queued',
    attempts: 2,
    retryPolicy: DEFAULT_RETRY_POLICY,
    runAt: NOW.toISOString(),
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: null,
    correlationId: 'corr-1',
    errors: [{ attempt: 1, at: ago(HOUR).toISOString(), message: 'timeout', stack: 'Error: timeout\n at x' }],
    result: null,
    createdAt: ago(2 * HOUR).toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
  };

  it('skips clean jobs and maps the rest', () => {
    const ops = jobsToOperations([
      { ...base, id: 'clean', attempts: 0, errors: [] },
      { ...base, id: 'retrying' },
      { ...base, id: 'dead', status: 'dead' },
      { ...base, id: 'recovered', status: 'succeeded', completedAt: NOW.toISOString() },
    ]);
    assert.deepEqual(ops.map((o) => o.id), ['retrying', 'dead', 'recovered']);
    assert.equal(ops[1].retryable, false);
    assert.equal(ops[0].invoiceId, 'inv-1');
    assert.equal(ops[0].externalRef, 'corr-1');

    const report = buildPartialFailureReport(ops, { now: NOW });
    assert.deepEqual(report.unresolved.map((f) => f.id).sort(), ['dead', 'retrying']);
    assert.equal(report.summary.resolved, 1);
    assert.ok(report.unresolved.every((f) => !f.lastError?.includes('at x')));
  });
});
