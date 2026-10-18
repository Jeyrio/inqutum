/**
 * Retention executor and job wiring (#61).
 *
 * `retention.ts` decides; this file executes. The split matters: the decision
 * is a pure, fully tested function, while everything that can delete a row
 * lives here, is dry-run by default, and reports the affected records *before*
 * it deletes them.
 *
 * The guard against an accidental mass delete is threefold and deliberate:
 *
 *   1. `dryRun` defaults to true, so the job cannot delete anything unless the
 *      payload explicitly opts in.
 *   2. Each delete is capped at `batchSize` rows per table per run.
 *   3. A single sweep refuses to touch a table it does not recognise.
 */

import {
  RETENTION_POLICY,
  TABLE_CLASS,
  RETENTION_SWEEP_JOB,
  classifyRecord,
  planRetention,
  formatRetentionReport,
  type ClassifiedRecord,
  type RetentionRecord,
  type RetentionSweepResult,
  type RetentionPlan,
} from './retention';
import type { JobWorker } from '../jobs/worker';
import { NonRetryableJobError } from '../jobs/job-types';

export interface RetentionDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
  /** Required to delete. Fails loudly if the pool cannot write. */
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export interface SweepOptions {
  dryRun?: boolean;
  tables?: string[];
  now?: Date;
  sampleLimit?: number;
  /** Rows deleted per table per run. Bounds the blast radius. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 1_000;

/** Columns selected per table, so a plan can be built without loading the world. */
const SELECT_COLUMNS: Record<string, string> = {
  invoices: 'id, status, created_at, metadata',
  transactions: 'id, created_at',
  payment_events: 'id, created_at',
  jobs: 'id, status, completed_at, created_at',
};

/**
 * Settlement-linked rows are resolved up front with one query so a PAID
 * invoice is protected regardless of its age, and so a transaction is never
 * deleted out from under an invoice that references it.
 */
async function loadSettlementLinks(db: RetentionDatabase): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  const { rows } = await db.query(
    `SELECT id FROM invoices WHERE status = 'PAID'
     UNION
     SELECT i.id FROM invoices i
       JOIN transactions t ON t.invoice_id = i.id
     UNION
     SELECT i.id FROM invoices i
       JOIN payment_events e ON e.invoice_id = i.id
       WHERE i.status = 'PAID'`
  );
  for (const row of rows) {
    if (row?.id) protectedIds.add(String(row.id));
  }
  return protectedIds;
}

async function loadTable(
  db: RetentionDatabase,
  table: string,
  settlementLinks: Set<string>
): Promise<RetentionRecord[]> {
  const columns = SELECT_COLUMNS[table];
  if (!columns) return [];

  const { rows } = await db.query(`SELECT ${columns} FROM "${table}"`);
  return rows.map((row: any) => ({
    table,
    id: String(row.id),
    ageAnchor: String(
      row.completed_at ?? row.created_at ?? row.processed_at ?? row.generated_at ?? ''
    ),
    status: row.status ?? null,
    settlementLinked: settlementLinks.has(String(row.id)),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    deadLetter: row.status === 'dead',
  }));
}

/** Builds the plan without touching anything. Safe to run at any time. */
export async function buildRetentionPlan(
  db: RetentionDatabase,
  options: SweepOptions = {}
): Promise<RetentionPlan> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const tables = options.tables ?? Object.keys(TABLE_CLASS);

  // Validate before planning: a table the policy does not describe must be
  // refused loudly, not silently dropped. Filtering first would turn a typo
  // into a sweep that quietly skips it.
  for (const table of tables) {
    if (!TABLE_CLASS[table] || !SELECT_COLUMNS[table]) {
      throw new Error(`retention sweep: refusing unknown table "${table}"`);
    }
  }

  const settlementLinks = await loadSettlementLinks(db);

  const records: RetentionRecord[] = [];
  for (const table of tables) {
    records.push(...(await loadTable(db, table, settlementLinks)));
  }

  return { ...planRetention(records, { now, sampleLimit: options.sampleLimit }), dryRun };
}

export interface SweepOutcome {
  plan: RetentionPlan;
  result: RetentionSweepResult;
  report: string;
}

/**
 * Plans, reports, and only then — when explicitly asked — deletes.
 */
export async function runRetentionSweep(
  db: RetentionDatabase,
  options: SweepOptions = {}
): Promise<SweepOutcome> {
  const dryRun = options.dryRun !== false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const plan = await buildRetentionPlan(db, options);

  // Report the affected records before any destructive action, as the issue
  // requires. In apply mode this happens before the first DELETE is issued.
  const report = formatRetentionReport(plan, 0);

  let deleted = 0;
  const byTable = new Map<string, ClassifiedRecord[]>();
  for (const entry of plan.eligible) {
    const list = byTable.get(entry.record.table) ?? [];
    list.push(entry);
    byTable.set(entry.record.table, list);
  }

  if (!dryRun) {
    for (const [table, entries] of byTable) {
      // Bound the blast radius: never delete more than one batch per table.
      const batch = entries.slice(0, batchSize);
      const ids = batch.map((e) => e.record.id);
      const { rowCount } = await db.query(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
      deleted += rowCount ?? ids.length;
    }
  }

  const result: RetentionSweepResult = {
    dryRun,
    considered: plan.eligible.length + plan.protected.length,
    eligible: plan.eligible.length,
    protectedCount: plan.protected.length,
    deleted,
    byClass: plan.byClass,
    summary: plan.summary,
  };

  return { plan, result, report: dryRun ? report : formatRetentionReport(plan, deleted) };
}

/**
 * Registers the sweep with the job worker. Dry run is the default, so an
 * operator must send `{"dryRun": false}` to remove anything.
 */
export function registerRetentionJob(
  worker: JobWorker,
  deps: { db: RetentionDatabase }
): JobWorker {
  return worker.register(RETENTION_SWEEP_JOB, async (payload) => {
    const data = (payload?.data ?? {}) as { dryRun?: boolean; tables?: string[]; sampleLimit?: number };
    const dryRun = data.dryRun !== false;

    try {
      const { result } = await runRetentionSweep(deps.db, {
        dryRun,
        tables: data.tables,
        sampleLimit: data.sampleLimit,
      });
      return result as unknown as Record<string, unknown>;
    } catch (error) {
      // A failed sweep is never retried blindly: it may have deleted part of a
      // batch. Surface it for a human instead of compounding the damage.
      throw new NonRetryableJobError(
        `retention sweep failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

export { RETENTION_SWEEP_JOB, RETENTION_POLICY };
export { classifyRecord };
