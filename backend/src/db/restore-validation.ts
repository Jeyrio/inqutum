/**
 * Disaster-recovery validation (#62).
 *
 * After a restore or a migration the question is never "did the job exit 0" —
 * it is "can I prove the data is still coherent". This module answers that with
 * read-only invariant checks over the tables in `db/schema.sql`.
 *
 * The invariants are grouped by the failure they catch, which is how the issue
 * frames them: **missing**, **orphaned**, **duplicated**, **inconsistent**.
 *
 *   missing      an invoice that referenced settlement has no invoice row
 *   orphaned     a settlement reference that no longer resolves, or a
 *                transaction detached from its invoice
 *   duplicated   a uniqueness guarantee that a restore silently broke
 *   inconsistent a status that contradicts the timestamps or amounts beside it
 *
 * Two design points worth stating:
 *
 *  - **Read-only by construction.** Every statement is a SELECT, and
 *    `assertReadOnly` re-checks that at runtime before anything is reported, so
 *    a future edit that introduces a write fails loudly instead of running
 *    against a database someone is trying to recover.
 *  - **A narrow database interface.** Only `query` is required, so every check
 *    is exercised against a fixture in the test suite with no Postgres running.
 *    Checks report how many rows violate them and never mutate, so the same
 *    command is safe to run against production repeatedly.
 */

/** Failure families, matching the acceptance criteria in the issue. */
export type InvariantKind = 'missing' | 'orphaned' | 'duplicated' | 'inconsistent';

export type InvariantStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface InvariantResult {
  /** Stable identifier, e.g. `invoices.paid-without-transaction`. */
  id: string;
  kind: InvariantKind;
  status: InvariantStatus;
  /** Rows violating the invariant. 0 for PASS. */
  count: number;
  /** A bounded sample of offending rows, for triage. */
  sample: Array<Record<string, unknown>>;
  message: string;
  /** What a maintainer should do about it. */
  remediation: string;
  /** Set when the check could not run (missing table, permission denied). */
  error?: string;
}

export interface ValidationReport {
  /** When the report was produced. */
  timestamp: string;
  ok: boolean;
  counts: Record<InvariantKind, number>;
  totalViolations: number;
  results: InvariantResult[];
  /** Tables the validation expects, used to detect a partial restore. */
  tablesChecked: string[];
  tablesMissing: string[];
}

export interface ValidationDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ValidationOptions {
  /** Upper bound on rows fetched per check, to keep the output readable. */
  sampleLimit?: number;
  /** Skip checks whose table is absent, e.g. a minimal restore. */
  allowMissingTables?: boolean;
}

const DEFAULT_SAMPLE_LIMIT = 5;

/** Tables the domain cannot work without. */
export const REQUIRED_TABLES = ['invoices', 'transactions', 'payment_events', 'jobs'] as const;

const WRITE_KEYWORDS =
  /\b(insert\s+into|update\s+[\w".]+|delete\s+from|truncate|drop\s|alter\s|create\s|grant|revoke)\b/i;

function assertReadOnly(sql: string, id: string): void {
  if (WRITE_KEYWORDS.test(sql)) {
    throw new Error(
      `invariant "${id}" issued a statement that is not read-only. DR validation must never write: ${sql.trim()}`
    );
  }
}

/** Exposed so the test suite can prove the guard rejects a write. */
export const assertReadOnlyForTest = assertReadOnly;

interface CheckSpec {
  id: string;
  kind: InvariantKind;
  /** Table that must exist for this check to run. */
  table: string;
  message: string;
  remediation: string;
  /** Returns offending rows. */
  sql: string;
}

const CHECKS: CheckSpec[] = [
  // ── orphaned / missing ──────────────────────────────────────────────────
  {
    id: 'transactions.orphaned-invoice',
    kind: 'orphaned',
    table: 'transactions',
    message: 'Every transaction points at an invoice that exists',
    remediation:
      'A restore dropped an invoice that a transaction still references. Restore the invoice from the pre-incident backup, or null the reference deliberately once you have confirmed the payment settled.',
    sql: `
      SELECT t.id, t.invoice_id, t.tx_hash
      FROM transactions t
      LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE t.invoice_id IS NOT NULL AND i.id IS NULL
    `,
  },
  {
    id: 'payment-events.orphaned-invoice',
    kind: 'orphaned',
    table: 'payment_events',
    message: 'Every payment event points at an invoice that exists',
    remediation:
      'The events outlived their invoice. Re-attach the event to the correct invoice, or accept the loss if the invoice was legitimately removed.',
    sql: `
      SELECT e.id, e.invoice_id, e.event_type
      FROM payment_events e
      LEFT JOIN invoices i ON i.id = e.invoice_id
      WHERE e.invoice_id IS NOT NULL AND i.id IS NULL
    `,
  },
  {
    id: 'invoices.missing-transaction',
    kind: 'missing',
    table: 'invoices',
    message: 'Every settled invoice has at least one transaction behind it',
    remediation:
      'An invoice is marked PAID but no transaction row proves the money moved. Do not trust the status: re-verify the payment tx_hash against Horizon, and either link the transaction or move the invoice back to PENDING.',
    sql: `
      SELECT i.id, i.status, i.payment_tx_hash, i.paid_at
      FROM invoices i
      WHERE i.status = 'PAID'
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.invoice_id = i.id OR (i.payment_tx_hash IS NOT NULL AND t.tx_hash = i.payment_tx_hash)
        )
    `,
  },
  {
    id: 'transactions.detached-from-invoice',
    kind: 'missing',
    table: 'transactions',
    message: 'A transaction carrying an invoice memo is still linked to that invoice',
    remediation:
      'transactions.invoice_id is ON DELETE SET NULL, so deleting an invoice quietly detaches its payment history. Re-link by memo, and treat any invoice with a detached transaction as unsettled until proven otherwise.',
    sql: `
      SELECT t.id, t.tx_hash, t.invoice_id, t.memo
      FROM transactions t
      LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE t.invoice_id IS NULL
        AND t.memo IS NOT NULL
        AND EXISTS (SELECT 1 FROM invoices i2 WHERE i2.memo = t.memo)
    `,
  },

  // ── duplicated ──────────────────────────────────────────────────────────
  {
    id: 'invoices.duplicate-memo',
    kind: 'duplicated',
    table: 'invoices',
    message: 'No two invoices share a memo (the settlement reference is unique)',
    remediation:
      'The UNIQUE constraint on invoices.memo was not restored. Two invoices with one memo cannot be told apart at settlement. Renumber the newer invoice, then re-apply the constraint.',
    sql: `
      SELECT memo, COUNT(*) AS copies, MIN(id) AS first_id, MAX(id) AS last_id
      FROM invoices
      GROUP BY memo
      HAVING COUNT(*) > 1
    `,
  },
  {
    id: 'transactions.duplicate-tx-hash',
    kind: 'duplicated',
    table: 'transactions',
    message: 'No two transactions share a tx_hash (a Stellar tx settles once)',
    remediation:
      'The UNIQUE constraint on transactions.tx_hash was not restored, so one payment may be counted more than once. De-duplicate keeping the earliest processed_at, then re-apply the constraint.',
    sql: `
      SELECT tx_hash, COUNT(*) AS copies
      FROM transactions
      GROUP BY tx_hash
      HAVING COUNT(*) > 1
    `,
  },

  // ── inconsistent ────────────────────────────────────────────────────────
  {
    id: 'invoices.paid-without-timestamp',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'A PAID invoice records when it was paid',
    remediation:
      'status and paid_at disagree, so reporting cannot tell when the money arrived. Reconcile against the linked transaction; do not guess a timestamp.',
    sql: `SELECT id, status, payment_tx_hash FROM invoices WHERE status = 'PAID' AND paid_at IS NULL`,
  },
  {
    id: 'invoices.unpaid-with-timestamp',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'An unpaid invoice has no paid_at',
    remediation:
      'An invoice that is not PAID carries a settlement timestamp. Clear paid_at, or complete the settlement if the status is the stale side.',
    sql: `
      SELECT id, status, paid_at
      FROM invoices
      WHERE status <> 'PAID' AND paid_at IS NOT NULL
    `,
  },
  {
    id: 'invoices.paid-without-tx-hash',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'A PAID invoice records the transaction that settled it',
    remediation:
      'Without payment_tx_hash the settlement cannot be audited against the network. Re-verify and backfill the hash from the linked transaction.',
    sql: `
      SELECT id, status, paid_at
      FROM invoices
      WHERE status = 'PAID' AND payment_tx_hash IS NULL
    `,
  },
  {
    id: 'invoices.unknown-status',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'Every invoice status is one the domain understands',
    remediation:
      'A status outside PENDING / PAID / EXPIRED / CANCELLED means the CHECK constraint was lost in the restore. Map the value, or re-apply the constraint.',
    sql: `
      SELECT id, status
      FROM invoices
      WHERE status IS NULL
         OR status NOT IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED')
    `,
  },
  {
    id: 'invoices.amount-disagrees-with-settlement',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'A settled invoice agrees with the amount of its transaction',
    remediation:
      'invoice amount and transaction amount disagree. Confirm on-chain which is authoritative before editing either; a mismatch here is a real accounting event, not a restore artefact.',
    sql: `
      SELECT i.id AS invoice_id, i.amount AS invoice_amount,
             t.id AS transaction_id, t.amount AS transaction_amount
      FROM invoices i
      JOIN transactions t ON t.invoice_id = i.id
      WHERE i.status = 'PAID' AND t.amount IS DISTINCT FROM i.amount
    `,
  },
  {
    id: 'invoices.expiry-not-after-creation',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'An invoice expires after it was created',
    remediation:
      'expires_at is at or before created_at, so the invoice was unpayable from birth. Recompute the expiry from the backfill rule (created_at + 7 days).',
    sql: `
      SELECT id, created_at, expires_at
      FROM invoices
      WHERE expires_at IS NOT NULL AND expires_at <= created_at
    `,
  },
  {
    id: 'invoices.version-invalid',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'Every invoice carries a positive optimistic-concurrency version',
    remediation:
      'version <= 0 breaks optimistic concurrency: the next write will not detect a lost update. Reset to 1 and re-apply the NOT NULL DEFAULT 1 column.',
    sql: `SELECT id, version FROM invoices WHERE version IS NULL OR version < 1`,
  },
  {
    id: 'invoices.paid-but-overdue',
    kind: 'inconsistent',
    table: 'invoices',
    message: 'A PAID invoice was not settled after its expiry',
    remediation:
      'Either the payment landed after the window and the status is correct, or the expiry sweep ran against the wrong rows. Check the transaction timestamp before changing anything.',
    sql: `
      SELECT id, paid_at, expires_at
      FROM invoices
      WHERE status = 'PAID' AND expires_at IS NOT NULL AND paid_at > expires_at
    `,
  },
  {
    id: 'jobs.stale-running-lease',
    kind: 'inconsistent',
    table: 'jobs',
    message: 'No job is stuck running with an expired lease',
    remediation:
      'A restore froze the clock mid-claim, leaving jobs RUNNING that no worker owns. They will be reclaimed on the next sweep; confirm the worker is running before touching them.',
    sql: `
      SELECT id, type, locked_until, locked_by
      FROM jobs
      WHERE status = 'running' AND (locked_until IS NULL OR locked_until < NOW())
    `,
  },
  {
    id: 'jobs.terminal-without-completion',
    kind: 'inconsistent',
    table: 'jobs',
    message: 'A finished job records when it finished',
    remediation:
      'completed_at is null on a terminal job, so completion cannot be ordered against other events. Backfill from updated_at.',
    sql: `
      SELECT id, type, status, updated_at
      FROM jobs
      WHERE status IN ('succeeded', 'dead') AND completed_at IS NULL
    `,
  },
  {
    id: 'jobs.non-terminal-with-completion',
    kind: 'inconsistent',
    table: 'jobs',
    message: 'A queued or running job is not marked complete',
    remediation:
      'completed_at is set on a job that is still queued or running. The job will either re-run or be reported as done twice; clear the timestamp.',
    sql: `
      SELECT id, type, status, completed_at
      FROM jobs
      WHERE status IN ('queued', 'running') AND completed_at IS NOT NULL
    `,
  },
];

/** Stable list of the invariant ids, so tests can assert coverage. */
export const CHECK_IDS_FOR_TEST: readonly string[] = CHECKS.map((c) => c.id);

/** Which tables exist, used to detect a partial restore. */
async function detectTables(
  db: ValidationDatabase,
  required: readonly string[]
): Promise<{ present: string[]; missing: string[] }> {
  const { rows } = await db.query(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname = current_schema()
       AND c.relname = ANY($1::text[])`,
    [[...required]]
  );

  const present = new Set(rows.map((r) => String(r.name)));
  return {
    present: required.filter((t) => present.has(t)),
    missing: required.filter((t) => !present.has(t)),
  };
}

/**
 * Runs every invariant against `db` and returns a report. Never writes.
 */
export async function runRestoreValidation(
  db: ValidationDatabase,
  options: ValidationOptions = {}
): Promise<ValidationReport> {
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const results: InvariantResult[] = [];

  let tablesPresent: string[] = [...REQUIRED_TABLES];
  let tablesMissing: string[] = [];

  try {
    const detected = await detectTables(db, REQUIRED_TABLES);
    tablesPresent = detected.present;
    tablesMissing = detected.missing;
  } catch (error) {
    // A restore target without the catalog readable (or a test double that does
    // not answer it) must not abort the run; per-check errors carry the detail.
    tablesPresent = [...REQUIRED_TABLES];
    tablesMissing = [];
  }

  for (const check of CHECKS) {
    const base = {
      id: check.id,
      kind: check.kind,
      message: check.message,
      remediation: check.remediation,
    };

    if (options.allowMissingTables && tablesPresent.length > 0 && !tablesPresent.includes(check.table)) {
      results.push({
        ...base,
        status: 'SKIPPED',
        count: 0,
        sample: [],
        message: `${check.message} (skipped: table "${check.table}" is not present in this database)`,
      });
      continue;
    }

    try {
      assertReadOnly(check.sql, check.id);
      const { rows } = await db.query(`${check.sql} LIMIT ${sampleLimit + 1}`);
      const count = await countViolations(db, check);
      const hasMore = rows.length > sampleLimit;

      results.push({
        ...base,
        status: count > 0 ? 'FAIL' : 'PASS',
        count,
        sample: rows.slice(0, sampleLimit).map((r) => normaliseRow(r)),
        message:
          count > 0
            ? `${check.message} — ${count} row(s) violate this invariant${hasMore ? ` (first ${sampleLimit} shown)` : ''}`
            : check.message,
      });
    } catch (error) {
      results.push({
        ...base,
        status: 'FAIL',
        count: 0,
        sample: [],
        message: `${check.message} — could not be evaluated`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const counts: Record<InvariantKind, number> = { missing: 0, orphaned: 0, duplicated: 0, inconsistent: 0 };
  let totalViolations = 0;
  for (const r of results) {
    if (r.status === 'FAIL') {
      counts[r.kind] += r.count;
      totalViolations += r.count;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    // A check that could not run is a failed validation: an unknown state is
    // not a healthy one, and silently reporting PASS would defeat the purpose.
    ok: results.every((r) => r.status === 'PASS' || r.status === 'SKIPPED'),
    counts,
    totalViolations,
    results,
    tablesChecked: tablesPresent,
    tablesMissing,
  };
}

/**
 * Counts every violating row, not just the sample. The sample query is capped so
 * output stays readable; the count is what a maintainer triages against.
 */
async function countViolations(db: ValidationDatabase, check: CheckSpec): Promise<number> {
  const counted = wrapForCount(check.sql);
  assertReadOnly(counted, check.id);
  const { rows } = await db.query(counted);

  // A grouped check is already one row per violation, so the row count *is* the
  // violation count. Reading a `count` column instead would silently report 0.
  if (isGrouped(counted)) {
    return rows.length;
  }

  const row = rows[0] ?? {};
  const value = row.count ?? row.violations ?? 0;
  return Number(value) || 0;
}

function isGrouped(sql: string): boolean {
  return /\bGROUP\s+BY\b/i.test(sql);
}

/**
 * GROUP BY queries already return one row per violation, so their row count is
 * the violation count. Everything else needs an outer count.
 */
function wrapForCount(sql: string): string {
  const trimmed = sql.trim();
  if (isGrouped(trimmed)) {
    return trimmed;
  }
  return `SELECT COUNT(*)::int AS count FROM (${trimmed}) AS violations`;
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

const ICON: Record<InvariantStatus, string> = { PASS: 'ok  ', FAIL: 'FAIL', SKIPPED: 'skip' };

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push('====================================================');
  lines.push('Inqutum restore validation (read-only)');
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push('====================================================');

  if (report.tablesMissing.length > 0) {
    lines.push('');
    lines.push(
      `Tables missing from the restore target: ${report.tablesMissing.join(', ')}` +
        (report.ok ? '' : '')
    );
  }

  let currentKind: InvariantKind | null = null;
  for (const r of report.results) {
    if (r.kind !== currentKind) {
      currentKind = r.kind;
      lines.push('');
      lines.push(`-- ${r.kind} --`);
    }
    lines.push(`[${ICON[r.status]}] ${r.id}: ${r.message}`);
    if (r.error) {
      lines.push(`       error: ${r.error}`);
    }
    for (const [key, value] of Object.entries(r.sample)) {
      lines.push(`       ${key} = ${formatValue(value)}`);
    }
    if (r.status === 'FAIL') {
      lines.push(`       remediation: ${r.remediation}`);
    }
  }

  lines.push('');
  lines.push('----------------------------------------------------');
  lines.push(
    `missing=${report.counts.missing} orphaned=${report.counts.orphaned} ` +
      `duplicated=${report.counts.duplicated} inconsistent=${report.counts.inconsistent} ` +
      `total=${report.totalViolations}`
  );
  lines.push(report.ok ? 'Restore invariants hold.' : 'Restore invariants VIOLATED — see remediation above.');
  lines.push('====================================================');
  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
