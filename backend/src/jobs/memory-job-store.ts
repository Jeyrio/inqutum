import { Job, JobError, JobFilter, JobStatus, JobStore } from './job-types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`job ${field} must be a non-empty string`);
  }
}

function requireIsoDate(value: unknown, field: string): void {
  requireString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`job ${field} must be an ISO timestamp`);
  }
}

function validateJob(job: Job): void {
  requireString(job.id, 'id');
  requireString(job.type, 'type');
  requireIsoDate(job.runAt, 'runAt');
  requireIsoDate(job.createdAt, 'createdAt');
  requireIsoDate(job.updatedAt, 'updatedAt');
  if (job.completedAt !== null) requireIsoDate(job.completedAt, 'completedAt');
  if (job.lockedUntil !== null) requireIsoDate(job.lockedUntil, 'lockedUntil');
  if (!['queued', 'running', 'succeeded', 'dead'].includes(job.status)) {
    throw new Error(`invalid job status: ${job.status}`);
  }
  if (!Number.isInteger(job.attempts) || job.attempts < 0) {
    throw new Error('job attempts must be a non-negative integer');
  }
  if (!job.payload || typeof job.payload !== 'object' || !Number.isInteger(job.payload.version) || job.payload.version < 1) {
    throw new Error('job payload must include a positive version');
  }
  if (!job.retryPolicy || !Number.isInteger(job.retryPolicy.maxAttempts) || job.retryPolicy.maxAttempts < 1) {
    throw new Error('job retryPolicy.maxAttempts must be a positive integer');
  }
  if (!Array.isArray(job.errors)) {
    throw new Error('job errors must be an array');
  }
}

function validateWorker(workerId: string, leaseMs?: number): void {
  requireString(workerId, 'workerId');
  if (leaseMs !== undefined && (!Number.isFinite(leaseMs) || leaseMs <= 0)) {
    throw new Error('job leaseMs must be a positive finite number');
  }
}

function validateFilter(filter: JobFilter): void {
  if (filter.status && !['queued', 'running', 'succeeded', 'dead'].includes(filter.status)) {
    throw new Error(`invalid job status filter: ${filter.status}`);
  }
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0)) {
    throw new Error('job filter limit must be a non-negative integer');
  }
  if (filter.offset !== undefined && (!Number.isInteger(filter.offset) || filter.offset < 0)) {
    throw new Error('job filter offset must be a non-negative integer');
  }
}

/** In-memory JobStore for the MVP server, local development and tests. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private byIdempotencyKey = new Map<string, string>();

  async enqueue(job: Job): Promise<{ job: Job; created: boolean }> {
    validateJob(job);
    if (job.idempotencyKey) {
      const existingId = this.byIdempotencyKey.get(job.idempotencyKey);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing) return { job: clone(existing), created: false };
      this.byIdempotencyKey.set(job.idempotencyKey, job.id);
    }
    this.jobs.set(job.id, clone(job));
    return { job: clone(job), created: true };
  }

  async claimNext(workerId: string, now: Date, leaseMs: number, types?: string[]): Promise<Job | null> {
    validateWorker(workerId, leaseMs);
    if (Number.isNaN(now.getTime())) throw new Error('job now must be a valid Date');
    const due = [...this.jobs.values()]
      .filter((j) => {
        if (types && !types.includes(j.type)) return false;
        if (j.status === 'queued') return new Date(j.runAt) <= now;
        return j.status === 'running' && !!j.lockedUntil && new Date(j.lockedUntil) <= now;
      })
      .sort((a, b) => a.runAt.localeCompare(b.runAt) || a.createdAt.localeCompare(b.createdAt));

    const job = due[0];
    if (!job) return null;

    job.status = 'running';
    job.attempts += 1;
    job.lockedBy = workerId;
    job.lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
    job.updatedAt = now.toISOString();
    return clone(job);
  }

  async markSucceeded(id: string, workerId: string, result: unknown, now: Date): Promise<Job | null> {
    requireString(id, 'id');
    validateWorker(workerId);
    if (Number.isNaN(now.getTime())) throw new Error('job now must be a valid Date');
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || job.lockedBy !== workerId) return null;
    job.status = 'succeeded';
    job.result = result === undefined ? null : clone(result);
    job.lockedBy = null;
    job.lockedUntil = null;
    job.completedAt = job.updatedAt = now.toISOString();
    return clone(job);
  }

  async markFailed(id: string, workerId: string, error: JobError, retryAt: Date | null, now: Date): Promise<Job | null> {
    requireString(id, 'id');
    validateWorker(workerId);
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || job.lockedBy !== workerId) return null;

    if (!Number.isInteger(error.attempt) || error.attempt < 1) throw new Error('job error attempt must be a positive integer');
    requireIsoDate(error.at, 'error.at');
    requireString(error.message, 'error.message');
    if (retryAt !== null && Number.isNaN(retryAt.getTime())) throw new Error('job retryAt must be a valid Date');
    if (Number.isNaN(now.getTime())) throw new Error('job now must be a valid Date');

    job.errors.push(error);
    job.lockedBy = null;
    job.lockedUntil = null;
    job.updatedAt = now.toISOString();
    if (retryAt) {
      job.status = 'queued';
      job.runAt = retryAt.toISOString();
    } else {
      job.status = 'dead';
      job.completedAt = now.toISOString();
    }
    return clone(job);
  }

  async get(id: string): Promise<Job | null> {
    requireString(id, 'id');
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  async list(filter: JobFilter = {}): Promise<{ jobs: Job[]; total: number }> {
    validateFilter(filter);
    const matching = [...this.jobs.values()]
      .filter((j) => (!filter.status || j.status === filter.status) && (!filter.type || j.type === filter.type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { jobs: matching.slice(offset, offset + limit).map(clone), total: matching.length };
  }

  async requeueDead(id: string, now: Date): Promise<Job | null> {
    requireString(id, 'id');
    if (Number.isNaN(now.getTime())) throw new Error('job now must be a valid Date');
    const job = this.jobs.get(id);
    if (!job || job.status !== 'dead') return null;
    job.status = 'queued';
    job.attempts = 0;
    job.runAt = now.toISOString();
    job.completedAt = null;
    job.updatedAt = now.toISOString();
    return clone(job);
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, dead: 0 };
    for (const job of this.jobs.values()) counts[job.status] += 1;
    return counts;
  }

  clear(): void {
    this.jobs.clear();
    this.byIdempotencyKey.clear();
  }
}
