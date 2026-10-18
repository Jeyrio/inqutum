/**
 * External dependency degradation matrix.
 *
 * Every critical third-party dependency is listed with:
 *   - the failure modes we know about,
 *   - the user-safe fallback the API/UI applies while it is degraded,
 *   - which user-visible capabilities are affected.
 *
 * The matrix is data, not behaviour. `evaluateDependencies` turns probe results
 * into a status report and `capabilityStatus` answers "may I do X right now?"
 * so handlers can degrade instead of failing hard. The core rule: a degraded
 * dependency must never cause a false positive (e.g. an invoice marked paid
 * without proof, or a notification reported as sent when it was not).
 *
 * See docs/DEPENDENCY-DEGRADATION.md for the operator runbook.
 */

export type DependencyId = 'stellar_horizon' | 'postgres' | 'redis_queue' | 'email_provider';
export type DependencyState = 'healthy' | 'degraded' | 'down' | 'unknown';
export type Capability =
  | 'invoice.create'
  | 'invoice.read'
  | 'payment.verify'
  | 'export.create'
  | 'notification.send'
  | 'job.enqueue';

/** What a caller sees when a capability is unavailable. */
export type FallbackMode =
  /** Accept and finish later; respond 202 with a retry hint. */
  | 'defer'
  /** Serve from a local/cached source; response flagged `degraded: true`. */
  | 'serve_stale'
  /** Refuse with 503 + Retry-After; never guess an answer. */
  | 'refuse';

export interface FailureMode {
  code: string;
  description: string;
  /** Substrings/regex matched against error messages to classify incidents. */
  signature: RegExp;
}

export interface CapabilityFallback {
  capability: Capability;
  mode: FallbackMode;
  /** HTTP status the API returns while degraded. */
  httpStatus: 202 | 200 | 503;
  /** Stable machine code returned to clients. */
  code: string;
  /** Plain-language, secret-free message safe to show a user. */
  userMessage: string;
}

export interface DependencySpec {
  id: DependencyId;
  name: string;
  failureModes: FailureMode[];
  fallbacks: CapabilityFallback[];
  /** Seconds a client should wait before retrying a refused/deferred call. */
  retryAfterSeconds: number;
  /** Probe latency above this marks the dependency degraded (not down). */
  degradedLatencyMs: number;
  runbook: string;
}

const RUNBOOK = 'docs/DEPENDENCY-DEGRADATION.md';

export const DEPENDENCY_MATRIX: readonly DependencySpec[] = [
  {
    id: 'stellar_horizon',
    name: 'Stellar Horizon API',
    retryAfterSeconds: 30,
    degradedLatencyMs: 3000,
    runbook: `${RUNBOOK}#stellar-horizon`,
    failureModes: [
      { code: 'HORIZON_TIMEOUT', description: 'Requests time out or hang', signature: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i },
      { code: 'HORIZON_UNREACHABLE', description: 'DNS/connection failure', signature: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i },
      { code: 'HORIZON_RATE_LIMITED', description: 'HTTP 429 from Horizon', signature: /\b429\b|rate.?limit/i },
      { code: 'HORIZON_5XX', description: 'Horizon returns 5xx', signature: /\b5\d\d\b|bad gateway|service unavailable/i },
    ],
    fallbacks: [
      {
        capability: 'payment.verify',
        mode: 'defer',
        httpStatus: 202,
        code: 'VERIFICATION_DEFERRED',
        userMessage: 'We could not reach the Stellar network to confirm this payment yet. Your invoice is unchanged; we will retry automatically.',
      },
    ],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    retryAfterSeconds: 15,
    degradedLatencyMs: 1000,
    runbook: `${RUNBOOK}#postgres`,
    failureModes: [
      { code: 'DB_UNREACHABLE', description: 'Connection refused or pool exhausted', signature: /ECONNREFUSED|too many clients|pool.*(exhausted|timeout)/i },
      { code: 'DB_READ_ONLY', description: 'Primary failed over; replica is read only', signature: /read-only transaction|cannot execute .* in a read-only/i },
      { code: 'DB_STATEMENT_TIMEOUT', description: 'Queries exceed statement_timeout', signature: /statement timeout|canceling statement/i },
    ],
    fallbacks: [
      { capability: 'invoice.create', mode: 'refuse', httpStatus: 503, code: 'STORAGE_UNAVAILABLE', userMessage: 'Invoices cannot be created right now. Nothing was saved; please try again shortly.' },
      { capability: 'invoice.read', mode: 'refuse', httpStatus: 503, code: 'STORAGE_UNAVAILABLE', userMessage: 'Invoice data is temporarily unavailable. Please try again shortly.' },
      { capability: 'payment.verify', mode: 'refuse', httpStatus: 503, code: 'STORAGE_UNAVAILABLE', userMessage: 'Payments cannot be confirmed right now. Your payment is safe on-chain; please retry shortly.' },
      { capability: 'export.create', mode: 'refuse', httpStatus: 503, code: 'STORAGE_UNAVAILABLE', userMessage: 'Exports are temporarily unavailable. Please try again shortly.' },
    ],
  },
  {
    id: 'redis_queue',
    name: 'Redis / job queue',
    retryAfterSeconds: 10,
    degradedLatencyMs: 500,
    runbook: `${RUNBOOK}#redis-queue`,
    failureModes: [
      { code: 'QUEUE_UNREACHABLE', description: 'Redis connection refused', signature: /ECONNREFUSED|Connection is closed|ENOTFOUND/i },
      { code: 'QUEUE_READONLY', description: 'Redis replica is read only', signature: /READONLY/ },
      { code: 'QUEUE_OOM', description: 'Redis maxmemory reached', signature: /OOM command not allowed/i },
    ],
    fallbacks: [
      { capability: 'job.enqueue', mode: 'defer', httpStatus: 202, code: 'JOB_DEFERRED', userMessage: 'Your request was accepted and will be processed when background processing recovers.' },
      { capability: 'notification.send', mode: 'defer', httpStatus: 202, code: 'NOTIFICATION_DEFERRED', userMessage: 'Notifications are delayed. They will be delivered once processing recovers.' },
    ],
  },
  {
    id: 'email_provider',
    name: 'Email provider (SMTP/API)',
    retryAfterSeconds: 60,
    degradedLatencyMs: 5000,
    runbook: `${RUNBOOK}#email-provider`,
    failureModes: [
      { code: 'EMAIL_AUTH', description: 'Credentials rejected', signature: /\b535\b|auth(entication)? failed|invalid login/i },
      { code: 'EMAIL_THROTTLED', description: 'Provider throttling', signature: /\b421\b|\b429\b|throttl|rate.?limit/i },
      { code: 'EMAIL_UNREACHABLE', description: 'Provider unreachable', signature: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i },
    ],
    fallbacks: [
      { capability: 'notification.send', mode: 'defer', httpStatus: 202, code: 'EMAIL_DEFERRED', userMessage: 'Email delivery is delayed. The invoice link still works and can be shared directly.' },
    ],
  },
];

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export type DependencyProbe = () => Promise<ProbeResult | void>;

export interface DependencyStatus {
  id: DependencyId;
  name: string;
  state: DependencyState;
  failureMode: string | null;
  latencyMs: number | null;
  /** Redacted error text; never includes credentials. */
  error: string | null;
  affectedCapabilities: Capability[];
  retryAfterSeconds: number;
  runbook: string;
}

export interface DegradationReport {
  generatedAt: string;
  overall: DependencyState;
  dependencies: DependencyStatus[];
}

const REDACT: RegExp[] = [
  /\bS[A-Z2-7]{55}\b/g,
  /(:\/\/[^:/\s]+:)[^@\s]+@/g,
  /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi,
];

export function redactError(text: string): string {
  return REDACT.reduce(
    (out, re) => out.replace(re, (_m, p?: string) => (typeof p === 'string' ? `${p}[REDACTED]${_m.endsWith('@') ? '@' : ''}` : '[REDACTED]')),
    text
  ).slice(0, 300);
}

export function specFor(id: DependencyId): DependencySpec {
  const spec = DEPENDENCY_MATRIX.find((d) => d.id === id);
  if (!spec) throw new Error(`Unknown dependency ${id}`);
  return spec;
}

/** Map an error message to a known failure mode code, or 'UNCLASSIFIED'. */
export function classifyFailure(id: DependencyId, message: string): string {
  return specFor(id).failureModes.find((f) => f.signature.test(message))?.code ?? 'UNCLASSIFIED';
}

export function evaluateDependency(id: DependencyId, probe: ProbeResult | null): DependencyStatus {
  const spec = specFor(id);
  const base = {
    id,
    name: spec.name,
    retryAfterSeconds: spec.retryAfterSeconds,
    runbook: spec.runbook,
  };
  if (!probe) {
    return { ...base, state: 'unknown', failureMode: null, latencyMs: null, error: null, affectedCapabilities: [] };
  }
  const latency = typeof probe.latencyMs === 'number' ? probe.latencyMs : null;
  if (!probe.ok) {
    const msg = probe.error ?? 'probe failed';
    return {
      ...base,
      state: 'down',
      failureMode: classifyFailure(id, msg),
      latencyMs: latency,
      error: redactError(msg),
      affectedCapabilities: spec.fallbacks.map((f) => f.capability),
    };
  }
  const slow = latency !== null && latency > spec.degradedLatencyMs;
  return {
    ...base,
    state: slow ? 'degraded' : 'healthy',
    failureMode: slow ? 'SLOW_RESPONSE' : null,
    latencyMs: latency,
    error: null,
    affectedCapabilities: [],
  };
}

const RANK: Record<DependencyState, number> = { healthy: 0, unknown: 1, degraded: 2, down: 3 };

/** Run probes with a hard timeout each; a hung probe counts as down. */
export async function runDependencyChecks(
  probes: Partial<Record<DependencyId, DependencyProbe>>,
  options: { timeoutMs?: number; now?: () => Date } = {}
): Promise<DegradationReport> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? (() => new Date());
  const dependencies = await Promise.all(
    DEPENDENCY_MATRIX.map(async (spec) => {
      const probe = probes[spec.id];
      if (!probe) return evaluateDependency(spec.id, null);
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          probe(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        const latencyMs = (result && typeof result.latencyMs === 'number') ? result.latencyMs : Date.now() - started;
        return evaluateDependency(spec.id, { ok: result ? result.ok : true, latencyMs, error: result ? result.error : undefined });
      } catch (err) {
        return evaluateDependency(spec.id, {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );
  const overall = dependencies.reduce<DependencyState>(
    (worst, d) => (RANK[d.state] > RANK[worst] ? d.state : worst),
    'healthy'
  );
  return { generatedAt: now().toISOString(), overall, dependencies };
}

export interface CapabilityDecision {
  capability: Capability;
  allowed: boolean;
  /** Present when `allowed` is false or the response must be flagged degraded. */
  fallback: (CapabilityFallback & { dependency: DependencyId; retryAfterSeconds: number }) | null;
}

/**
 * Decide how a capability behaves given the current report. The most severe
 * fallback wins: refuse > defer > serve_stale. Unknown/degraded dependencies
 * do not block (fail-open on observability, fail-closed on real outage).
 */
export function capabilityStatus(report: DegradationReport, capability: Capability): CapabilityDecision {
  const order: Record<FallbackMode, number> = { serve_stale: 0, defer: 1, refuse: 2 };
  let chosen: CapabilityDecision['fallback'] = null;
  for (const dep of report.dependencies) {
    if (dep.state !== 'down') continue;
    const fb = specFor(dep.id).fallbacks.find((f) => f.capability === capability);
    if (!fb) continue;
    if (!chosen || order[fb.mode] > order[chosen.mode]) {
      chosen = { ...fb, dependency: dep.id, retryAfterSeconds: dep.retryAfterSeconds };
    }
  }
  return { capability, allowed: chosen === null, fallback: chosen };
}

/**
 * Matrix self-check used by tests and `/ops/dependencies/matrix`: every
 * dependency must document failure modes, a runbook anchor, and fallbacks with
 * user-safe messages (no stack traces, hosts or credentials).
 */
export function validateMatrix(matrix: readonly DependencySpec[] = DEPENDENCY_MATRIX): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const dep of matrix) {
    if (seen.has(dep.id)) problems.push(`${dep.id}: duplicate entry`);
    seen.add(dep.id);
    if (dep.failureModes.length === 0) problems.push(`${dep.id}: no failure modes documented`);
    if (dep.fallbacks.length === 0) problems.push(`${dep.id}: no fallback behaviour documented`);
    if (!dep.runbook.includes('#')) problems.push(`${dep.id}: runbook must link to an anchor`);
    for (const fb of dep.fallbacks) {
      if (/https?:\/\/|stack|Error:|ECONN|password|token/i.test(fb.userMessage)) {
        problems.push(`${dep.id}/${fb.capability}: user message leaks internals`);
      }
      if (fb.mode === 'refuse' && fb.httpStatus !== 503) problems.push(`${dep.id}/${fb.capability}: refuse must be 503`);
      if (fb.mode === 'defer' && fb.httpStatus !== 202) problems.push(`${dep.id}/${fb.capability}: defer must be 202`);
    }
  }
  return problems;
}
