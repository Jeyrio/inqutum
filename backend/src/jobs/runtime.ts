import { JobQueue, JobWorker } from './worker';
import { JobStore } from './job-types';
import { MemoryJobStore } from './memory-job-store';
import { PostgresJobStore } from './postgres-job-store';

export const EXPIRE_PENDING_INVOICES_JOB = 'invoices.expire-pending';
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;
export const RESUMABLE_REPAIR_JOB = 'records.resumable-repair';

export interface JobHandlerDeps {
  /** Marks overdue PENDING invoices EXPIRED and returns how many changed. Must be idempotent. */
  expirePendingInvoices: () => Promise<number>;
  /** Executes or resumes a record repair job. */
  repairRecords?: (payload: {
    jobId?: string;
    dryRun?: boolean;
    batchSize?: number;
    phases?: any[];
    maxBatches?: number;
  }) => Promise<unknown>;
}

function assertPositiveFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertJobQueue(queue: JobQueue): void {
  if (!queue || typeof queue.enqueue !== 'function') {
    throw new Error('job queue must expose enqueue(type, payload, options)');
  }
}

function assertJobWorker(worker: JobWorker): void {
  if (!worker || typeof worker.register !== 'function') {
    throw new Error('job worker must expose register(type, handler)');
  }
}

function assertJobHandlerDeps(deps: JobHandlerDeps): void {
  if (!deps || typeof deps.expirePendingInvoices !== 'function') {
    throw new Error('expirePendingInvoices must be a function');
  }
}

function assertJobStore(store: JobStore): JobStore {
  for (const method of ['enqueue', 'claimNext', 'markSucceeded', 'markFailed', 'get', 'list', 'requeueDead', 'counts'] as const) {
    if (typeof store[method] !== 'function') {
      throw new Error(`job store is missing ${method}()`);
    }
  }
  return store;
}

export function registerJobHandlers(worker: JobWorker, deps: JobHandlerDeps): JobWorker {
  assertJobWorker(worker);
  assertJobHandlerDeps(deps);

  worker.register(EXPIRE_PENDING_INVOICES_JOB, async () => {
    const expired = await deps.expirePendingInvoices();
    if (!Number.isInteger(expired) || expired < 0) {
      throw new Error('expirePendingInvoices must resolve to a non-negative integer');
    }
    return { expired };
  });

  if (deps.repairRecords) {
    worker.register(RESUMABLE_REPAIR_JOB, async (payload) => {
      const data = (payload?.data ?? {}) as {
        jobId?: string;
        dryRun?: boolean;
        batchSize?: number;
        phases?: any[];
        maxBatches?: number;
      };
      return await deps.repairRecords!(data);
    });
  }

  return worker;
}

/**
 * Enqueues one expiry sweep per interval bucket. The bucket is part of the
 * idempotency key, so several instances (or a restart within the same minute)
 * produce a single job rather than duplicates.
 */
export function scheduleExpirySweep(queue: JobQueue, now: Date = new Date(), intervalMs = EXPIRY_SWEEP_INTERVAL_MS) {
  assertJobQueue(queue);
  assertPositiveFiniteNumber(intervalMs, 'intervalMs');

  const time = now.getTime();
  if (!Number.isFinite(time)) {
    throw new Error('now must be a valid Date');
  }

  const bucket = Math.floor(time / intervalMs);
  return queue.enqueue(EXPIRE_PENDING_INVOICES_JOB, {}, {
    idempotencyKey: `${EXPIRE_PENDING_INVOICES_JOB}:${bucket}`,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000 },
  });
}

export function startExpiryScheduler(queue: JobQueue, intervalMs = EXPIRY_SWEEP_INTERVAL_MS): () => void {
  assertJobQueue(queue);
  assertPositiveFiniteNumber(intervalMs, 'intervalMs');

  const enqueue = () =>
    scheduleExpirySweep(queue, new Date(), intervalMs).catch((err) =>
      console.error('[jobs] failed to schedule expiry sweep:', err)
    );
  void enqueue();
  const timer = setInterval(enqueue, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function createJobStore(pool?: ConstructorParameters<typeof PostgresJobStore>[0]): JobStore {
  return assertJobStore(pool ? new PostgresJobStore(pool) : new MemoryJobStore());
}

export * from './backpressure';
