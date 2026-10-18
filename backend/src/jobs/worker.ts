import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_RETRY_POLICY,
  EnqueueOptions,
  Job,
  JobError,
  JobStore,
  NonRetryableJobError,
  RetryPolicy,
  computeBackoffMs,
} from './job-types';

export interface JobContext {
  job: Job;
  /** 1-based attempt number for this run. */
  attempt: number;
  /** Stable across retries; use it to make side effects idempotent. */
  idempotencyKey: string;
}

export type JobHandler = (payload: Job['payload'], ctx: JobContext) => Promise<unknown>;

export class JobQueue {
  constructor(
    private readonly store: JobStore,
    private readonly defaults: RetryPolicy = DEFAULT_RETRY_POLICY,
    private readonly now: () => Date = () => new Date()
  ) {}

  async enqueue(type: string, data: Record<string, unknown> = {}, options: EnqueueOptions = {}) {
    const now = this.now();
    const job: Job = {
      id: uuidv4(),
      type,
      payload: { version: options.payloadVersion ?? 1, data },
      status: 'queued',
      attempts: 0,
      retryPolicy: { ...this.defaults, ...options.retryPolicy },
      runAt: (options.runAt ?? now).toISOString(),
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: options.idempotencyKey ?? null,
      correlationId: options.correlationId ?? null,
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    };
    return this.store.enqueue(job);
  }
}

export interface JobWorkerOptions {
  store: JobStore;
  workerId?: string;
  /** How long a claimed job is held before another worker may reclaim it. */
  leaseMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export class JobWorker {
  private readonly store: JobStore;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: JobWorkerOptions) {
    this.store = options.store;
    this.workerId = options.workerId ?? `worker-${uuidv4()}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message, meta) => console.log(`[jobs] ${message}`, meta ?? ''));
  }

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  /** Claims and runs at most one job. Returns the processed job, or null when idle. */
  async runOnce(): Promise<Job | null> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) return null;

    const claimed = await this.store.claimNext(this.workerId, this.now(), this.leaseMs, types);
    if (!claimed) return null;

    const handler = this.handlers.get(claimed.type)!;
    try {
      const result = await handler(claimed.payload, {
        job: claimed,
        attempt: claimed.attempts,
        idempotencyKey: claimed.idempotencyKey ?? claimed.id,
      });
      const done = await this.store.markSucceeded(claimed.id, this.workerId, result, this.now());
      if (!done) this.log('lease lost before completion; result discarded', { jobId: claimed.id });
      return done ?? claimed;
    } catch (err) {
      return this.handleFailure(claimed, err);
    }
  }

  /** Drains all currently-due jobs. */
  async drain(maxJobs = 1_000): Promise<number> {
    let processed = 0;
    while (processed < maxJobs && (await this.runOnce())) processed += 1;
    return processed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.drain()
        .catch((err) => this.log('worker tick failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          this.ticking = false;
        });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async handleFailure(job: Job, err: unknown): Promise<Job> {
    const error = err instanceof Error ? err : new Error(String(err));
    const record: JobError = {
      attempt: job.attempts,
      at: this.now().toISOString(),
      message: error.message,
      stack: error.stack,
    };
    const exhausted = job.attempts >= job.retryPolicy.maxAttempts;
    const retryable = !(error instanceof NonRetryableJobError) && !exhausted;
    const retryAt = retryable ? new Date(this.now().getTime() + computeBackoffMs(job.retryPolicy, job.attempts)) : null;

    const updated = await this.store.markFailed(job.id, this.workerId, record, retryAt, this.now());
    this.log(retryAt ? 'job failed, will retry' : 'job dead-lettered', {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      error: error.message,
    });
    return updated ?? job;
  }
}
