import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { DEFAULT_RETRY_POLICY, type Job, type JobStatus } from '../src/jobs/job-types';
import { jobsToOperations } from '../src/domain/partial-failures';
import {
  PartialFailureRetryCoordinator,
  buildDashboard,
  classifyCause,
  inspectJobFailure,
  parseDashboardFilter,
} from '../src/ops/partial-failure-dashboard';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

let seq = 0;
function job(status: JobStatus, message: string, overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${++seq}`,
    type: 'notify',
    payload: { version: 1, data: { invoiceId: `inv-${seq}` } },
    status,
    attempts: status === 'dead' ? 5 : 1,
    retryPolicy: DEFAULT_RETRY_POLICY,
    runAt: ago(1),
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: null,
    correlationId: null,
    errors: [{ attempt: 1, at: ago(5), message, stack: 'Error\n at secret/internal.ts' }],
    result: null,
    createdAt: ago(30),
    updatedAt: ago(1),
    completedAt: null,
    ...overrides,
  };
}

describe('cause classification', () => {
  it('flags user-fixable causes', () => {
    assert.deepEqual(classifyCause('550 mailbox unavailable').userActionRequired, true);
    assert.equal(classifyCause('payment underpaid by 2 XLM').code, 'UNDERPAID');
    assert.equal(classifyCause('connect ETIMEDOUT').userActionRequired, false);
    assert.equal(classifyCause('connect ETIMEDOUT').code, 'TIMEOUT');
    assert.equal(classifyCause(null).code, 'UNKNOWN');
  });
});

describe('dashboard filters', () => {
  const jobs = [
    job('dead', 'connect ETIMEDOUT'),
    job('dead', '550 invalid recipient'),
    job('queued', 'upstream 503', { type: 'payment.verify' }),
    job('succeeded', 'old timeout', { completedAt: ago(1) }),
  ];
  const ops = jobsToOperations(jobs);

  it('lists only unresolved failures with a user-action count', () => {
    const v = buildDashboard(ops, {}, NOW);
    assert.equal(v.total, 3);
    assert.equal(v.summary.userActionRequired, 1);
    assert.equal(v.summary.resolved, 1);
  });

  it('filters by user action required and removes the retry link', () => {
    const v = buildDashboard(ops, { userActionRequired: true }, NOW);
    assert.equal(v.items.length, 1);
    assert.equal(v.items[0].cause.code, 'INVALID_RECIPIENT');
    assert.equal(v.items[0].links.retry, null);
    assert.equal(v.items[0].recoveryAction, 'inspect');
  });

  it('filters by operation type prefix and retryability', () => {
    assert.equal(buildDashboard(ops, { operationType: 'job.payment' }, NOW).total, 1);
    assert.equal(buildDashboard(ops, { retryable: true }, NOW).total, 1);
  });

  it('rejects unknown filter values', () => {
    assert.ok(parseDashboardFilter({ severity: 'meh' }).error);
    assert.ok(parseDashboardFilter({ stale: 'yes' }).error);
    assert.deepEqual(parseDashboardFilter({ stale: 'true', limit: '9999' }).filter, { stale: true, limit: 500 });
  });

  it('inspect returns redacted history without stacks', () => {
    const j = job('dead', 'auth failed token=abc123');
    const d = inspectJobFailure(j, NOW);
    assert.equal(d.state, 'open');
    assert.ok(!JSON.stringify(d).includes('abc123'));
    assert.ok(!JSON.stringify(d).includes('internal.ts'));
  });
});

describe('safe retry', () => {
  async function storeWith(...jobs: Job[]) {
    const store = new MemoryJobStore();
    for (const j of jobs) await store.enqueue(j);
    return store;
  }

  it('requeues a dead job once and dedupes by idempotency key', async () => {
    const j = job('dead', 'connect ETIMEDOUT');
    const store = await storeWith(j);
    const c = new PartialFailureRetryCoordinator(store);
    const first = await c.retry(j.id, 'key-1', NOW);
    assert.equal(first.status, 'requeued');
    const second = await c.retry(j.id, 'key-1', NOW);
    assert.equal(second.status, 'duplicate');
    const third = await c.retry(j.id, 'key-2', NOW);
    assert.equal(third.status, 'rejected');
  });

  it('refuses user-action failures, unknown jobs and auto-retrying jobs', async () => {
    const user = job('dead', '550 invalid recipient');
    const queued = job('queued', 'timeout');
    const c = new PartialFailureRetryCoordinator(await storeWith(user, queued));
    assert.deepEqual((await c.retry(user.id, undefined, NOW)) as any, { status: 'rejected', code: 'USER_ACTION_REQUIRED', message: 'Update the customer email address on the invoice.' });
    assert.equal(((await c.retry('nope', undefined, NOW)) as any).code, 'NOT_FOUND');
    assert.equal(((await c.retry(queued.id, undefined, NOW)) as any).code, 'NOT_RETRYABLE_STATE');
  });

  it('concurrent retries requeue at most once', async () => {
    const j = job('dead', 'timeout');
    const c = new PartialFailureRetryCoordinator(await storeWith(j));
    const results = await Promise.all([c.retry(j.id, undefined, NOW), c.retry(j.id, undefined, NOW)]);
    assert.equal(results.filter((r) => r.status === 'requeued').length, 1);
  });
});
