/**
 * Partial-failure dashboard.
 *
 * Builds on the pure report in `domain/partial-failures.ts` and adds what an
 * operator needs to act:
 *   - filtering unresolved failures (type, severity, stale, retryable, invoice,
 *     user-action-required),
 *   - a cause breakdown for one failure (error history, classified cause),
 *   - a "user action required" flag for failures only the end user can fix,
 *   - safe retry: only open + retryable failures, guarded against double
 *     submission with an idempotency key and an in-flight lock.
 *
 * Retry never mutates invoices directly: it requeues the underlying job via the
 * JobStore, so the job handler's own idempotency and version checks still apply.
 * See docs/PARTIAL-FAILURES.md#dashboard.
 */
import type { Job, JobStore } from '../jobs/job-types';
import {
  buildPartialFailureReport,
  jobsToOperations,
  redactSecrets,
  type PartialFailure,
  type PartialFailureSeverity,
  type PartialOperation,
} from '../domain/partial-failures';

/** Error causes the operator cannot fix; the user has to act. */
const USER_ACTION_CAUSES: Array<{ code: string; pattern: RegExp; userAction: string }> = [
  { code: 'INVALID_RECIPIENT', pattern: /invalid (recipient|email)|mailbox unavailable|\b550\b|address rejected/i, userAction: 'Update the customer email address on the invoice.' },
  { code: 'UNDERPAID', pattern: /underpaid|amount mismatch|insufficient amount|partial payment/i, userAction: 'Payer must send the remaining balance or contact the seller.' },
  { code: 'WRONG_ASSET', pattern: /wrong asset|asset mismatch|no trustline|trustline/i, userAction: 'Payer must pay with the invoice asset (check trustline).' },
  { code: 'MEMO_MISMATCH', pattern: /memo (mismatch|missing)/i, userAction: 'Payer must resubmit proof with the transaction that carries the invoice memo.' },
  { code: 'UNSUBSCRIBED', pattern: /unsubscribed|opted out|suppressed/i, userAction: 'Recipient opted out; share the invoice link directly.' },
];

const SYSTEM_CAUSES: Array<{ code: string; pattern: RegExp }> = [
  { code: 'TIMEOUT', pattern: /timeout|ETIMEDOUT/i },
  { code: 'UPSTREAM_UNAVAILABLE', pattern: /ECONNREFUSED|ENOTFOUND|\b5\d\d\b|unavailable/i },
  { code: 'RATE_LIMITED', pattern: /\b429\b|rate.?limit|throttl/i },
  { code: 'CONFLICT', pattern: /conflict|version mismatch|already (paid|cancelled)/i },
];

export interface ClassifiedCause {
  code: string;
  userActionRequired: boolean;
  userAction: string | null;
}

export function classifyCause(message: string | null | undefined): ClassifiedCause {
  const text = message ?? '';
  const user = USER_ACTION_CAUSES.find((c) => c.pattern.test(text));
  if (user) return { code: user.code, userActionRequired: true, userAction: user.userAction };
  const sys = SYSTEM_CAUSES.find((c) => c.pattern.test(text));
  return { code: sys?.code ?? 'UNKNOWN', userActionRequired: false, userAction: null };
}

export interface DashboardItem extends PartialFailure {
  cause: ClassifiedCause;
  /** True when retrying cannot help; the operator should contact the user. */
  userActionRequired: boolean;
}

export interface DashboardFilter {
  operationType?: string;
  severity?: PartialFailureSeverity;
  stale?: boolean;
  retryable?: boolean;
  userActionRequired?: boolean;
  invoiceId?: string;
  limit?: number;
}

export interface DashboardView {
  generatedAt: string;
  items: DashboardItem[];
  total: number;
  summary: ReturnType<typeof buildPartialFailureReport>['summary'] & { userActionRequired: number };
}

const parseBool = (v: unknown): boolean | undefined =>
  v === 'true' || v === true ? true : v === 'false' || v === false ? false : undefined;

const SEVERITIES: PartialFailureSeverity[] = ['critical', 'error', 'warning'];

/** Parse query params; unknown values are rejected rather than ignored. */
export function parseDashboardFilter(query: Record<string, unknown>): { filter: DashboardFilter; error?: string } {
  const filter: DashboardFilter = {};
  if (query.severity !== undefined) {
    if (!SEVERITIES.includes(query.severity as PartialFailureSeverity)) {
      return { filter, error: `severity must be one of ${SEVERITIES.join(', ')}` };
    }
    filter.severity = query.severity as PartialFailureSeverity;
  }
  for (const key of ['stale', 'retryable', 'userActionRequired'] as const) {
    if (query[key] !== undefined) {
      const b = parseBool(query[key]);
      if (b === undefined) return { filter, error: `${key} must be true or false` };
      filter[key] = b;
    }
  }
  if (typeof query.operationType === 'string' && query.operationType) filter.operationType = query.operationType;
  if (typeof query.invoiceId === 'string' && query.invoiceId) filter.invoiceId = query.invoiceId;
  if (query.limit !== undefined) {
    const n = parseInt(String(query.limit), 10);
    filter.limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 100;
  }
  return { filter };
}

function decorate(f: PartialFailure, rawError: string | null | undefined): DashboardItem {
  const cause = classifyCause(rawError);
  const item: DashboardItem = { ...f, cause, userActionRequired: cause.userActionRequired };
  // Retrying a failure only the user can fix just burns attempts.
  if (cause.userActionRequired) {
    item.recoveryAction = 'inspect';
    item.links = { ...item.links, retry: null };
  }
  return item;
}

export function buildDashboard(
  operations: PartialOperation[],
  filter: DashboardFilter = {},
  now: Date = new Date()
): DashboardView {
  const report = buildPartialFailureReport(operations, { now });
  const rawErrors = new Map(operations.map((o) => [o.id, o.lastError]));
  const all = report.unresolved.map((f) => decorate(f, rawErrors.get(f.id)));
  const matched = all.filter(
    (i) =>
      (filter.operationType === undefined || i.operationType === filter.operationType || i.operationType.startsWith(`${filter.operationType}.`)) &&
      (filter.severity === undefined || i.severity === filter.severity) &&
      (filter.stale === undefined || i.stale === filter.stale) &&
      (filter.retryable === undefined || (i.links.retry !== null) === filter.retryable) &&
      (filter.userActionRequired === undefined || i.userActionRequired === filter.userActionRequired) &&
      (filter.invoiceId === undefined || i.invoiceId === filter.invoiceId)
  );
  return {
    generatedAt: report.generatedAt,
    items: matched.slice(0, filter.limit ?? 100),
    total: matched.length,
    summary: { ...report.summary, userActionRequired: all.filter((i) => i.userActionRequired).length },
  };
}

export interface FailureDetail {
  item: DashboardItem | null;
  /** Full redacted error history (stacks never included). */
  history: Array<{ attempt: number; at: string; message: string; cause: string }>;
  state: 'open' | 'resolved' | 'ignored' | 'not_failed';
}

export function inspectJobFailure(job: Job, now: Date = new Date()): FailureDetail {
  const ops = jobsToOperations([job]);
  const history = job.errors.map((e) => ({
    attempt: e.attempt,
    at: e.at,
    message: redactSecrets(e.message),
    cause: classifyCause(e.message).code,
  }));
  if (ops.length === 0) return { item: null, history, state: 'not_failed' };
  const view = buildDashboard(ops, {}, now);
  if (view.items.length === 0) return { item: null, history, state: job.status === 'succeeded' ? 'resolved' : 'ignored' };
  return { item: view.items[0], history, state: 'open' };
}

export type RetryOutcome =
  | { status: 'requeued'; job: Job }
  | { status: 'duplicate'; job: Job }
  | { status: 'rejected'; code: 'NOT_FOUND' | 'NOT_FAILED' | 'USER_ACTION_REQUIRED' | 'RETRY_IN_PROGRESS' | 'NOT_RETRYABLE_STATE'; message: string };

/**
 * Safe retry coordinator.
 *  - Only dead jobs are requeued (queued jobs with errors already auto-retry).
 *  - Failures needing user action are refused.
 *  - The same idempotency key within the window returns the first result
 *    instead of requeueing twice (double-click / network retry safe).
 *  - Concurrent retries of the same job are serialised by an in-flight set.
 */
export class PartialFailureRetryCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly seen = new Map<string, { jobId: string; at: number }>();

  constructor(private readonly store: JobStore, private readonly windowMs = 10 * 60_000) {}

  async retry(jobId: string, idempotencyKey: string | undefined, now: Date = new Date()): Promise<RetryOutcome> {
    this.prune(now.getTime());
    if (idempotencyKey) {
      const prior = this.seen.get(idempotencyKey);
      if (prior && prior.jobId === jobId) {
        const job = await this.store.get(jobId);
        if (job) return { status: 'duplicate', job };
      }
    }
    if (this.inFlight.has(jobId)) {
      return { status: 'rejected', code: 'RETRY_IN_PROGRESS', message: 'A retry for this job is already running' };
    }
    this.inFlight.add(jobId);
    try {
      const job = await this.store.get(jobId);
      if (!job) return { status: 'rejected', code: 'NOT_FOUND', message: 'Job not found' };
      if (job.status === 'succeeded' || job.errors.length === 0) {
        return { status: 'rejected', code: 'NOT_FAILED', message: 'Job has no unresolved failure' };
      }
      const cause = classifyCause(job.errors.at(-1)?.message);
      if (cause.userActionRequired) {
        return { status: 'rejected', code: 'USER_ACTION_REQUIRED', message: cause.userAction ?? 'User action required' };
      }
      if (job.status !== 'dead') {
        return { status: 'rejected', code: 'NOT_RETRYABLE_STATE', message: `Job is ${job.status}; it will retry automatically` };
      }
      const requeued = await this.store.requeueDead(jobId, now);
      if (!requeued) {
        return { status: 'rejected', code: 'NOT_RETRYABLE_STATE', message: 'Job changed state before retry' };
      }
      if (idempotencyKey) this.seen.set(idempotencyKey, { jobId, at: now.getTime() });
      return { status: 'requeued', job: requeued };
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  private prune(nowMs: number) {
    for (const [k, v] of this.seen) if (nowMs - v.at > this.windowMs) this.seen.delete(k);
  }
}
