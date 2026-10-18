import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { DEFAULT_RETRY_POLICY, type Job, type JobStatus } from '../src/jobs/job-types';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { StructuredLogEntry } from '../src/observability/telemetry';
import { OPS_THRESHOLDS, buildOpsHealthReport, maskKey } from '../src/ops/ops-health';
import { createOpsRouter } from '../src/routes/ops.routes';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const SELLER = 'G' + 'A'.repeat(55);
const SECRET = 'S' + 'B'.repeat(55);
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let seq = 0;
function job(status: JobStatus, overrides: Partial<Job> = {}): Job {
  const at = minutes(-1).toISOString();
  return {
    id: `job-${++seq}`,
    type: 'demo',
    payload: { version: 1, data: { customerEmail: 'payer@example.com' } },
    status,
    attempts: status === 'dead' ? 5 : 0,
    retryPolicy: DEFAULT_RETRY_POLICY,
    runAt: at,
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: null,
    correlationId: null,
    errors: [],
    result: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides,
  };
}

function invoice(expiresAt: Date, memo: string) {
  return memoryStorage.createInvoice({
    sellerPublicKey: SELLER,
    amount: 10,
    memo,
    expiresAt,
    customerEmail: 'client@example.com',
  });
}

function log(result: 'success' | 'failure', http_status?: number): StructuredLogEntry {
  return {
    timestamp: NOW.toISOString(),
    level: 'warn',
    operation: 'invoice.verify',
    actor_type: 'payer',
    result,
    latency_ms: 1,
    correlation_id: `corr-${++seq}`,
    http_status,
    error_code: result === 'failure' ? 'UPSTREAM' : undefined,
    metadata: { sellerPublicKey: SELLER, customerEmail: 'client@example.com' },
  };
}

describe('maintainer ops health report (Issue #60)', () => {
  let jobs: MemoryJobStore;
  let logs: StructuredLogEntry[];
  const report = () =>
    buildOpsHealthReport({
      storage: new MemoryInvoiceStorage(),
      jobs,
      recentLogs: () => logs,
      now: () => NOW,
    });

  beforeEach(async () => {
    memoryStorage.clear();
    jobs = new MemoryJobStore();
    logs = [];

    // dead: 2 — one error carries a secret key and an email that must not leak
    await jobs.enqueue(job('dead', {
      errors: [{ attempt: 5, at: NOW.toISOString(), message: `boom ${SECRET} for payer@example.com`, stack: 'Error: at secret.ts:1' }],
    }));
    await jobs.enqueue(job('dead'));
    // stale: running with an expired lease + queued 10 minutes overdue
    await jobs.enqueue(job('running', { lockedUntil: minutes(-1).toISOString(), lockedBy: 'w1' }));
    await jobs.enqueue(job('queued', { runAt: minutes(-10).toISOString() }));
    // healthy: live lease, just-due queued job, succeeded job
    await jobs.enqueue(job('running', { lockedUntil: minutes(5).toISOString(), lockedBy: 'w2' }));
    await jobs.enqueue(job('queued', { runAt: minutes(-1).toISOString() }));
    await jobs.enqueue(job('succeeded'));

    // drift: 2 PENDING well past expiry; one inside the sweep grace; one not expired
    invoice(minutes(-60), 'm1');
    invoice(minutes(-30), 'm2');
    invoice(minutes(-1), 'm3');
    invoice(minutes(60), 'm4');
  });

  it('reports every category and counts that match the underlying records', async () => {
    logs = [log('failure', 500), log('failure', 400), log('success', 200), log('failure'), log('failure', 503)];
    const r = await report();

    assert.equal(r.status, 'attention');
    assert.deepEqual(r.attention, ['deadJobs', 'staleJobs', 'invoiceExpiryDrift', 'serverErrors']);
    assert.equal(r.categories.deadJobs.count, (await jobs.counts()).dead);
    assert.equal(r.categories.deadJobs.count, 2);
    assert.equal(r.categories.staleJobs.count, 2);
    assert.deepEqual(r.categories.staleJobs.samples.map(s => s.status).sort(), ['queued', 'running']);
    assert.equal(r.categories.invoiceExpiryDrift.count, 2);
    assert.equal(r.categories.serverErrors.count, 3); // 500, 503 and a failure with no status
    assert.equal(r.categories.deadJobs.samples[0].link, `/api/jobs/${r.categories.deadJobs.samples[0].id}`);
    assert.match(String(r.categories.invoiceExpiryDrift.samples[0].link), /^\/api\/invoices\//);
    assert.ok(r.categories.serverErrors.samples.every(s => typeof s.correlationId === 'string'));
  });

  it('is read-only: overdue invoices are not transitioned by building the report', async () => {
    await report();
    assert.equal(memoryStorage.findOverduePending(minutes(-OPS_THRESHOLDS.overdueGraceMs / 60_000)).length, 2);
  });

  it('redacts secrets, emails, payloads, stacks and full wallet keys', async () => {
    logs = [log('failure', 500)];
    const body = JSON.stringify(await report());

    for (const leaked of [SECRET, SELLER, 'payer@example.com', 'client@example.com', 'secret.ts', 'customerEmail']) {
      assert.equal(body.includes(leaked), false, `report leaked ${leaked}`);
    }
    assert.ok(body.includes(maskKey(SELLER)));
    assert.ok(body.includes('[REDACTED_SECRET_KEY]'));
  });

  it('is ok with nothing to act on, and works without a job store', async () => {
    memoryStorage.clear();
    const r = await buildOpsHealthReport({ storage: new MemoryInvoiceStorage(), recentLogs: () => [], now: () => NOW });
    assert.equal(r.status, 'ok');
    assert.deepEqual(Object.keys(r.categories), ['invoiceExpiryDrift', 'serverErrors']);
  });

  describe('GET /api/ops/health', () => {
    async function call(adminToken: string | undefined, authorization?: string) {
      const app = express();
      app.use('/api', createOpsRouter({ storage: new MemoryInvoiceStorage(), jobs, adminToken }));
      const server = app.listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/api/ops/health`, {
          headers: authorization ? { authorization } : {},
        });
        return { status: res.status, body: (await res.json()) as any };
      } finally {
        server.close();
      }
    }

    it('is disabled without a token and requires the maintainer bearer token', async () => {
      assert.equal((await call(undefined, 'Bearer x')).status, 403);
      assert.equal((await call('s3cret')).status, 401);
      assert.equal((await call('s3cret', 'Bearer wrong')).status, 401);

      const ok = await call('s3cret', 'Bearer s3cret');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.categories.deadJobs.count, 2);
    });
  });
});
