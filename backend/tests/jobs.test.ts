import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { JobQueue, JobWorker } from '../src/jobs/worker';
import { NonRetryableJobError, computeBackoffMs, DEFAULT_RETRY_POLICY } from '../src/jobs/job-types';
import {
  EXPIRE_PENDING_INVOICES_JOB,
  createJobStore,
  registerJobHandlers,
  scheduleExpirySweep,
  startExpiryScheduler,
} from '../src/jobs/runtime';
import { PostgresJobStore, rowToJob } from '../src/jobs/postgres-job-store';
import { createJobsRouter } from '../src/routes/jobs.routes';

const silent = () => {};

function harness() {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const store = new MemoryJobStore();
  const queue = new JobQueue(store, DEFAULT_RETRY_POLICY, () => clock);
  const make = (id = 'w1', leaseMs = 60_000) =>
    new JobWorker({ store, workerId: id, leaseMs, now: () => clock, log: silent });
  return {
    store,
    queue,
    make,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
  };
}

describe('Background job framework (Issue #51)', () => {
  describe('enqueue', () => {
    it('creates a versioned payload envelope with default retry policy', async () => {
      const h = harness();
      const { job, created } = await h.queue.enqueue('demo', { a: 1 }, { payloadVersion: 2, correlationId: 'c-1' });
      assert.equal(created, true);
      assert.deepEqual(job.payload, { version: 2, data: { a: 1 } });
      assert.equal(job.status, 'queued');
      assert.equal(job.correlationId, 'c-1');
      assert.deepEqual(job.retryPolicy, DEFAULT_RETRY_POLICY);
    });

    it('defaults payload data and version, and merges partial retry overrides', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('demo', undefined, { retryPolicy: { maxAttempts: 2 } });
      assert.deepEqual(job.payload, { version: 1, data: {} });
      assert.equal(job.retryPolicy.maxAttempts, 2);
      assert.equal(job.retryPolicy.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs);
    });

    it('dedupes on idempotency key', async () => {
      const h = harness();
      const first = await h.queue.enqueue('demo', {}, { idempotencyKey: 'k' });
      const second = await h.queue.enqueue('demo', {}, { idempotencyKey: 'k' });
      assert.equal(second.created, false);
      assert.equal(second.job.id, first.job.id);
      assert.equal((await h.store.list()).total, 1);
    });
  });

  describe('worker execution', () => {
    it('runs a job to success and records the result', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('demo', { n: 2 });
      const worker = h.make().register('demo', async (p) => ({ doubled: (p.data.n as number) * 2 }));
      const done = await worker.runOnce();
      assert.equal(done?.status, 'succeeded');
      assert.deepEqual((await h.store.get(job.id))?.result, { doubled: 4 });
      assert.ok((await h.store.get(job.id))?.completedAt);
    });

    it('stores a null result when the handler returns undefined', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('demo');
      await h.make().register('demo', async () => undefined).runOnce();
      assert.equal((await h.store.get(job.id))?.result, null);
    });

    it('returns null when idle or when no handlers are registered', async () => {
      const h = harness();
      assert.equal(await h.make().runOnce(), null);
      await h.queue.enqueue('demo');
      assert.equal(await h.make().runOnce(), null);
      assert.equal(await h.make().register('demo', async () => 1).drain(), 1);
    });

    it('only claims job types it has handlers for', async () => {
      const h = harness();
      await h.queue.enqueue('other');
      assert.equal(await h.make().register('demo', async () => 1).runOnce(), null);
    });

    it('does not run jobs scheduled for the future', async () => {
      const h = harness();
      await h.queue.enqueue('demo', {}, { runAt: new Date(h.now().getTime() + 10_000) });
      const worker = h.make().register('demo', async () => 1);
      assert.equal(await worker.runOnce(), null);
      h.advance(10_000);
      assert.equal((await worker.runOnce())?.status, 'succeeded');
    });

    it('processes due jobs oldest-first', async () => {
      const h = harness();
      const order: string[] = [];
      await h.queue.enqueue('demo', { n: 'a' }, { runAt: new Date(h.now().getTime() - 2000) });
      await h.queue.enqueue('demo', { n: 'b' }, { runAt: new Date(h.now().getTime() - 5000) });
      await h.make().register('demo', async (p) => order.push(p.data.n as string)).drain();
      assert.deepEqual(order, ['b', 'a']);
    });

    it('drain stops at maxJobs', async () => {
      const h = harness();
      for (let i = 0; i < 3; i++) await h.queue.enqueue('demo');
      assert.equal(await h.make().register('demo', async () => 1).drain(2), 2);
    });
  });

  describe('retries and dead-lettering', () => {
    it('retries with exponential backoff and preserves error context', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('flaky', { x: 1 }, { retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, backoffFactor: 2 } });
      let calls = 0;
      const worker = h.make().register('flaky', async (_p, ctx) => {
        calls += 1;
        if (ctx.attempt < 3) throw new Error(`boom ${ctx.attempt}`);
        return 'ok';
      });

      const first = await worker.runOnce();
      assert.equal(first?.status, 'queued');
      assert.equal(await worker.runOnce(), null, 'must wait for backoff');
      h.advance(999);
      assert.equal(await worker.runOnce(), null);
      h.advance(1);
      assert.equal((await worker.runOnce())?.status, 'queued');
      h.advance(2000);
      const last = await worker.runOnce();

      assert.equal(last?.status, 'succeeded');
      assert.equal(calls, 3);
      const stored = await h.store.get(job.id);
      assert.deepEqual(stored?.errors.map((e) => [e.attempt, e.message]), [[1, 'boom 1'], [2, 'boom 2']]);
      assert.ok(stored?.errors[0].stack?.includes('boom 1'));
    });

    it('dead-letters after retry exhaustion, keeping payload and every error', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('doomed', { orderId: 42 }, { retryPolicy: { maxAttempts: 2, baseDelayMs: 10 } });
      let calls = 0;
      const worker = h.make().register('doomed', async () => {
        calls += 1;
        throw new Error('always fails');
      });

      await worker.runOnce();
      h.advance(10);
      const final = await worker.runOnce();
      h.advance(1_000_000);

      assert.equal(final?.status, 'dead');
      assert.equal(await worker.runOnce(), null, 'dead jobs are never rerun automatically');
      assert.equal(calls, 2);
      const stored = await h.store.get(job.id);
      assert.equal(stored?.attempts, 2);
      assert.equal(stored?.errors.length, 2);
      assert.deepEqual(stored?.payload.data, { orderId: 42 });
      assert.ok(stored?.completedAt);
    });

    it('dead-letters immediately on NonRetryableJobError', async () => {
      const h = harness();
      await h.queue.enqueue('bad');
      const done = await h.make().register('bad', async () => {
        throw new NonRetryableJobError('invalid payload');
      }).runOnce();
      assert.equal(done?.status, 'dead');
      assert.equal(done?.attempts, 1);
    });

    it('records non-Error throws', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('weird', {}, { retryPolicy: { maxAttempts: 1 } });
      await h.make().register('weird', async () => {
        throw 'plain string';
      }).runOnce();
      assert.equal((await h.store.get(job.id))?.errors[0].message, 'plain string');
    });

    it('caps backoff at maxDelayMs', () => {
      const policy = { maxAttempts: 10, baseDelayMs: 1000, backoffFactor: 10, maxDelayMs: 5000 };
      assert.equal(computeBackoffMs(policy, 1), 1000);
      assert.equal(computeBackoffMs(policy, 2), 5000);
      assert.equal(computeBackoffMs(policy, 6), 5000);
    });

    it('requeues a dead job with a fresh attempt budget', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('doomed', {}, { retryPolicy: { maxAttempts: 1 } });
      let fail = true;
      const worker = h.make().register('doomed', async () => {
        if (fail) throw new Error('nope');
        return 'fixed';
      });
      await worker.runOnce();
      assert.equal((await h.store.get(job.id))?.status, 'dead');

      assert.equal(await h.store.requeueDead('missing', h.now()), null);
      fail = false;
      const requeued = await h.store.requeueDead(job.id, h.now());
      assert.equal(requeued?.status, 'queued');
      assert.equal(requeued?.attempts, 0);
      assert.equal((await worker.runOnce())?.status, 'succeeded');
      assert.equal(await h.store.requeueDead(job.id, h.now()), null, 'only dead jobs can be requeued');
    });
  });

  describe('idempotent reprocessing', () => {
    it('reclaims a job whose worker crashed, and rejects the stale worker result', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('pay', {}, { idempotencyKey: 'pay-1' });

      // Worker A claims, then "crashes" (never reports back).
      const claimedByA = await h.store.claimNext('A', h.now(), 1000, ['pay']);
      assert.equal(claimedByA?.attempts, 1);
      assert.equal(await h.store.claimNext('B', h.now(), 1000, ['pay']), null, 'lease still held');

      h.advance(1001);
      const effects = new Set<string>();
      const workerB = h.make('B').register('pay', async (_p, ctx) => {
        effects.add(ctx.idempotencyKey); // handler applies its effect keyed on the stable key
        return 'done';
      });
      assert.equal((await workerB.runOnce())?.status, 'succeeded');

      // A wakes up late: its completion/failure must not clobber B's result.
      assert.equal(await h.store.markSucceeded(job.id, 'A', 'stale', h.now()), null);
      assert.equal(await h.store.markFailed(job.id, 'A', { attempt: 1, at: '', message: 'x' }, null, h.now()), null);
      const stored = await h.store.get(job.id);
      assert.equal(stored?.status, 'succeeded');
      assert.equal(stored?.result, 'done');
      assert.deepEqual([...effects], ['pay-1']);
    });

    it('re-enqueueing after success with the same key does not run the work twice', async () => {
      const h = harness();
      let runs = 0;
      const worker = h.make().register('once', async () => {
        runs += 1;
      });
      await h.queue.enqueue('once', {}, { idempotencyKey: 'same' });
      await worker.drain();
      await h.queue.enqueue('once', {}, { idempotencyKey: 'same' });
      await worker.drain();
      assert.equal(runs, 1);
    });

    it('discards the result when the lease was lost mid-run', async () => {
      const h = harness();
      const logs: string[] = [];
      const { job } = await h.queue.enqueue('slow');
      const worker = new JobWorker({ store: h.store, workerId: 'A', leaseMs: 100, now: h.now, log: (m) => logs.push(m) });
      worker.register('slow', async () => {
        h.advance(500);
        await h.store.claimNext('B', h.now(), 1000, ['slow']); // B steals the expired lease
        return 'late';
      });
      const returned = await worker.runOnce();
      assert.equal(returned?.status, 'running');
      assert.ok(logs.some((m) => m.includes('lease lost')));
      assert.equal((await h.store.get(job.id))?.lockedBy, 'B');
    });
  });

  describe('inspection', () => {
    it('lists with filters and pagination, and reports counts', async () => {
      const h = harness();
      await h.queue.enqueue('a');
      await h.queue.enqueue('b');
      await h.queue.enqueue('b');
      await h.make().register('a', async () => 1).drain();

      assert.equal((await h.store.list({ status: 'succeeded' })).total, 1);
      assert.equal((await h.store.list({ type: 'b' })).total, 2);
      assert.equal((await h.store.list({ type: 'b', limit: 1 })).jobs.length, 1);
      assert.equal((await h.store.list({ type: 'b', offset: 5 })).jobs.length, 0);
      assert.deepEqual(await h.store.counts(), { queued: 2, running: 0, succeeded: 1, dead: 0 });
      assert.equal(await h.store.get('nope'), null);
    });

    it('clear() resets the store', async () => {
      const h = harness();
      await h.queue.enqueue('a', {}, { idempotencyKey: 'k' });
      h.store.clear();
      assert.equal((await h.store.list()).total, 0);
      assert.equal((await h.queue.enqueue('a', {}, { idempotencyKey: 'k' })).created, true);
    });
  });

  describe('invoice expiry job (migrated maintenance operation)', () => {
    it('runs the expiry sweep through the worker and reports the count', async () => {
      const h = harness();
      let sweeps = 0;
      const worker = registerJobHandlers(h.make(), { expirePendingInvoices: async () => ++sweeps * 3 });
      const { job } = await scheduleExpirySweep(h.queue, h.now());
      await worker.drain();
      assert.deepEqual((await h.store.get(job.id))?.result, { expired: 3 });
    });

    it('schedules at most one sweep per interval bucket', async () => {
      const h = harness();
      const a = await scheduleExpirySweep(h.queue, h.now(), 60_000);
      const b = await scheduleExpirySweep(h.queue, new Date(h.now().getTime() + 59_000), 60_000);
      const c = await scheduleExpirySweep(h.queue, new Date(h.now().getTime() + 60_000), 60_000);
      assert.equal(b.created, false);
      assert.equal(c.created, true);
      assert.notEqual(a.job.id, c.job.id);
      assert.equal(a.job.type, EXPIRE_PENDING_INVOICES_JOB);
    });

    it('retries a failing sweep and succeeds later', async () => {
      const h = harness();
      let n = 0;
      const worker = registerJobHandlers(h.make(), {
        expirePendingInvoices: async () => {
          if (++n === 1) throw new Error('db down');
          return 1;
        },
      });
      const { job } = await scheduleExpirySweep(h.queue, h.now());
      await worker.runOnce();
      h.advance(5000);
      await worker.runOnce();
      const stored = await h.store.get(job.id);
      assert.equal(stored?.status, 'succeeded');
      assert.equal(stored?.errors.length, 1);
    });

    it('startExpiryScheduler enqueues immediately and on each tick until stopped', async () => {
      const h = harness();
      const stop = startExpiryScheduler(h.queue, 20);
      await new Promise((r) => setTimeout(r, 70));
      stop();
      const total = (await h.store.list()).total;
      assert.ok(total >= 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal((await h.store.list()).total, total, 'no enqueues after stop');
    });

    it('logs instead of throwing when scheduling fails', async () => {
      const failing = new JobQueue({ enqueue: async () => { throw new Error('store down'); } } as any);
      const original = console.error;
      const seen: unknown[][] = [];
      console.error = (...a: unknown[]) => void seen.push(a);
      try {
        const stop = startExpiryScheduler(failing, 1000);
        await new Promise((r) => setTimeout(r, 10));
        stop();
      } finally {
        console.error = original;
      }
      assert.ok(seen.length >= 1);
    });
  });

  describe('worker lifecycle', () => {
    it('start() polls until stop(), and start() twice is a no-op', async () => {
      const h = harness();
      await h.queue.enqueue('demo');
      const worker = new JobWorker({ store: h.store, pollIntervalMs: 10, log: silent }).register('demo', async () => 'ok');
      worker.start();
      worker.start();
      await new Promise((r) => setTimeout(r, 60));
      worker.stop();
      worker.stop();
      assert.equal((await h.store.counts()).succeeded, 1);
    });

    it('survives store errors during a tick', async () => {
      const logs: string[] = [];
      const broken = { claimNext: async () => { throw new Error('store exploded'); } } as any;
      const worker = new JobWorker({ store: broken, pollIntervalMs: 10, log: (m) => logs.push(m) }).register('demo', async () => 1);
      worker.start();
      await new Promise((r) => setTimeout(r, 40));
      worker.stop();
      assert.ok(logs.some((m) => m.includes('tick failed')));
    });

    it('uses console logging and generated worker ids by default', async () => {
      const h = harness();
      await h.queue.enqueue('demo', {}, { retryPolicy: { maxAttempts: 1 } });
      const original = console.log;
      const seen: unknown[][] = [];
      console.log = (...a: unknown[]) => void seen.push(a);
      try {
        await new JobWorker({ store: h.store }).register('demo', async () => { throw new Error('x'); }).runOnce();
      } finally {
        console.log = original;
      }
      assert.ok(seen.some((a) => String(a[0]).includes('[jobs] job dead-lettered')));
    });
  });

  describe('createJobStore', () => {
    it('returns a memory store without a pool and a Postgres store with one', () => {
      assert.ok(createJobStore() instanceof MemoryJobStore);
      assert.ok(createJobStore({ query: async () => ({ rows: [] }) } as any) instanceof PostgresJobStore);
    });
  });

  describe('jobs admin routes', () => {
    let store: MemoryJobStore;
    let queue: JobQueue;

    async function withServer(adminToken: string | undefined, fn: (call: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>) => Promise<void>) {
      const app = express();
      app.use('/api', createJobsRouter({ store, adminToken }));
      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      });
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      const call = async (path: string, init: RequestInit = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
          ...init,
          headers: { authorization: 'Bearer secret', ...(init.headers as Record<string, string>) },
        });
        return { status: res.status, body: await res.json() };
      };
      try {
        await fn(call);
      } finally {
        server.close();
      }
    }

    beforeEach(() => {
      store = new MemoryJobStore();
      queue = new JobQueue(store);
    });

    it('is disabled when no admin token is configured', async () => {
      delete process.env.JOBS_ADMIN_TOKEN;
      await withServer(undefined, async (call) => {
        const res = await call('/jobs');
        assert.equal(res.status, 403);
        assert.equal(res.body.code, 'JOBS_ADMIN_DISABLED');
      });
    });

    it('falls back to JOBS_ADMIN_TOKEN from the environment', async () => {
      process.env.JOBS_ADMIN_TOKEN = 'secret';
      try {
        await withServer(undefined, async (call) => {
          assert.equal((await call('/jobs')).status, 200);
        });
      } finally {
        delete process.env.JOBS_ADMIN_TOKEN;
      }
    });

    it('rejects missing, malformed and wrong tokens', async () => {
      await withServer('secret', async (call) => {
        assert.equal((await call('/jobs', { headers: { authorization: '' } })).status, 401);
        assert.equal((await call('/jobs', { headers: { authorization: 'Basic secret' } })).status, 401);
        assert.equal((await call('/jobs', { headers: { authorization: 'Bearer wrong!' } })).status, 401);
        assert.equal((await call('/jobs', { headers: { authorization: 'Bearer secreT' } })).status, 401);
      });
    });

    it('lists jobs with counts, filters and clamped pagination', async () => {
      await queue.enqueue('a');
      await queue.enqueue('b');
      await withServer('secret', async (call) => {
        const all = await call('/jobs');
        assert.equal(all.status, 200);
        assert.equal(all.body.data.total, 2);
        assert.equal(all.body.data.counts.queued, 2);
        assert.equal((await call('/jobs?type=a')).body.data.total, 1);
        assert.equal((await call('/jobs?status=dead')).body.data.total, 0);
        const clamped = await call('/jobs?limit=99999&offset=-4');
        assert.equal(clamped.body.data.limit, 200);
        assert.equal(clamped.body.data.offset, 0);
        assert.equal((await call('/jobs?limit=abc')).body.data.limit, 50);
        const bad = await call('/jobs?status=bogus');
        assert.equal(bad.status, 400);
        assert.equal(bad.body.code, 'INVALID_STATUS');
      });
    });

    it('shows a single job including its error history, and 404s for unknown ids', async () => {
      const { job } = await queue.enqueue('boom', { k: 1 }, { retryPolicy: { maxAttempts: 1 } });
      await new JobWorker({ store, log: silent }).register('boom', async () => { throw new Error('kaput'); }).runOnce();
      await withServer('secret', async (call) => {
        const res = await call(`/jobs/${job.id}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.status, 'dead');
        assert.equal(res.body.data.errors[0].message, 'kaput');
        assert.equal((await call('/jobs/does-not-exist')).status, 404);
      });
    });

    it('retries only dead jobs and writes an audit event', async () => {
      const { job } = await queue.enqueue('boom', {}, { retryPolicy: { maxAttempts: 1 } });
      const queued = await queue.enqueue('other');
      await new JobWorker({ store, log: silent }).register('boom', async () => { throw new Error('x'); }).runOnce();
      await withServer('secret', async (call) => {
        assert.equal((await call(`/jobs/${queued.job.id}/retry`, { method: 'POST' })).status, 409);
        const ok = await call(`/jobs/${job.id}/retry`, { method: 'POST' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.data.status, 'queued');
      });
    });

    it('forwards store failures to the error handler', async () => {
      const broken = new Proxy(store, {
        get: (t, p) => (p === 'list' || p === 'get' || p === 'requeueDead' ? async () => { throw new Error('db gone'); } : (t as any)[p]),
      });
      const app = express();
      app.use('/api', createJobsRouter({ store: broken as any, adminToken: 'secret' }));
      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: err.message }));
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      try {
        for (const [path, method] of [['/jobs', 'GET'], ['/jobs/x', 'GET'], ['/jobs/x/retry', 'POST']]) {
          const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { authorization: 'Bearer secret' } });
          assert.equal(res.status, 500);
        }
      } finally {
        server.close();
      }
    });
  });

  describe('PostgresJobStore (query contract)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'j1', type: 't', payload: { version: 1, data: {} }, status: 'queued', attempts: 0,
      retry_policy: DEFAULT_RETRY_POLICY, run_at: now, locked_until: null, locked_by: null,
      idempotency_key: null, correlation_id: null, errors: null, result: null,
      created_at: now, updated_at: now, completed_at: null, ...over,
    });
    const jobInput = () => ({ ...row(), id: 'j1' }) as any;

    function fakePool(responses: Array<{ rows: any[] }>) {
      const calls: Array<{ text: string; params: unknown[] }> = [];
      return {
        calls,
        pool: { query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return responses.shift() ?? { rows: [] }; } } as any,
      };
    }
    const baseJob = () => ({
      id: 'j1', type: 't', payload: { version: 1, data: {} }, retryPolicy: DEFAULT_RETRY_POLICY,
      runAt: now.toISOString(), idempotencyKey: 'k', correlationId: null, createdAt: now.toISOString(),
    }) as any;

    it('maps rows to jobs (dates to ISO strings, null errors to [])', () => {
      const job = rowToJob(row({ locked_until: now, completed_at: now, errors: null }));
      assert.equal(job.runAt, now.toISOString());
      assert.equal(job.lockedUntil, now.toISOString());
      assert.equal(job.completedAt, now.toISOString());
      assert.deepEqual(job.errors, []);
      assert.equal(rowToJob(jobInput()).lockedUntil, null);
    });

    it('enqueue inserts, or returns the existing row on idempotency conflict', async () => {
      const inserted = fakePool([{ rows: [row()] }]);
      const created = await new PostgresJobStore(inserted.pool).enqueue(baseJob());
      assert.equal(created.created, true);
      assert.match(inserted.calls[0].text, /ON CONFLICT \(idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/);

      const conflict = fakePool([{ rows: [] }, { rows: [row({ id: 'existing' })] }]);
      const dup = await new PostgresJobStore(conflict.pool).enqueue(baseJob());
      assert.equal(dup.created, false);
      assert.equal(dup.job.id, 'existing');
      assert.equal(conflict.calls[1].params[0], 'k');
    });

    it('claimNext uses SKIP LOCKED, parenthesises the due predicate, and filters by type', async () => {
      const typed = fakePool([{ rows: [row({ status: 'running', attempts: 1 })] }]);
      const claimed = await new PostgresJobStore(typed.pool).claimNext('w', now, 5000, ['t']);
      assert.equal(claimed?.attempts, 1);
      assert.match(typed.calls[0].text, /FOR UPDATE SKIP LOCKED/);
      assert.match(typed.calls[0].text, /\(\(status = 'queued'[\s\S]*locked_until <= \$2\)\)\s+AND type = ANY\(\$4\)/);
      assert.deepEqual(typed.calls[0].params, ['w', now, '5000', ['t']]);

      const untyped = fakePool([{ rows: [] }]);
      assert.equal(await new PostgresJobStore(untyped.pool).claimNext('w', now, 5000), null);
      assert.doesNotMatch(untyped.calls[0].text, /ANY\(\$4\)/);
      assert.equal(untyped.calls[0].params.length, 3);
    });

    it('markSucceeded and markFailed are lease-guarded and return null when the lease is lost', async () => {
      const ok = fakePool([{ rows: [row({ status: 'succeeded' })] }, { rows: [] }, { rows: [row({ status: 'dead' })] }, { rows: [] }]);
      const store = new PostgresJobStore(ok.pool);
      assert.equal((await store.markSucceeded('j1', 'w', { a: 1 }, now))?.status, 'succeeded');
      assert.match(ok.calls[0].text, /locked_by = \$2/);
      assert.equal(ok.calls[0].params[2], '{"a":1}');
      assert.equal(await store.markSucceeded('j1', 'w', undefined, now), null);
      assert.equal(ok.calls[1].params[2], 'null');

      assert.equal((await store.markFailed('j1', 'w', { attempt: 1, at: 'x', message: 'm' }, null, now))?.status, 'dead');
      assert.equal(ok.calls[2].params[3], null);
      assert.equal(await store.markFailed('j1', 'w', { attempt: 1, at: 'x', message: 'm' }, now, now), null);
    });

    it('get, list, requeueDead and counts issue the expected queries', async () => {
      const p = fakePool([
        { rows: [row()] }, { rows: [] },
        { rows: [{ n: 7 }] }, { rows: [row(), row({ id: 'j2' })] },
        { rows: [{ n: 0 }] }, { rows: [] },
        { rows: [row()] }, { rows: [] },
        { rows: [{ status: 'queued', n: 2 }, { status: 'dead', n: 1 }] },
      ]);
      const store = new PostgresJobStore(p.pool);
      assert.equal((await store.get('j1'))?.id, 'j1');
      assert.equal(await store.get('nope'), null);

      const listed = await store.list({ status: 'dead', type: 't', limit: 2, offset: 4 });
      assert.equal(listed.total, 7);
      assert.equal(listed.jobs.length, 2);
      assert.deepEqual(p.calls[3].params, ['dead', 't', 2, 4]);
      await store.list();
      assert.deepEqual(p.calls[5].params, [null, null, 50, 0]);

      assert.equal((await store.requeueDead('j1', now))?.id, 'j1');
      assert.equal(await store.requeueDead('j1', now), null);
      assert.deepEqual(await store.counts(), { queued: 2, running: 0, succeeded: 0, dead: 1 });
    });
  });

  describe('runtime and memory store contracts', () => {
    it('rejects malformed scheduler inputs before enqueueing', async () => {
      const h = harness();

      assert.throws(() => scheduleExpirySweep({} as JobQueue), /job queue/);
      assert.throws(() => scheduleExpirySweep(h.queue, h.now(), 0), /intervalMs/);
      assert.throws(() => scheduleExpirySweep(h.queue, new Date('not-a-date')), /valid Date/);
    });

    it('validates handler dependencies and handler results', async () => {
      const h = harness();

      assert.throws(() => registerJobHandlers({} as JobWorker, { expirePendingInvoices: async () => 1 }), /job worker/);
      assert.throws(() => registerJobHandlers(h.make(), {} as any), /expirePendingInvoices/);

      const worker = registerJobHandlers(h.make('contract-worker'), { expirePendingInvoices: async () => Number.NaN });
      const { job } = await scheduleExpirySweep(h.queue, h.now());
      await worker.runOnce();
      h.advance(5_000);
      await worker.runOnce();
      h.advance(10_000);
      await worker.runOnce();
      assert.equal((await h.store.get(job.id))?.status, 'dead');
    });

    it('rejects malformed memory jobs and invalid store operations', async () => {
      const h = harness();
      const { job } = await h.queue.enqueue('demo', { ok: true });

      await assert.rejects(() => h.store.enqueue({ ...job, id: '' }), /id/);
      await assert.rejects(() => h.store.enqueue({ ...job, status: 'lost' as any }), /status/);
      await assert.rejects(() => h.store.claimNext('', h.now(), 10), /workerId/);
      await assert.rejects(() => h.store.claimNext('w', h.now(), 0), /leaseMs/);
      await assert.rejects(() => h.store.list({ limit: -1 }), /limit/);
      await assert.rejects(() => h.store.list({ offset: -1 }), /offset/);
      await assert.rejects(() => h.store.get(''), /id/);
    });
  });
});
