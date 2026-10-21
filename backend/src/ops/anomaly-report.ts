/**
 * Read-only anomaly detection report (#195).
 *
 * Turns a window of activity (audit events, normalized to `ActivityRecord`) into
 * findings that highlight unusual usage before it becomes an incident or abuse.
 * The report is a pure function of its input and options: no clock, no storage
 * writes, no side effects, and identical input yields an identical report.
 *
 * Signals:
 *   VOLUME_SPIKE      a resource's hourly event count is far above the rest of its own history
 *   TIMING_BURST      one actor fires many events at one resource within seconds
 *   ACTOR_REPETITION  one actor repeats the same action on one resource
 *   ACTOR_FANOUT      one actor touches many distinct resources in a short window
 *   REPEATED_FAILURE  one actor keeps failing against one resource
 *
 * False-positive mitigation is built in rather than bolted on: absolute minimum
 * counts, a robust (median + MAD) baseline that excludes the bucket under test, a
 * minimum amount of history before spikes are judged, an allow-list for known
 * automation actors, and explicit time-boxed suppressions that are reported
 * back so nothing is hidden silently. See docs/ANOMALY_REPORT.md.
 */
import { createHash } from 'crypto';
import type { AuditEvent } from '../audit/audit-service';

export const ANOMALY_SIGNALS = [
  'VOLUME_SPIKE',
  'TIMING_BURST',
  'ACTOR_REPETITION',
  'ACTOR_FANOUT',
  'REPEATED_FAILURE',
] as const;
export type AnomalySignal = (typeof ANOMALY_SIGNALS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ActivityRecord {
  id: string;
  /** ISO-8601. */
  timestamp: string;
  actor: string;
  /** Affected resource, e.g. `invoice:abc` or `system:jobs`. */
  resource: string;
  action: string;
  outcome: 'success' | 'failure';
}

export interface AnomalySuppression {
  signal: AnomalySignal;
  /** Exact resource to suppress, or `*` for every resource. */
  resource: string;
  /** Why this is expected; required so suppressions stay reviewable. */
  reason: string;
  /** ISO timestamp after which the suppression lapses. */
  until: string;
}

export interface AnomalyOptions {
  /** Report clock; used only to expire suppressions. Defaults to the newest record. */
  now?: Date;
  bucketMs: number;
  /** Other buckets needed before a spike is judged. */
  minBaselineBuckets: number;
  spikeMinCount: number;
  spikeRatio: number;
  spikeMadMultiplier: number;
  burstWindowMs: number;
  burstMinEvents: number;
  repetitionWindowMs: number;
  repetitionMinEvents: number;
  fanoutWindowMs: number;
  fanoutMinResources: number;
  failureMinConsecutive: number;
  /** Known automation (workers, monitors) whose volume is expected. Their records are ignored. */
  ignoreActors: string[];
  suppressions: AnomalySuppression[];
}

export const DEFAULT_ANOMALY_OPTIONS: Readonly<AnomalyOptions> = Object.freeze({
  bucketMs: 3_600_000,
  minBaselineBuckets: 6,
  spikeMinCount: 20,
  spikeRatio: 5,
  spikeMadMultiplier: 6,
  burstWindowMs: 10_000,
  burstMinEvents: 8,
  repetitionWindowMs: 3_600_000,
  repetitionMinEvents: 12,
  fanoutWindowMs: 600_000,
  fanoutMinResources: 10,
  failureMinConsecutive: 5,
  ignoreActors: [],
  suppressions: [],
});

export interface AnomalyFinding {
  /** Stable across runs for the same signal/resource/actor/window start. */
  id: string;
  signal: AnomalySignal;
  severity: Severity;
  resource: string;
  actors: string[];
  observed: number;
  threshold: number;
  /** Normal level for this signal where one exists (e.g. median hourly count). */
  baseline: number | null;
  windowStart: string;
  windowEnd: string;
  explanation: string;
  /** First triage step; the full runbook is docs/ANOMALY_REPORT.md. */
  triage: string;
  /** Up to 10 event ids that triggered the finding. */
  evidence: string[];
}

export interface AnomalyReport {
  generatedFor: { from: string | null; to: string | null; records: number };
  summary: Record<Severity, number> & { total: number };
  findings: AnomalyFinding[];
  bySeverity: Record<Severity, AnomalyFinding[]>;
  byResource: Array<{ resource: string; worstSeverity: Severity; findings: AnomalyFinding[] }>;
  suppressed: Array<{ signal: AnomalySignal; resource: string; reason: string; count: number }>;
  ignoredActors: Record<string, number>;
}

const TRIAGE: Record<AnomalySignal, string> = {
  VOLUME_SPIKE: 'Compare with deploys, imports and scheduled jobs in the same hour; if unexplained, inspect the evidence events for a common actor.',
  TIMING_BURST: 'Check whether the actor is a script or integration; confirm rate limits applied and consider revoking its session.',
  ACTOR_REPETITION: 'Look for a retry loop or stuck client; if the actor is a person, contact them before taking action.',
  ACTOR_FANOUT: 'Treat as possible enumeration: review which resources were touched and whether the actor is authorized for all of them.',
  REPEATED_FAILURE: 'Read the failure reasons on the evidence events; a permission or validation failure usually means a misconfigured client, a probing actor otherwise.',
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** observed/threshold -> severity. 1.0 means "just crossed the line". */
export function severityForRatio(ratio: number): Severity {
  if (ratio >= 4) return 'critical';
  if (ratio >= 2.5) return 'high';
  if (ratio >= 1.5) return 'medium';
  return 'low';
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function baselineStats(values: number[]): { median: number; mad: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const med = median(sorted);
  const mad = median(values.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
  return { median: med, mad };
}

const fid = (...parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const byTimeThenId = (a: ActivityRecord, b: ActivityRecord) =>
  Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id);

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function buildAnomalyReport(input: ActivityRecord[], overrides: Partial<AnomalyOptions> = {}): AnomalyReport {
  const opts: AnomalyOptions = { ...DEFAULT_ANOMALY_OPTIONS, ...overrides };
  const valid = input.filter((r) => Number.isFinite(Date.parse(r.timestamp)));
  const ignored = new Set(opts.ignoreActors);
  const ignoredActors: Record<string, number> = {};
  const records = valid
    .filter((r) => {
      if (!ignored.has(r.actor)) return true;
      ignoredActors[r.actor] = (ignoredActors[r.actor] ?? 0) + 1;
      return false;
    })
    .sort(byTimeThenId);

  const found: AnomalyFinding[] = [];
  const byResource = groupBy(records, (r) => r.resource);

  // --- VOLUME_SPIKE ----------------------------------------------------------
  for (const [resource, rows] of byResource) {
    const first = Math.floor(Date.parse(rows[0].timestamp) / opts.bucketMs);
    const last = Math.floor(Date.parse(rows[rows.length - 1].timestamp) / opts.bucketMs);
    // Bucket span is capped so one stray ancient record cannot allocate millions of zero buckets.
    if (last - first + 1 > 24 * 90) continue;
    const buckets: ActivityRecord[][] = Array.from({ length: last - first + 1 }, () => []);
    for (const r of rows) buckets[Math.floor(Date.parse(r.timestamp) / opts.bucketMs) - first].push(r);

    buckets.forEach((bucket, i) => {
      const others = buckets.flatMap((b, j) => (j === i ? [] : [b.length]));
      if (others.length < opts.minBaselineBuckets || bucket.length < opts.spikeMinCount) return;
      const { median: med, mad } = baselineStats(others);
      const threshold = Math.max(
        opts.spikeMinCount,
        Math.ceil(Math.max(med, 1) * opts.spikeRatio),
        Math.ceil(med + opts.spikeMadMultiplier * 1.4826 * mad)
      );
      if (bucket.length < threshold) return;
      const start = new Date((first + i) * opts.bucketMs).toISOString();
      found.push({
        id: fid('VOLUME_SPIKE', resource, start),
        signal: 'VOLUME_SPIKE',
        severity: severityForRatio(bucket.length / threshold),
        resource,
        actors: [...new Set(bucket.map((r) => r.actor))].sort(),
        observed: bucket.length,
        threshold,
        baseline: med,
        windowStart: start,
        windowEnd: new Date((first + i + 1) * opts.bucketMs).toISOString(),
        explanation: `${bucket.length} events in one hour against a normal ${med} (alert threshold ${threshold}).`,
        triage: TRIAGE.VOLUME_SPIKE,
        evidence: bucket.slice(0, 10).map((r) => r.id),
      });
    });
  }

  // --- per actor+resource signals -------------------------------------------
  const pairs = groupBy(records, (r) => `${r.actor}\u0000${r.resource}`);
  for (const rows of pairs.values()) {
    const { actor, resource } = rows[0];

    // TIMING_BURST: densest sliding window
    let lo = 0;
    let bestStart = 0;
    let bestCount = 0;
    for (let hi = 0; hi < rows.length; hi++) {
      while (Date.parse(rows[hi].timestamp) - Date.parse(rows[lo].timestamp) > opts.burstWindowMs) lo++;
      if (hi - lo + 1 > bestCount) {
        bestCount = hi - lo + 1;
        bestStart = lo;
      }
    }
    if (bestCount >= opts.burstMinEvents) {
      const win = rows.slice(bestStart, bestStart + bestCount);
      found.push({
        id: fid('TIMING_BURST', actor, resource, win[0].timestamp),
        signal: 'TIMING_BURST',
        severity: severityForRatio(bestCount / opts.burstMinEvents),
        resource,
        actors: [actor],
        observed: bestCount,
        threshold: opts.burstMinEvents,
        baseline: null,
        windowStart: win[0].timestamp,
        windowEnd: win[win.length - 1].timestamp,
        explanation: `${actor} produced ${bestCount} events on ${resource} within ${opts.burstWindowMs / 1000}s.`,
        triage: TRIAGE.TIMING_BURST,
        evidence: win.slice(0, 10).map((r) => r.id),
      });
    }

    // ACTOR_REPETITION: same action repeated inside the repetition window
    for (const [action, same] of groupBy(rows, (r) => r.action)) {
      let from = 0;
      let top: ActivityRecord[] = [];
      for (let to = 0; to < same.length; to++) {
        while (Date.parse(same[to].timestamp) - Date.parse(same[from].timestamp) > opts.repetitionWindowMs) from++;
        if (to - from + 1 > top.length) top = same.slice(from, to + 1);
      }
      if (top.length < opts.repetitionMinEvents) continue;
      found.push({
        id: fid('ACTOR_REPETITION', actor, resource, action, top[0].timestamp),
        signal: 'ACTOR_REPETITION',
        severity: severityForRatio(top.length / opts.repetitionMinEvents),
        resource,
        actors: [actor],
        observed: top.length,
        threshold: opts.repetitionMinEvents,
        baseline: null,
        windowStart: top[0].timestamp,
        windowEnd: top[top.length - 1].timestamp,
        explanation: `${actor} performed ${action} ${top.length} times on ${resource} within ${Math.round(opts.repetitionWindowMs / 60_000)} minutes.`,
        triage: TRIAGE.ACTOR_REPETITION,
        evidence: top.slice(0, 10).map((r) => r.id),
      });
    }

    // REPEATED_FAILURE: longest run of consecutive failures (a success resets the run)
    let run: ActivityRecord[] = [];
    let longest: ActivityRecord[] = [];
    for (const r of rows) {
      run = r.outcome === 'failure' ? [...run, r] : [];
      if (run.length > longest.length) longest = run;
    }
    if (longest.length >= opts.failureMinConsecutive) {
      found.push({
        id: fid('REPEATED_FAILURE', actor, resource, longest[0].timestamp),
        signal: 'REPEATED_FAILURE',
        severity: severityForRatio(longest.length / opts.failureMinConsecutive),
        resource,
        actors: [actor],
        observed: longest.length,
        threshold: opts.failureMinConsecutive,
        baseline: null,
        windowStart: longest[0].timestamp,
        windowEnd: longest[longest.length - 1].timestamp,
        explanation: `${longest.length} consecutive failures by ${actor} against ${resource}.`,
        triage: TRIAGE.REPEATED_FAILURE,
        evidence: longest.slice(0, 10).map((r) => r.id),
      });
    }
  }

  // --- ACTOR_FANOUT ----------------------------------------------------------
  for (const [actor, rows] of groupBy(records, (r) => r.actor)) {
    let lo = 0;
    const inWindow = new Map<string, number>();
    let best: { start: number; end: number; resources: number } | null = null;
    for (let hi = 0; hi < rows.length; hi++) {
      inWindow.set(rows[hi].resource, (inWindow.get(rows[hi].resource) ?? 0) + 1);
      while (Date.parse(rows[hi].timestamp) - Date.parse(rows[lo].timestamp) > opts.fanoutWindowMs) {
        const n = (inWindow.get(rows[lo].resource) ?? 1) - 1;
        if (n === 0) inWindow.delete(rows[lo].resource);
        else inWindow.set(rows[lo].resource, n);
        lo++;
      }
      if (inWindow.size >= opts.fanoutMinResources && (!best || inWindow.size > best.resources)) {
        best = { start: lo, end: hi, resources: inWindow.size };
      }
    }
    if (best) {
      const win = rows.slice(best.start, best.end + 1);
      found.push({
        id: fid('ACTOR_FANOUT', actor, win[0].timestamp),
        signal: 'ACTOR_FANOUT',
        severity: severityForRatio(best.resources / opts.fanoutMinResources),
        resource: `actor:${actor}`,
        actors: [actor],
        observed: best.resources,
        threshold: opts.fanoutMinResources,
        baseline: null,
        windowStart: win[0].timestamp,
        windowEnd: win[win.length - 1].timestamp,
        explanation: `${actor} touched ${best.resources} distinct resources within ${opts.fanoutWindowMs / 60_000} minutes.`,
        triage: TRIAGE.ACTOR_FANOUT,
        evidence: win.slice(0, 10).map((r) => r.id),
      });
    }
  }

  // --- suppressions -----------------------------------------------------------
  const nowMs = (opts.now ?? new Date(records.length ? Date.parse(records[records.length - 1].timestamp) : 0)).getTime();
  const active = opts.suppressions.filter((s) => s.reason?.trim() && Date.parse(s.until) > nowMs);
  const suppressedCounts = new Map<string, { signal: AnomalySignal; resource: string; reason: string; count: number }>();
  const kept = found.filter((f) => {
    const hit = active.find((s) => s.signal === f.signal && (s.resource === '*' || s.resource === f.resource));
    if (!hit) return true;
    const key = `${hit.signal}|${hit.resource}`;
    const entry = suppressedCounts.get(key) ?? { signal: hit.signal, resource: hit.resource, reason: hit.reason, count: 0 };
    entry.count++;
    suppressedCounts.set(key, entry);
    return false;
  });

  kept.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.resource.localeCompare(b.resource) ||
      a.signal.localeCompare(b.signal) ||
      a.windowStart.localeCompare(b.windowStart) ||
      a.id.localeCompare(b.id)
  );

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, kept.filter((f) => f.severity === s)])) as Record<Severity, AnomalyFinding[]>;
  const resourceGroups = [...groupBy(kept, (f) => f.resource)].map(([resource, findings]) => ({
    resource,
    worstSeverity: findings[0].severity, // `kept` is severity-sorted
    findings,
  }));
  resourceGroups.sort((a, b) => SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity] || a.resource.localeCompare(b.resource));

  return {
    generatedFor: {
      from: records.length ? records[0].timestamp : null,
      to: records.length ? records[records.length - 1].timestamp : null,
      records: records.length,
    },
    summary: {
      critical: bySeverity.critical.length,
      high: bySeverity.high.length,
      medium: bySeverity.medium.length,
      low: bySeverity.low.length,
      total: kept.length,
    },
    findings: kept,
    bySeverity,
    byResource: resourceGroups,
    suppressed: [...suppressedCounts.values()],
    ignoredActors,
  };
}

const FAILURE_ACTION = /(BLOCKED|REJECTED|FAILED|DENIED)/;
const FAILURE_OUTCOMES = new Set(['failed', 'failure', 'rejected', 'denied', 'blocked']);

/** Normalizes the audit trail into activity records. Failure is read from the action name or `metadata.outcome`. */
export function auditEventsToActivity(events: AuditEvent[]): ActivityRecord[] {
  return events.map((e) => {
    const outcome = String(e.metadata?.outcome ?? '').toLowerCase();
    return {
      id: e.id,
      timestamp: e.timestamp,
      actor: e.actor.id,
      resource: `${e.scope.entityType}:${e.scope.entityId}`,
      action: e.action,
      outcome: FAILURE_ACTION.test(e.action) || FAILURE_OUTCOMES.has(outcome) ? 'failure' : 'success',
    };
  });
}
