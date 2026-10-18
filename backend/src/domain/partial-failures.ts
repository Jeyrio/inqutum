/**
 * Partial failure report (issue #78).
 *
 * Lists operations that are stuck between internal state and an external
 * system: a background job that died or keeps retrying, a payment seen on
 * chain that never settled its invoice, and so on. Like reconciliation, this is a pure
 * function over plain data. It never retries or resolves anything; it tells an
 * operator where to look and what to do.
 */
import type { Job } from '../jobs/job-types';

export type PartialFailureSeverity = 'critical' | 'error' | 'warning';
export type PartialFailureState = 'open' | 'resolved' | 'ignored';
export type AgeBucket = 'under_1h' | '1h_to_24h' | 'over_24h';

export interface PartialOperation {
  id: string;
  /** e.g. `job.payment.verify`, `payment.settlement`. */
  operationType: string;
  /** What the internal record says (the invoice or job status). */
  internalState: string;
  /** Reference in the external system (Horizon tx hash, provider message id). */
  externalRef?: string | null;
  invoiceId?: string | null;
  startedAt: Date | string;
  lastAttemptAt?: Date | string | null;
  attempts: number;
  retryable: boolean;
  lastError?: string | null;
  resolvedAt?: Date | string | null;
  /** Set when an operator has decided not to act, with a reason. */
  ignoredAt?: Date | string | null;
  ignoredReason?: string | null;
}

export interface PartialFailure {
  id: string;
  operationType: string;
  internalState: string;
  externalRef: string | null;
  invoiceId: string | null;
  state: PartialFailureState;
  severity: PartialFailureSeverity;
  ageBucket: AgeBucket;
  ageMinutes: number;
  stale: boolean;
  retryable: boolean;
  attempts: number;
  lastError: string | null;
  recoveryAction: 'retry' | 'inspect' | 'none';
  links: {
    inspect: string;
    retry: string | null;
    remediation: string;
  };
}

export interface PartialFailureReport {
  generatedAt: string;
  unresolved: PartialFailure[];
  summary: {
    unresolved: number;
    resolved: number;
    ignored: number;
    byOperationType: Record<string, number>;
    bySeverity: Record<PartialFailureSeverity, number>;
    byAge: Record<AgeBucket, number>;
    retryable: number;
  };
}

export interface PartialFailureOptions {
  now: Date;
  /** An open failure older than this is stale. Defaults to 24 hours. */
  staleAfterMs?: number;
}

export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const REMEDIATION_DOC = 'docs/PARTIAL-FAILURES.md';

const HOUR = 60 * 60 * 1000;

const SECRET_PATTERNS: RegExp[] = [
  /\bS[A-Z2-7]{55}\b/g,
  /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;&]+/gi,
  /(:\/\/[^:/\s]+:)[^@\s]+(@)/g,
];

/** Strip Stellar secret seeds, bearer tokens, credentials in URLs and key=value secrets. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, pattern) =>
      out.replace(pattern, (match, prefix?: string, suffix?: string) =>
        typeof prefix === 'string' ? `${prefix}[REDACTED]${typeof suffix === 'string' ? suffix : ''}` : '[REDACTED]'
      ),
    text
  );
}

const ms = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

function ageBucket(ageMs: number): AgeBucket {
  if (ageMs < HOUR) return 'under_1h';
  if (ageMs < 24 * HOUR) return '1h_to_24h';
  return 'over_24h';
}

function severityOf(op: PartialOperation, stale: boolean): PartialFailureSeverity {
  if (op.operationType.startsWith('payment.')) return 'critical';
  if (!op.retryable || stale) return 'error';
  return 'warning';
}

function stateOf(op: PartialOperation): PartialFailureState {
  if (ms(op.resolvedAt) !== null) return 'resolved';
  if (ms(op.ignoredAt) !== null) return 'ignored';
  return 'open';
}

export function toPartialFailure(op: PartialOperation, options: PartialFailureOptions): PartialFailure {
  const now = options.now.getTime();
  const staleAfter = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const started = ms(op.startedAt) ?? now;
  const age = Math.max(0, now - started);
  const state = stateOf(op);
  const stale = state === 'open' && age >= staleAfter;

  return {
    id: op.id,
    operationType: op.operationType,
    internalState: op.internalState,
    externalRef: op.externalRef ?? null,
    invoiceId: op.invoiceId ?? null,
    state,
    severity: severityOf(op, stale),
    ageBucket: ageBucket(age),
    ageMinutes: Math.floor(age / 60000),
    stale,
    retryable: op.retryable,
    attempts: op.attempts,
    lastError: op.lastError ? redactSecrets(op.lastError) : null,
    recoveryAction: state !== 'open' ? 'none' : op.retryable ? 'retry' : 'inspect',
    links: {
      inspect: op.invoiceId ? `/invoices/${encodeURIComponent(op.invoiceId)}` : `/operations/${encodeURIComponent(op.id)}`,
      retry: op.retryable && state === 'open' ? `/operations/${encodeURIComponent(op.id)}/retry` : null,
      remediation: `${REMEDIATION_DOC}#${op.operationType.split('.')[0]}`,
    },
  };
}

const SEVERITY_RANK: Record<PartialFailureSeverity, number> = { critical: 0, error: 1, warning: 2 };

export function buildPartialFailureReport(
  operations: PartialOperation[],
  options: PartialFailureOptions
): PartialFailureReport {
  const all = operations.map((op) => toPartialFailure(op, options));
  const unresolved = all
    .filter((f) => f.state === 'open')
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.ageMinutes - a.ageMinutes || a.id.localeCompare(b.id)
    );

  const byOperationType: Record<string, number> = {};
  const bySeverity: Record<PartialFailureSeverity, number> = { critical: 0, error: 0, warning: 0 };
  const byAge: Record<AgeBucket, number> = { under_1h: 0, '1h_to_24h': 0, over_24h: 0 };
  for (const f of unresolved) {
    byOperationType[f.operationType] = (byOperationType[f.operationType] ?? 0) + 1;
    bySeverity[f.severity] += 1;
    byAge[f.ageBucket] += 1;
  }

  return {
    generatedAt: options.now.toISOString(),
    unresolved,
    summary: {
      unresolved: unresolved.length,
      resolved: all.filter((f) => f.state === 'resolved').length,
      ignored: all.filter((f) => f.state === 'ignored').length,
      byOperationType,
      bySeverity,
      byAge,
      retryable: unresolved.filter((f) => f.retryable).length,
    },
  };
}

/**
 * Background jobs as partial operations. Only jobs that have failed at least
 * once count: a dead job is open and not retryable, a queued job with errors is
 * waiting on a retry, and a job that later succeeded is resolved.
 */
export function jobsToOperations(jobs: Job[]): PartialOperation[] {
  return jobs
    .filter((j) => j.status === 'dead' || j.errors.length > 0)
    .map((j) => ({
      id: j.id,
      operationType: `job.${j.type}`,
      internalState: j.status,
      externalRef: j.correlationId,
      invoiceId: typeof j.payload.data.invoiceId === 'string' ? j.payload.data.invoiceId : null,
      startedAt: j.createdAt,
      lastAttemptAt: j.errors.at(-1)?.at ?? null,
      attempts: j.attempts,
      retryable: j.status !== 'dead',
      lastError: j.errors.at(-1)?.message ?? null,
      resolvedAt: j.status === 'succeeded' ? j.completedAt ?? j.updatedAt : null,
    }));
}
