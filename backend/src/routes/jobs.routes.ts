import { NextFunction, Request, Response, Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { Job, JobStatus, JobStore } from '../jobs/job-types';
import { auditStore } from '../audit/audit-service';
import { DeadLetterOperator } from '../jobs/dead-letter-operator';

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'dead'];

export interface JobsRouterOptions {
  store: JobStore;
  /** Bearer token required for every route. When empty, the routes are disabled (403). */
  adminToken?: string;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Job inspection is maintainer-only: payloads and stack traces are internal. */
export function requireAdmin(adminToken?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = adminToken ?? process.env.JOBS_ADMIN_TOKEN;
    if (!token) {
      return res.status(403).json({ success: false, code: 'JOBS_ADMIN_DISABLED', error: 'Job inspection is not enabled', correlationId: req.correlationId });
    }
    const header = req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !tokenMatches(provided, token)) {
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: 'Invalid or missing admin token', correlationId: req.correlationId });
    }
    next();
  };
}

const view = (job: Job) => job;

/**
 * Mount under `/api`.
 *   GET  /jobs            ?status=&type=&limit=&offset=
 *   GET  /jobs/:id
 *   POST /jobs/:id/retry  requeue a dead-lettered job
 */
export function createJobsRouter(options: JobsRouterOptions): Router {
  const router = Router();
  const deadLetters = new DeadLetterOperator(options.store);
  router.use('/jobs', requireAdmin(options.adminToken));

  router.get('/jobs', async (req, res, next) => {
    try {
      const status = req.query.status as string | undefined;
      if (status && !STATUSES.includes(status as JobStatus)) {
        return res.status(400).json({ success: false, code: 'INVALID_STATUS', error: `status must be one of ${STATUSES.join(', ')}`, correlationId: req.correlationId });
      }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const type = typeof req.query.type === 'string' ? req.query.type : undefined;

      const [{ jobs, total }, counts] = await Promise.all([
        status === 'dead'
          ? deadLetters.inspect({ id: 'jobs-admin', role: 'admin' }, { type, limit, offset })
          : options.store.list({ status: status as JobStatus | undefined, type, limit, offset }),
        options.store.counts(),
      ]);
      res.json({ success: true, data: { jobs: jobs.map(view), total, limit, offset, counts }, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:id', async (req, res, next) => {
    try {
      const job = await options.store.get(req.params.id);
      if (!job) return res.status(404).json({ success: false, code: 'JOB_NOT_FOUND', error: 'Job not found', correlationId: req.correlationId });
      res.json({ success: true, data: view(job), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/retry', async (req, res, next) => {
    try {
      const job = await deadLetters.retry({ id: 'jobs-admin', role: 'admin' }, req.params.id, new Date());
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'jobs-admin' },
        scope: { entityType: 'system', entityId: job.id },
        reason: 'Dead-lettered job requeued',
        metadata: { jobType: job.type },
        correlationId: req.correlationId,
      });
      res.json({ success: true, data: view(job), correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof Error && /^Job .* is not dead-lettered/.test(err.message)) {
        return res.status(409).json({ success: false, code: 'JOB_NOT_DEAD', error: 'Only dead-lettered jobs can be retried', correlationId: req.correlationId });
      }
      next(err);
    }
  });

  return router;
}

export default createJobsRouter;
