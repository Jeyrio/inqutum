/**
 * Background job framework — shared types.
 *
 * A job is a durable, JSON-serialisable unit of work with a retry policy.
 * Lifecycle: queued -> running -> succeeded
 *                        |-> queued (retry, after backoff)
 *                        |-> dead   (attempts exhausted, or non-retryable)
 * Dead jobs are the dead-letter set; they keep their full error history and can
 * be requeued by a maintainer.
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';

export interface RetryPolicy {
  /** Total attempts allowed, including the first one. */
  maxAttempts: number;
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Multiplier applied per additional attempt (exponential backoff). */
  backoffFactor: number;
  /** Upper bound for any single delay. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  backoffFactor: 2,
  maxDelayMs: 5 * 60_000,
};

export interface JobError {
  attempt: number;
  at: string;
  message: string;
  /** Stack trace, kept for debugging failed jobs. Never returned to non-admin callers. */
  stack?: string;
}

/** Versioned envelope so payload shape changes can be handled by handlers. */
export interface JobPayload<T = Record<string, unknown>> {
  version: number;
  data: T;
}

export interface Job<T = Record<string, unknown>> {
  id: string;
  type: string;
  payload: JobPayload<T>;
  status: JobStatus;
  attempts: number;
  retryPolicy: RetryPolicy;
  /** Earliest time the job may run. */
  runAt: string;
  /** Set while running; a job whose lease has expired is reclaimed. */
  lockedUntil: string | null;
  lockedBy: string | null;
  /** Prevents duplicate enqueues of the same logical work. */
  idempotencyKey: string | null;
  correlationId: string | null;
  errors: JobError[];
  result: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface EnqueueOptions {
  runAt?: Date;
  retryPolicy?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  correlationId?: string;
  payloadVersion?: number;
}

export interface JobFilter {
  status?: JobStatus;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface JobStore {
  /** Inserts a job. If `idempotencyKey` already exists, returns the existing job with `created: false`. */
  enqueue(job: Job): Promise<{ job: Job; created: boolean }>;
  /** Atomically claims one due job (queued, or running with an expired lease). */
  claimNext(workerId: string, now: Date, leaseMs: number, types?: string[]): Promise<Job | null>;
  markSucceeded(id: string, workerId: string, result: unknown, now: Date): Promise<Job | null>;
  /** Records a failure; requeues at `retryAt`, or moves to dead when `retryAt` is null. */
  markFailed(id: string, workerId: string, error: JobError, retryAt: Date | null, now: Date): Promise<Job | null>;
  get(id: string): Promise<Job | null>;
  list(filter?: JobFilter): Promise<{ jobs: Job[]; total: number }>;
  /** Moves a dead job back to queued with a fresh attempt budget. */
  requeueDead(id: string, now: Date): Promise<Job | null>;
  counts(): Promise<Record<JobStatus, number>>;
}

export function computeBackoffMs(policy: RetryPolicy, attempt: number): number {
  const exp = policy.baseDelayMs * Math.pow(policy.backoffFactor, Math.max(0, attempt - 1));
  return Math.min(exp, policy.maxDelayMs);
}

/** Thrown by handlers to skip retries and dead-letter immediately. */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}
