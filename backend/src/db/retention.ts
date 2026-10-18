/**
 * Data retention policy (#61).
 *
 * Operational data accumulated without a policy: audit events, telemetry,
 * export artifacts and support evidence were all kept either forever (Postgres)
 * or until an in-memory buffer happened to evict them (a 2000-entry ring is not
 * a retention decision). The issue asks for explicit behaviour — long enough
 * for audits and support, without indefinite accumulation.
 *
 * The policy is **data**, and the planner is a **pure function**:
 *
 *   RETENTION_POLICY  what each data class is, how long it lives, and why
 *   planRetention()   records in -> what is eligible, what is protected, why
 *
 * That split is deliberate. A cleanup job that decides what to delete is a
 * destructive script with no test coverage, so instead the decision is a pure
 * function over an injected clock, and the job only executes a decision it was
 * given. Every window in the policy is a documented, testable number.
 *
 * Protection is layered, and protection always wins:
 *
 *   1. Financial settlement — anything a `PAID` invoice depends on is never
 *      eligible, at any age. This is a ledger, not a cache.
 *   2. Legal hold — `metadata.legal_hold` or `under_dispute` / `under_audit`
 *      pins a record regardless of class or age.
 *   3. Class window — only then does the retention window apply.
 *
 * The repository has no disputes table, so holds are expressed through the
 * `metadata` JSONB column that already exists on `invoices`. That is a
 * convention, and it is called out in docs/DATA_RETENTION.md as a place for a
 * maintainer to plug in a real case-management integration later; inventing a
 * dispute subsystem here would have been a larger change than the issue asks
 * for, and a worse one to review.
 */

import type { JobPayload } from '../jobs/job-types';

/** A category of operational data with one retention rule. */
export type RetentionClass =
  | 'settlement'
  | 'invoice_lifecycle'
  | 'payment_event'
  | 'audit_trail'
  | 'telemetry'
  | 'export_artifact'
  | 'support_evidence'
  | 'job_history';

export interface RetentionRule {
  class: RetentionClass;
  /**
   * Days to keep after the record's age anchor. `null` means keep
   * indefinitely — reserved for settlement evidence.
   */
  retainDays: number | null;
  /** What the age anchor is, per class. */
  ageAnchor: 'created_at' | 'processed_at' | 'generated_at' | 'completed_at';
  /** Whether a cleanup job may delete records in this class. */
  purgeable: boolean;
  /** Why this number. Reviewers should be able to argue with it. */
  rationale: string;
}

export const RETENTION_POLICY: Record<RetentionClass, RetentionRule> = {
  settlement: {
    class: 'settlement',
    retainDays: null,
    ageAnchor: 'created_at',
    purgeable: false,
    rationale:
      'Transactions are the evidence a payment happened. Retained indefinitely and never purged: a deleted transaction cannot be reconstructed from the network, and invoice amounts are reported against them.',
  },
  invoice_lifecycle: {
    class: 'invoice_lifecycle',
    retainDays: 730,
    ageAnchor: 'created_at',
    purgeable: true,
    rationale:
      'Unsettled invoices (EXPIRED / CANCELLED) are kept two years — long enough for support and tax-reconciliation questions, short enough that the table does not grow without bound. PAID invoices are settlement-linked and therefore protected, not aged out.',
  },
  payment_event: {
    class: 'payment_event',
    retainDays: 730,
    ageAnchor: 'created_at',
    purgeable: true,
    rationale:
      'Two years, matching the invoices they describe, so a timeline never has a hole in the middle. Events for protected invoices are retained regardless of age.',
  },
  audit_trail: {
    class: 'audit_trail',
    retainDays: 365,
    ageAnchor: 'created_at',
    purgeable: true,
    rationale:
      'One year of activity history, which covers a full support cycle. The Postgres audit buffer is already bounded at 5000 entries; this window governs durable copies.',
  },
  telemetry: {
    class: 'telemetry',
    retainDays: 30,
    ageAnchor: 'created_at',
    purgeable: true,
    rationale:
      'Thirty days answers "is this endpoint getting slower" and nothing longer. Telemetry has no audit value once the incident it described is closed, and it is the highest-volume class.',
  },
  export_artifact: {
    class: 'export_artifact',
    retainDays: 7,
    ageAnchor: 'generated_at',
    purgeable: true,
    rationale:
      'Generated documents contain the invoice data they were built from, so they must not outlive it. Seven days comfortably covers download and re-request.',
  },
  support_evidence: {
    class: 'support_evidence',
    retainDays: 90,
    ageAnchor: 'created_at',
    purgeable: true,
    rationale:
      'Ninety days is the support follow-up window, including bounce and impersonation evidence. Long enough to settle a dispute about what was sent and to whom.',
  },
  job_history: {
    class: 'job_history',
    retainDays: 30,
    ageAnchor: 'completed_at',
    purgeable: true,
    rationale:
      'Thirty days of completed and dead jobs is enough to investigate a failure. Dead-lettered jobs are the exception worth keeping longer, so they get their own longer window below.',
  },
};

/** Dead-lettered jobs keep their full error history; see docs/JOBS.md. */
export const DEAD_JOB_RETENTION_DAYS = 90;

/** Class assigned to each database table. */
export const TABLE_CLASS: Record<string, RetentionClass> = {
  invoices: 'invoice_lifecycle',
  transactions: 'settlement',
  payment_events: 'payment_event',
  jobs: 'job_history',
};

export type ProtectionReason =
  | 'financial_settlement'
  | 'legal_hold'
  | 'within_retention_window'
  | 'class_not_purgeable'
  | 'dead_letter_hold';

export interface RetentionRecord {
  table: string;
  id: string;
  /** ISO timestamp of the record's age anchor. */
  ageAnchor: string;
  /** Invoice status, for the tables that have one. */
  status?: string | null;
  /** True when a transaction or settlement record depends on this row. */
  settlementLinked?: boolean;
  /** contents of the `metadata` JSONB column, if any. */
  metadata?: Record<string, unknown> | null;
  /** True for a dead-lettered job. */
  deadLetter?: boolean;
}

export interface ProtectionVerdict {
  protected: boolean;
  reason?: ProtectionReason;
  detail?: string;
  /** The instant this record becomes eligible, or null when never. */
  eligibleAt: string | null;
}

export interface ClassifiedRecord {
  record: RetentionRecord;
  class: RetentionClass;
  verdict: ProtectionVerdict;
}

/** Metadata keys that pin a record regardless of age. */
const HOLD_KEYS = ['legal_hold', 'under_dispute', 'under_audit'] as const;

export function hasLegalHold(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  return HOLD_KEYS.some((key) => metadata[key] === true || metadata[key] === 'true');
}

/**
 * Decides whether one record is protected, and if it is eligible, when.
 *
 * Order matters: settlement and legal hold are checked before the retention
 * window so that age can never override them.
 */
export function classifyRecord(record: RetentionRecord, now: Date = new Date()): ClassifiedRecord {
  const retentionClass = TABLE_CLASS[record.table];
  if (!retentionClass) {
    return {
      record,
      class: 'audit_trail',
      verdict: {
        protected: true,
        reason: 'class_not_purgeable',
        detail: `table "${record.table}" is not in TABLE_CLASS, so no retention rule applies`,
        eligibleAt: null,
      },
    };
  }

  const rule = RETENTION_POLICY[retentionClass];

  // 1. Financial settlement is never eligible, whatever the age.
  if (retentionClass === 'settlement' || record.settlementLinked) {
    return {
      record,
      class: retentionClass,
      verdict: {
        protected: true,
        reason: 'financial_settlement',
        detail: record.settlementLinked
          ? 'a transaction or settlement record depends on this row'
          : 'settlement evidence is retained indefinitely',
        eligibleAt: null,
      },
    };
  }

  // 2. A hold pins the record regardless of class or age.
  if (hasLegalHold(record.metadata)) {
    return {
      record,
      class: retentionClass,
      verdict: {
        protected: true,
        reason: 'legal_hold',
        detail: `metadata carries one of: ${HOLD_KEYS.join(', ')}`,
        eligibleAt: null,
      },
    };
  }

  // 3. Dead-lettered jobs get a longer window than ordinary job history.
  const days = record.deadLetter ? DEAD_JOB_RETENTION_DAYS : (rule.retainDays ?? 0);

  if (rule.retainDays === null && !record.deadLetter) {
    return {
      record,
      class: retentionClass,
      verdict: {
        protected: true,
        reason: 'class_not_purgeable',
        detail: rule.rationale,
        eligibleAt: null,
      },
    };
  }

  const anchor = Date.parse(record.ageAnchor);
  if (Number.isNaN(anchor)) {
    // An unparseable anchor is not evidence of age. Protect rather than guess:
    // the cost of keeping a row is far lower than the cost of deleting a
    // financial record that was merely mis-anchored.
    return {
      record,
      class: retentionClass,
      verdict: {
        protected: true,
        reason: 'class_not_purgeable',
        detail: `age anchor "${record.ageAnchor}" is not a valid timestamp`,
        eligibleAt: null,
      },
    };
  }

  const eligibleAt = new Date(anchor + days * 24 * 60 * 60 * 1000);
  const eligible = now.getTime() >= eligibleAt.getTime();

  return {
    record,
    class: retentionClass,
    verdict: {
      protected: !eligible,
      reason: eligible ? undefined : 'within_retention_window',
      detail: eligible
        ? `older than the ${days}-day ${retentionClass} window`
        : `retained until ${eligibleAt.toISOString().slice(0, 10)} (${days}-day window)`,
      eligibleAt: eligibleAt.toISOString(),
    },
  };
}

export interface RetentionPlan {
  dryRun: boolean;
  generatedAt: string;
  eligible: ClassifiedRecord[];
  protected: ClassifiedRecord[];
  /** Eligible and protected counts per class. */
  byClass: Record<string, { eligible: number; protected: number; retainDays: number | null }>;
  /** Human-readable lines for the operator log. */
  summary: string[];
}

export interface PlanOptions {
  /** Injected so the plan is a pure function of its inputs. */
  now?: Date;
  /** Cap on reported records, to keep a report readable on a large table. */
  sampleLimit?: number;
}

/**
 * Pure: given the same records and clock, always returns the same plan. No
 * database access, so the destructive decision is fully testable.
 */
export function planRetention(records: RetentionRecord[], options: PlanOptions = {}): RetentionPlan {
  const now = options.now ?? new Date();
  const sampleLimit = options.sampleLimit ?? 5;

  const eligible: ClassifiedRecord[] = [];
  const protectedRecords: ClassifiedRecord[] = [];

  for (const record of records) {
    const classified = classifyRecord(record, now);
    (classified.verdict.protected ? protectedRecords : eligible).push(classified);
  }

  const byClass: RetentionPlan['byClass'] = {};
  for (const entry of [...eligible, ...protectedRecords]) {
    const bucket = (byClass[entry.class] ??= {
      eligible: 0,
      protected: 0,
      retainDays: RETENTION_POLICY[entry.class]?.retainDays ?? null,
    });
    if (entry.verdict.protected) bucket.protected += 1;
    else bucket.eligible += 1;
  }

  const summary: string[] = [];
  for (const [className, counts] of Object.entries(byClass)) {
    const window = counts.retainDays === null ? 'indefinite' : `${counts.retainDays}d`;
    summary.push(
      `${className.padEnd(18)} window=${window.padEnd(9)} eligible=${counts.eligible} protected=${counts.protected}`
    );
  }

  if (eligible.length === 0) {
    summary.push('No records are eligible for cleanup. Nothing to do.');
  } else {
    summary.push(
      `${eligible.length} record(s) eligible; first ${Math.min(sampleLimit, eligible.length)}:` +
        ' ' +
        eligible
          .slice(0, sampleLimit)
          .map((e) => `${e.record.table}/${e.record.id}`)
          .join(', ')
    );
  }

  return {
    dryRun: true,
    generatedAt: now.toISOString(),
    eligible,
    protected: protectedRecords,
    byClass,
    summary,
  };
}

/** Job type for the scheduled sweep, registered alongside the expiry sweep. */
export const RETENTION_SWEEP_JOB = 'retention.sweep';

export interface RetentionSweepPayload {
  /** Report what would be removed, without removing it. The default. */
  dryRun?: boolean;
  /** Override the table set, for a targeted run. */
  tables?: string[];
  sampleLimit?: number;
}

export type RetentionJobPayload = JobPayload<RetentionSweepPayload>;

/** What a sweep reports back to the job record. */
export interface RetentionSweepResult {
  dryRun: boolean;
  considered: number;
  eligible: number;
  protectedCount: number;
  deleted: number;
  byClass: RetentionPlan['byClass'];
  summary: string[];
}

export function formatRetentionReport(plan: RetentionPlan, deleted = 0): string {
  const lines: string[] = [];
  lines.push('====================================================');
  lines.push(`Inqutum retention sweep — ${plan.dryRun ? 'DRY RUN (nothing will be deleted)' : 'APPLY'}`);
  lines.push(`Generated: ${plan.generatedAt}`);
  lines.push('====================================================');
  lines.push('');
  for (const line of plan.summary) {
    lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push(
    plan.dryRun
      ? `Dry run complete. ${plan.eligible.length} record(s) would be removed. Re-run with dryRun:false to apply.`
      : `Sweep complete. ${deleted} record(s) removed, ${plan.protected.length} protected.`
  );
  lines.push('====================================================');
  return lines.join('\n');
}
