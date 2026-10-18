/**
 * Bounded-retry JSON probe shared by the release gate (#313) and contributor
 * diagnostics (#311).
 *
 * Only idempotent GETs go through here. Each attempt is classified:
 *
 *   2xx with JSON       success
 *   2xx without JSON    retried (e.g. an interstitial page while a host wakes up), then `invalid_body`
 *   401 / 403           `unauthorized` — never retried, credentials will not fix themselves
 *   429, 502, 503, 504  retried with exponential backoff (a `Retry-After` header wins, capped)
 *   network / timeout   retried the same way
 *   any other status    `client_error` / `server_error` — not retried
 *
 * Time: O(maxAttempts) requests, worst-case wall time is
 * maxAttempts × timeoutMs + Σ backoff (bounded by maxDelayMs per gap).
 * Space: O(1) apart from the last response body.
 */

export type ProbeFailureReason = 'unauthorized' | 'client_error' | 'server_error' | 'unreachable' | 'invalid_body';

export type ProbeResult =
  | { ok: true; status: number; body: any; attempts: number }
  | { ok: false; reason: ProbeFailureReason; status: number | null; body: any; attempts: number; message: string };

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Used to resolve HTTP-date Retry-After values. */
  now?: () => number;
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Delay before the next attempt (attempt is 1-based). `Retry-After` may be
 * delay-seconds or an HTTP-date (RFC 9110 §10.2.3); either is capped at maxDelayMs.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfter?: string | null,
  now: () => number = Date.now
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const fromHeader = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
    if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.min(fromHeader, maxDelayMs);
  }
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

/** Loopback hosts may use plain HTTP (local stacks and tests); everything else must be HTTPS. */
export function isAllowedProbeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function probeJson(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let last: Extract<ProbeResult, { ok: false }> = {
    ok: false, reason: 'unreachable', status: null, body: null, attempts: 0, message: 'not attempted',
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryAfter: string | null = null;
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => undefined);

      if (response.ok) {
        if (body !== undefined) return { ok: true, status: response.status, body, attempts: attempt };
        last = { ok: false, reason: 'invalid_body', status: response.status, body: null, attempts: attempt, message: `GET ${url} returned non-JSON` };
      } else {
        const failure = { status: response.status, body: body ?? null, attempts: attempt, message: `GET ${url} -> HTTP ${response.status}` };
        if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized', ...failure };
        if (!RETRYABLE_STATUSES.has(response.status)) {
          return { ok: false, reason: response.status >= 500 ? 'server_error' : 'client_error', ...failure };
        }
        retryAfter = response.headers.get('retry-after');
        last = { ok: false, reason: 'server_error', ...failure };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      last = { ok: false, reason: 'unreachable', status: null, body: null, attempts: attempt, message: `GET ${url} failed: ${detail}` };
    }

    if (attempt < maxAttempts) await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, retryAfter, options.now));
  }
  return last;
}
