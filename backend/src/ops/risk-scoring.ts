/**
 * Explainable risk scoring for high-impact maintainer actions (#312).
 *
 * Every intent declared through `MaintainerApprovalService` is scored before it
 * is accepted. The score is the sum of a small number of named factors, and the
 * assessment carries every factor that contributed, what was observed and the
 * threshold it crossed — so a maintainer can read *why* an action was escalated
 * or blocked instead of trusting an opaque number.
 *
 * Factors (all counted inside one sliding window, default 10 minutes):
 *
 *   ACTION_BASELINE     inherent impact of the action (two-person actions start higher)
 *   REQUESTER_VELOCITY  intents declared by the same maintainer beyond a free allowance
 *   TARGET_REPETITION   intents against the same target beyond a free allowance
 *   RECENT_FAILURES     the requester's intents that failed or were rejected
 *
 * Levels and what they enforce:
 *
 *   low       < 30   normal flow
 *   elevated  30–49  normal flow, surfaced to the approver
 *   high      50–79  a second maintainer must approve, even for single-approver actions
 *   critical  >= 80  the intent is refused and a signed `rejected` receipt is issued
 *
 * No single behavioural factor can block on its own: the caps are chosen so a
 * block needs at least two independent signals.
 *
 * Complexity: each key keeps a timestamp queue capped at `maxEventsPerKey`, so
 * pruning and scoring are O(1) per call (bounded by the cap) and memory is
 * O(active keys × cap). Keys whose queue empties are deleted; a full sweep runs
 * once every `sweepEvery` records, keeping stale-key cleanup amortised O(1).
 */

export const RISK_POLICY_VERSION = 'risk-v1';

export type RiskLevel = 'low' | 'elevated' | 'high' | 'critical';

export type RiskFactorCode =
  | 'ACTION_BASELINE'
  | 'REQUESTER_VELOCITY'
  | 'TARGET_REPETITION'
  | 'RECENT_FAILURES';

export interface RiskFactor {
  code: RiskFactorCode;
  /** Points this factor added to the score. */
  weight: number;
  /** The measured value (events in window; 1 for the baseline). */
  observed: number;
  /** Observations at or below this value add nothing. */
  allowance: number;
  detail: string;
}

export interface RiskAssessment {
  policyVersion: string;
  /** 0–100. */
  score: number;
  level: RiskLevel;
  /** Only factors with a non-zero weight. */
  factors: RiskFactor[];
  requiresSecondApprover: boolean;
  blocked: boolean;
  windowMs: number;
  evaluatedAt: string;
}

export interface RiskSubject {
  action: string;
  /** Whether the action already requires two maintainers by policy. */
  requiresSecondApprover: boolean;
  requestedBy: string;
  target: string;
}

export interface RiskScorerOptions {
  now?: () => Date;
  windowMs?: number;
  maxEventsPerKey?: number;
  sweepEvery?: number;
}

/** Score bands. Ordered from most to least severe. */
const LEVELS: ReadonlyArray<{ level: RiskLevel; min: number }> = [
  { level: 'critical', min: 80 },
  { level: 'high', min: 50 },
  { level: 'elevated', min: 30 },
  { level: 'low', min: 0 },
];

const BASELINE = { singleApprover: 10, twoPerson: 25 };
const VELOCITY = { allowance: 5, perEvent: 10, cap: 40 };
const REPETITION = { allowance: 1, perEvent: 15, cap: 30 };
const FAILURES = { allowance: 0, perEvent: 10, cap: 30 };

const weightFor = (observed: number, rule: { allowance: number; perEvent: number; cap: number }) =>
  Math.min(rule.cap, Math.max(0, observed - rule.allowance) * rule.perEvent);

export function riskLevelFor(score: number): RiskLevel {
  return (LEVELS.find((band) => score >= band.min) ?? LEVELS[LEVELS.length - 1]).level;
}

/** Sliding-window event counter keyed by string. */
class WindowedCounter {
  private readonly events = new Map<string, number[]>();

  constructor(private readonly windowMs: number, private readonly cap: number) {}

  private prune(key: string, nowMs: number): number[] | undefined {
    const queue = this.events.get(key);
    if (!queue) return undefined;
    const cutoff = nowMs - this.windowMs;
    while (queue.length > 0 && queue[0] <= cutoff) queue.shift();
    if (queue.length === 0) {
      this.events.delete(key);
      return undefined;
    }
    return queue;
  }

  count(key: string, nowMs: number): number {
    return this.prune(key, nowMs)?.length ?? 0;
  }

  record(key: string, nowMs: number): void {
    const queue = this.prune(key, nowMs) ?? [];
    queue.push(nowMs);
    // Weights saturate long before the cap, so dropping the oldest is lossless for scoring.
    if (queue.length > this.cap) queue.shift();
    this.events.set(key, queue);
  }

  sweep(nowMs: number): void {
    for (const key of [...this.events.keys()]) this.prune(key, nowMs);
  }

  get size(): number {
    return this.events.size;
  }
}

export class RiskScorer {
  private readonly now: () => Date;
  readonly windowMs: number;
  private readonly sweepEvery: number;
  private readonly byRequester: WindowedCounter;
  private readonly byTarget: WindowedCounter;
  private readonly failures: WindowedCounter;
  private recordsSinceSweep = 0;

  constructor(options: RiskScorerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.sweepEvery = options.sweepEvery ?? 1_000;
    const cap = options.maxEventsPerKey ?? 64;
    this.byRequester = new WindowedCounter(this.windowMs, cap);
    this.byTarget = new WindowedCounter(this.windowMs, cap);
    this.failures = new WindowedCounter(this.windowMs, cap);
  }

  /** Scores a subject against history recorded so far. Does not record anything. */
  assess(subject: RiskSubject): RiskAssessment {
    const at = this.now();
    const nowMs = at.getTime();
    const windowMinutes = Math.round(this.windowMs / 60_000);

    const priorByRequester = this.byRequester.count(subject.requestedBy, nowMs);
    const priorByTarget = this.byTarget.count(subject.target, nowMs);
    const priorFailures = this.failures.count(subject.requestedBy, nowMs);

    const candidates: RiskFactor[] = [
      {
        code: 'ACTION_BASELINE',
        weight: subject.requiresSecondApprover ? BASELINE.twoPerson : BASELINE.singleApprover,
        observed: 1,
        allowance: 0,
        detail: `${subject.action} is a ${subject.requiresSecondApprover ? 'two-person' : 'single-approver'} high-impact action`,
      },
      {
        code: 'REQUESTER_VELOCITY',
        weight: weightFor(priorByRequester, VELOCITY),
        observed: priorByRequester,
        allowance: VELOCITY.allowance,
        detail: `${priorByRequester} intent(s) by ${subject.requestedBy} in the last ${windowMinutes} min (allowance ${VELOCITY.allowance})`,
      },
      {
        code: 'TARGET_REPETITION',
        weight: weightFor(priorByTarget, REPETITION),
        observed: priorByTarget,
        allowance: REPETITION.allowance,
        detail: `${priorByTarget} intent(s) against ${subject.target} in the last ${windowMinutes} min (allowance ${REPETITION.allowance})`,
      },
      {
        code: 'RECENT_FAILURES',
        weight: weightFor(priorFailures, FAILURES),
        observed: priorFailures,
        allowance: FAILURES.allowance,
        detail: `${priorFailures} failed or rejected intent(s) by ${subject.requestedBy} in the last ${windowMinutes} min`,
      },
    ];

    const factors = candidates.filter((factor) => factor.weight > 0);
    const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.weight, 0));
    const level = riskLevelFor(score);

    return {
      policyVersion: RISK_POLICY_VERSION,
      score,
      level,
      factors,
      requiresSecondApprover: level === 'high' || level === 'critical',
      blocked: level === 'critical',
      windowMs: this.windowMs,
      evaluatedAt: at.toISOString(),
    };
  }

  /** Records a declared (or refused) intent. */
  recordIntent(requestedBy: string, target: string): void {
    const nowMs = this.now().getTime();
    this.byRequester.record(requestedBy, nowMs);
    this.byTarget.record(target, nowMs);
    this.maybeSweep(nowMs);
  }

  /** Records a failed or rejected outcome against the requester. */
  recordFailure(requestedBy: string): void {
    const nowMs = this.now().getTime();
    this.failures.record(requestedBy, nowMs);
    this.maybeSweep(nowMs);
  }

  /** Keys currently held, across all counters. Exposed for memory-bound tests. */
  get trackedKeys(): number {
    return this.byRequester.size + this.byTarget.size + this.failures.size;
  }

  private maybeSweep(nowMs: number): void {
    if (++this.recordsSinceSweep < this.sweepEvery) return;
    this.recordsSinceSweep = 0;
    this.byRequester.sweep(nowMs);
    this.byTarget.sweep(nowMs);
    this.failures.sweep(nowMs);
  }
}
