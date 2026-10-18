import type { Pool } from 'pg';
import { Job, JobError, JobFilter, JobStatus, JobStore } from './job-types';

const COLUMNS = `id, type, payload, status, attempts, retry_policy, run_at, locked_until, locked_by,
  idempotency_key, correlation_id, errors, result, created_at, updated_at, completed_at`;

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export function rowToJob(row: any): Job {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    retryPolicy: row.retry_policy,
    runAt: iso(row.run_at)!,
    lockedUntil: iso(row.locked_until),
    lockedBy: row.locked_by,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    errors: row.errors ?? [],
    result: row.result,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    completedAt: iso(row.completed_at),
  };
}

/** PostgreSQL JobStore. Claiming uses FOR UPDATE SKIP LOCKED so workers never double-claim. */
export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async enqueue(job: Job): Promise<{ job: Job; created: boolean }> {
    const inserted = await this.pool.query(
      `INSERT INTO jobs (id, type, payload, status, attempts, retry_policy, run_at, idempotency_key,
                         correlation_id, errors, created_at, updated_at)
       VALUES ($1,$2,$3,'queued',0,$4,$5,$6,$7,'[]'::jsonb,$8,$8)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      [job.id, job.type, job.payload, job.retryPolicy, job.runAt, job.idempotencyKey, job.correlationId, job.createdAt]
    );
    if (inserted.rows[0]) return { job: rowToJob(inserted.rows[0]), created: true };

    const existing = await this.pool.query(`SELECT ${COLUMNS} FROM jobs WHERE idempotency_key = $1`, [job.idempotencyKey]);
    return { job: rowToJob(existing.rows[0]), created: false };
  }

  async claimNext(workerId: string, now: Date, leaseMs: number, types?: string[]): Promise<Job | null> {
    const res = await this.pool.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $1,
              locked_until = $2::timestamptz + ($3 || ' milliseconds')::interval, updated_at = $2
       WHERE id = (
         SELECT id FROM jobs
         WHERE ((status = 'queued' AND run_at <= $2)
            OR (status = 'running' AND locked_until <= $2))
         ${types ? 'AND type = ANY($4)' : ''}
         ORDER BY run_at, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
      types ? [workerId, now, String(leaseMs), types] : [workerId, now, String(leaseMs)]
    );
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async markSucceeded(id: string, workerId: string, result: unknown, now: Date): Promise<Job | null> {
    const res = await this.pool.query(
      `UPDATE jobs SET status = 'succeeded', result = $3, locked_by = NULL, locked_until = NULL,
              completed_at = $4, updated_at = $4
       WHERE id = $1 AND status = 'running' AND locked_by = $2
       RETURNING ${COLUMNS}`,
      [id, workerId, JSON.stringify(result ?? null), now]
    );
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async markFailed(id: string, workerId: string, error: JobError, retryAt: Date | null, now: Date): Promise<Job | null> {
    const res = await this.pool.query(
      `UPDATE jobs SET errors = errors || $3::jsonb, locked_by = NULL, locked_until = NULL, updated_at = $5,
              status = CASE WHEN $4::timestamptz IS NULL THEN 'dead' ELSE 'queued' END,
              run_at = COALESCE($4::timestamptz, run_at),
              completed_at = CASE WHEN $4::timestamptz IS NULL THEN $5::timestamptz ELSE NULL END
       WHERE id = $1 AND status = 'running' AND locked_by = $2
       RETURNING ${COLUMNS}`,
      [id, workerId, JSON.stringify([error]), retryAt, now]
    );
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async get(id: string): Promise<Job | null> {
    const res = await this.pool.query(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async list(filter: JobFilter = {}): Promise<{ jobs: Job[]; total: number }> {
    const params: unknown[] = [filter.status ?? null, filter.type ?? null];
    const where = `($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR type = $2)`;
    const total = await this.pool.query(`SELECT COUNT(*)::int AS n FROM jobs WHERE ${where}`, params);
    const rows = await this.pool.query(
      `SELECT ${COLUMNS} FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [...params, filter.limit ?? 50, filter.offset ?? 0]
    );
    return { jobs: rows.rows.map(rowToJob), total: total.rows[0].n };
  }

  async requeueDead(id: string, now: Date): Promise<Job | null> {
    const res = await this.pool.query(
      `UPDATE jobs SET status = 'queued', attempts = 0, run_at = $2, completed_at = NULL, updated_at = $2
       WHERE id = $1 AND status = 'dead' RETURNING ${COLUMNS}`,
      [id, now]
    );
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const res = await this.pool.query(`SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`);
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, dead: 0 };
    for (const row of res.rows) counts[row.status as JobStatus] = row.n;
    return counts;
  }
}
