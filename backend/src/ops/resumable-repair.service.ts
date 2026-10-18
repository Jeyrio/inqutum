/**
 * Resumable Repair Job for Orphaned and Inconsistent Records.
 *
 * Architecture:
 *  - Phased execution across failure families:
 *      1. detached_transactions: re-links transactions where memo matches an invoice.
 *      2. orphaned_transactions: isolates invalid foreign references to metadata to restore relational invariants.
 *      3. orphaned_payment_events: isolates invalid foreign references to event_data while preserving audit history.
 *      4. inconsistent_invoices: reconciles timestamps, tx hashes, clears invalid paid_at, fixes invalid versions.
 *      5. inconsistent_jobs: resets stale running leases, backfills completed_at on terminal jobs, clears on non-terminal.
 *  - Keyset pagination per phase (`WHERE id::text > $cursor ORDER BY id ASC LIMIT $batchSize`).
 *  - Persistent checkpoints updated after every batch, enabling interruption recovery and transparent resumption.
 *  - Idempotent and safe to run in dryRun mode (report-only preview) or live apply mode.
 */

import { randomUUID } from 'node:crypto';

export type RepairPhase =
  | 'detached_transactions'
  | 'orphaned_transactions'
  | 'orphaned_payment_events'
  | 'inconsistent_invoices'
  | 'inconsistent_jobs';

export const REPAIR_PHASE_ORDER: readonly RepairPhase[] = [
  'detached_transactions',
  'orphaned_transactions',
  'orphaned_payment_events',
  'inconsistent_invoices',
  'inconsistent_jobs',
] as const;

export type RepairJobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export interface RepairActionLogEntry {
  timestamp: string;
  phase: RepairPhase;
  recordId: string;
  action: string;
  details: Record<string, unknown>;
}

export interface RepairJobOptions {
  batchSize?: number;
  dryRun?: boolean;
  phases?: RepairPhase[];
  maxBatches?: number;
}

export interface RepairCheckpoint {
  id: string;
  status: RepairJobStatus;
  phase: RepairPhase;
  cursor: string | null;
  dryRun: boolean;
  batchSize: number;
  phases: RepairPhase[];
  scannedCount: number;
  repairedCount: number;
  skippedCount: number;
  failedCount: number;
  errors: Array<{ timestamp: string; phase: RepairPhase; recordId?: string; error: string }>;
  actionLog: RepairActionLogEntry[];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RepairExecutionReport {
  jobId: string;
  status: RepairJobStatus;
  dryRun: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  currentPhase: RepairPhase;
  cursor: string | null;
  counts: {
    scanned: number;
    repaired: number;
    skipped: number;
    failed: number;
  };
  errors: Array<{ timestamp: string; phase: RepairPhase; recordId?: string; error: string }>;
  actionLogSample: RepairActionLogEntry[];
}

export interface RepairDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface RepairCheckpointStore {
  get(jobId: string): Promise<RepairCheckpoint | null>;
  save(checkpoint: RepairCheckpoint): Promise<void>;
  list(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]>;
}

export class MemoryRepairCheckpointStore implements RepairCheckpointStore {
  private checkpoints = new Map<string, RepairCheckpoint>();

  async get(jobId: string): Promise<RepairCheckpoint | null> {
    const cp = this.checkpoints.get(jobId);
    return cp ? JSON.parse(JSON.stringify(cp)) : null;
  }

  async save(checkpoint: RepairCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, JSON.parse(JSON.stringify(checkpoint)));
  }

  async list(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]> {
    let list = Array.from(this.checkpoints.values());
    if (options?.status) {
      list = list.filter((cp) => cp.status === options.status);
    }
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (options?.limit) {
      list = list.slice(0, options.limit);
    }
    return list.map((cp) => JSON.parse(JSON.stringify(cp)));
  }
}

export class PostgresRepairCheckpointStore implements RepairCheckpointStore {
  constructor(private db: RepairDatabase) {}

  async initTable(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS record_repair_checkpoints (
        id VARCHAR(64) PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        phase VARCHAR(50) NOT NULL,
        cursor TEXT,
        dry_run BOOLEAN NOT NULL DEFAULT false,
        batch_size INTEGER NOT NULL DEFAULT 100,
        phases JSONB NOT NULL DEFAULT '[]'::jsonb,
        scanned_count INTEGER NOT NULL DEFAULT 0,
        repaired_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        action_log JSONB NOT NULL DEFAULT '[]'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `);
  }

  async get(jobId: string): Promise<RepairCheckpoint | null> {
    const { rows } = await this.db.query(
      `SELECT id, status, phase, cursor, dry_run, batch_size, phases,
              scanned_count, repaired_count, skipped_count, failed_count,
              errors, action_log, started_at, updated_at, completed_at
       FROM record_repair_checkpoints WHERE id = $1`,
      [jobId]
    );
    if (!rows || rows.length === 0 || !rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      status: r.status,
      phase: r.phase,
      cursor: r.cursor,
      dryRun: Boolean(r.dry_run),
      batchSize: Number(r.batch_size),
      phases: Array.isArray(r.phases) ? r.phases : typeof r.phases === 'string' ? JSON.parse(r.phases) : [],
      scannedCount: Number(r.scanned_count),
      repairedCount: Number(r.repaired_count),
      skippedCount: Number(r.skipped_count),
      failedCount: Number(r.failed_count),
      errors: Array.isArray(r.errors) ? r.errors : typeof r.errors === 'string' ? JSON.parse(r.errors) : [],
      actionLog: Array.isArray(r.action_log) ? r.action_log : typeof r.action_log === 'string' ? JSON.parse(r.action_log) : [],
      startedAt: new Date(r.started_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    };
  }

  async save(cp: RepairCheckpoint): Promise<void> {
    await this.db.query(
      `INSERT INTO record_repair_checkpoints (
        id, status, phase, cursor, dry_run, batch_size, phases,
        scanned_count, repaired_count, skipped_count, failed_count,
        errors, action_log, started_at, updated_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        phase = EXCLUDED.phase,
        cursor = EXCLUDED.cursor,
        dry_run = EXCLUDED.dry_run,
        batch_size = EXCLUDED.batch_size,
        phases = EXCLUDED.phases,
        scanned_count = EXCLUDED.scanned_count,
        repaired_count = EXCLUDED.repaired_count,
        skipped_count = EXCLUDED.skipped_count,
        failed_count = EXCLUDED.failed_count,
        errors = EXCLUDED.errors,
        action_log = EXCLUDED.action_log,
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at`,
      [
        cp.id,
        cp.status,
        cp.phase,
        cp.cursor,
        cp.dryRun,
        cp.batchSize,
        JSON.stringify(cp.phases),
        cp.scannedCount,
        cp.repairedCount,
        cp.skippedCount,
        cp.failedCount,
        JSON.stringify(cp.errors),
        JSON.stringify(cp.actionLog),
        cp.startedAt,
        cp.updatedAt,
        cp.completedAt,
      ]
    );
  }

  async list(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]> {
    let sql = `SELECT id, status, phase, cursor, dry_run, batch_size, phases,
                      scanned_count, repaired_count, skipped_count, failed_count,
                      errors, action_log, started_at, updated_at, completed_at
               FROM record_repair_checkpoints`;
    const params: unknown[] = [];
    if (options?.status) {
      params.push(options.status);
      sql += ` WHERE status = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC`;
    if (options?.limit) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const { rows } = await this.db.query(sql, params);
    return (rows || []).map((r) => ({
      id: r.id,
      status: r.status,
      phase: r.phase,
      cursor: r.cursor,
      dryRun: Boolean(r.dry_run),
      batchSize: Number(r.batch_size),
      phases: Array.isArray(r.phases) ? r.phases : typeof r.phases === 'string' ? JSON.parse(r.phases) : [],
      scannedCount: Number(r.scanned_count),
      repairedCount: Number(r.repaired_count),
      skippedCount: Number(r.skipped_count),
      failedCount: Number(r.failed_count),
      errors: Array.isArray(r.errors) ? r.errors : typeof r.errors === 'string' ? JSON.parse(r.errors) : [],
      actionLog: Array.isArray(r.action_log) ? r.action_log : typeof r.action_log === 'string' ? JSON.parse(r.action_log) : [],
      startedAt: new Date(r.started_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    }));
  }
}

export class RepairJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Repair job not found: ${jobId}`);
    this.name = 'RepairJobNotFoundError';
  }
}

export class ResumableRepairService {
  private db: RepairDatabase;
  private checkpointStore: RepairCheckpointStore;
  private defaultBatchSize: number;

  constructor(options: {
    db: RepairDatabase;
    checkpointStore?: RepairCheckpointStore;
    defaultBatchSize?: number;
  }) {
    this.db = options.db;
    this.checkpointStore = options.checkpointStore ?? new MemoryRepairCheckpointStore();
    this.defaultBatchSize = options.defaultBatchSize ?? 100;
  }

  public async startRepairJob(options: RepairJobOptions = {}): Promise<RepairExecutionReport> {
    const phases = options.phases && options.phases.length > 0
      ? options.phases
      : [...REPAIR_PHASE_ORDER];
    const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : this.defaultBatchSize;
    const dryRun = options.dryRun ?? false;

    const checkpoint: RepairCheckpoint = {
      id: `repair_${randomUUID()}`,
      status: 'pending',
      phase: phases[0]!,
      cursor: null,
      dryRun,
      batchSize,
      phases,
      scannedCount: 0,
      repairedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      errors: [],
      actionLog: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };

    await this.checkpointStore.save(checkpoint);
    return this.executeJob(checkpoint.id, options.maxBatches);
  }

  public async resumeRepairJob(
    jobId: string,
    options: { maxBatches?: number; batchSize?: number } = {}
  ): Promise<RepairExecutionReport> {
    const checkpoint = await this.checkpointStore.get(jobId);
    if (!checkpoint) {
      throw new RepairJobNotFoundError(jobId);
    }

    if (checkpoint.status === 'completed') {
      return this.buildReport(checkpoint);
    }

    if (options.batchSize && options.batchSize > 0) {
      checkpoint.batchSize = options.batchSize;
    }

    checkpoint.status = 'running';
    checkpoint.updatedAt = new Date().toISOString();
    await this.checkpointStore.save(checkpoint);

    return this.executeJob(checkpoint.id, options.maxBatches);
  }

  public async getJob(jobId: string): Promise<RepairExecutionReport | null> {
    const checkpoint = await this.checkpointStore.get(jobId);
    if (!checkpoint) return null;
    return this.buildReport(checkpoint);
  }

  public async listJobs(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]> {
    return this.checkpointStore.list(options);
  }

  private async executeJob(jobId: string, maxBatches?: number): Promise<RepairExecutionReport> {
    const checkpoint = await this.checkpointStore.get(jobId);
    if (!checkpoint) {
      throw new RepairJobNotFoundError(jobId);
    }

    checkpoint.status = 'running';
    checkpoint.updatedAt = new Date().toISOString();
    await this.checkpointStore.save(checkpoint);

    let batchesExecuted = 0;

    try {
      while (true) {
        const currentPhaseIndex = checkpoint.phases.indexOf(checkpoint.phase);
        if (currentPhaseIndex === -1) {
          // Reached end of configured phases
          checkpoint.status = 'completed';
          checkpoint.completedAt = new Date().toISOString();
          checkpoint.updatedAt = checkpoint.completedAt;
          await this.checkpointStore.save(checkpoint);
          break;
        }

        const batchResult = await this.processBatch(
          checkpoint.phase,
          checkpoint.cursor,
          checkpoint.batchSize,
          checkpoint.dryRun
        );

        checkpoint.scannedCount += batchResult.scanned;
        checkpoint.repairedCount += batchResult.repaired;
        checkpoint.skippedCount += batchResult.skipped;
        checkpoint.failedCount += batchResult.failed;

        if (batchResult.errors.length > 0) {
          checkpoint.errors.push(...batchResult.errors);
        }
        if (batchResult.actions.length > 0) {
          checkpoint.actionLog.push(...batchResult.actions);
        }

        checkpoint.updatedAt = new Date().toISOString();
        batchesExecuted++;

        if (batchResult.hasMore && batchResult.nextCursor !== null) {
          checkpoint.cursor = batchResult.nextCursor;
          await this.checkpointStore.save(checkpoint);
        } else {
          // Phase finished: advance to next phase
          const nextIndex = currentPhaseIndex + 1;
          if (nextIndex < checkpoint.phases.length) {
            checkpoint.phase = checkpoint.phases[nextIndex]!;
            checkpoint.cursor = null;
            await this.checkpointStore.save(checkpoint);
          } else {
            // All phases completed!
            checkpoint.status = 'completed';
            checkpoint.completedAt = new Date().toISOString();
            checkpoint.updatedAt = checkpoint.completedAt;
            await this.checkpointStore.save(checkpoint);
            break;
          }
        }

        if (maxBatches !== undefined && maxBatches > 0 && batchesExecuted >= maxBatches) {
          checkpoint.status = 'paused';
          checkpoint.updatedAt = new Date().toISOString();
          await this.checkpointStore.save(checkpoint);
          break;
        }
      }
    } catch (err: unknown) {
      checkpoint.status = 'failed';
      checkpoint.updatedAt = new Date().toISOString();
      checkpoint.errors.push({
        timestamp: new Date().toISOString(),
        phase: checkpoint.phase,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.checkpointStore.save(checkpoint);
      throw err;
    }

    return this.buildReport(checkpoint);
  }

  private async processBatch(
    phase: RepairPhase,
    cursor: string | null,
    batchSize: number,
    dryRun: boolean
  ): Promise<{
    scanned: number;
    repaired: number;
    skipped: number;
    failed: number;
    nextCursor: string | null;
    hasMore: boolean;
    actions: RepairActionLogEntry[];
    errors: Array<{ timestamp: string; phase: RepairPhase; recordId?: string; error: string }>;
  }> {
    const actions: RepairActionLogEntry[] = [];
    const errors: Array<{ timestamp: string; phase: RepairPhase; recordId?: string; error: string }> = [];
    let scanned = 0;
    let repaired = 0;
    let skipped = 0;
    let failed = 0;

    switch (phase) {
      case 'detached_transactions': {
        const { rows } = await this.db.query(
          `SELECT t.id, t.tx_hash, t.memo, i.id AS matching_invoice_id
           FROM transactions t
           JOIN invoices i ON i.memo = t.memo
           WHERE t.invoice_id IS NULL
             AND t.memo IS NOT NULL
             AND ($1::text IS NULL OR t.id::text > $1::text)
           ORDER BY t.id ASC
           LIMIT $2`,
          [cursor, batchSize]
        );

        scanned = rows.length;
        for (const row of rows) {
          try {
            if (!dryRun) {
              await this.db.query(
                `UPDATE transactions SET invoice_id = $1 WHERE id = $2 AND invoice_id IS NULL`,
                [row.matching_invoice_id, row.id]
              );
            }
            repaired++;
            actions.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              action: 'relink_transaction_to_invoice',
              details: {
                txHash: row.tx_hash,
                memo: row.memo,
                invoiceId: row.matching_invoice_id,
              },
            });
          } catch (err) {
            failed++;
            errors.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].id) : null;
        return {
          scanned,
          repaired,
          skipped,
          failed,
          nextCursor,
          hasMore: rows.length === batchSize,
          actions,
          errors,
        };
      }

      case 'orphaned_transactions': {
        const { rows } = await this.db.query(
          `SELECT t.id, t.invoice_id, t.tx_hash
           FROM transactions t
           LEFT JOIN invoices i ON i.id = t.invoice_id
           WHERE t.invoice_id IS NOT NULL
             AND i.id IS NULL
             AND ($1::text IS NULL OR t.id::text > $1::text)
           ORDER BY t.id ASC
           LIMIT $2`,
          [cursor, batchSize]
        );

        scanned = rows.length;
        for (const row of rows) {
          try {
            if (!dryRun) {
              await this.db.query(
                `UPDATE transactions
                 SET invoice_id = NULL,
                     metadata = jsonb_set(
                       COALESCE(metadata, '{}'::jsonb),
                       '{orphaned_invoice_id}',
                       to_jsonb($1::text)
                     )
                 WHERE id = $2 AND invoice_id = $1`,
                [row.invoice_id, row.id]
              );
            }
            repaired++;
            actions.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              action: 'isolate_orphaned_transaction',
              details: {
                txHash: row.tx_hash,
                orphanedInvoiceId: row.invoice_id,
              },
            });
          } catch (err) {
            failed++;
            errors.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].id) : null;
        return {
          scanned,
          repaired,
          skipped,
          failed,
          nextCursor,
          hasMore: rows.length === batchSize,
          actions,
          errors,
        };
      }

      case 'orphaned_payment_events': {
        const { rows } = await this.db.query(
          `SELECT e.id, e.invoice_id, e.event_type
           FROM payment_events e
           LEFT JOIN invoices i ON i.id = e.invoice_id
           WHERE e.invoice_id IS NOT NULL
             AND i.id IS NULL
             AND ($1::text IS NULL OR e.id::text > $1::text)
           ORDER BY e.id ASC
           LIMIT $2`,
          [cursor, batchSize]
        );

        scanned = rows.length;
        for (const row of rows) {
          try {
            if (!dryRun) {
              await this.db.query(
                `UPDATE payment_events
                 SET invoice_id = NULL,
                     event_data = jsonb_set(
                       COALESCE(event_data, '{}'::jsonb),
                       '{orphaned_invoice_id}',
                       to_jsonb($1::text)
                     )
                 WHERE id = $2 AND invoice_id = $1`,
                [row.invoice_id, row.id]
              );
            }
            repaired++;
            actions.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              action: 'isolate_orphaned_payment_event',
              details: {
                eventType: row.event_type,
                orphanedInvoiceId: row.invoice_id,
              },
            });
          } catch (err) {
            failed++;
            errors.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].id) : null;
        return {
          scanned,
          repaired,
          skipped,
          failed,
          nextCursor,
          hasMore: rows.length === batchSize,
          actions,
          errors,
        };
      }

      case 'inconsistent_invoices': {
        const { rows } = await this.db.query(
          `SELECT i.id, i.status, i.paid_at, i.payment_tx_hash, i.version, i.created_at,
                  t.processed_at AS tx_processed_at, t.tx_hash AS tx_hash
           FROM invoices i
           LEFT JOIN LATERAL (
             SELECT processed_at, tx_hash
             FROM transactions
             WHERE invoice_id = i.id OR (i.payment_tx_hash IS NOT NULL AND tx_hash = i.payment_tx_hash)
             ORDER BY processed_at ASC
             LIMIT 1
           ) t ON true
           WHERE (
             (i.status = 'PAID' AND i.paid_at IS NULL)
             OR (i.status <> 'PAID' AND i.paid_at IS NOT NULL)
             OR (i.status = 'PAID' AND i.payment_tx_hash IS NULL AND t.tx_hash IS NOT NULL)
             OR (i.version IS NULL OR i.version < 1)
           )
             AND ($1::text IS NULL OR i.id::text > $1::text)
           ORDER BY i.id ASC
           LIMIT $2`,
          [cursor, batchSize]
        );

        scanned = rows.length;
        for (const row of rows) {
          try {
            const rowActions: string[] = [];

            if (row.status === 'PAID' && !row.paid_at) {
              const backfillTimestamp = row.tx_processed_at ?? row.created_at ?? new Date().toISOString();
              if (!dryRun) {
                await this.db.query(
                  `UPDATE invoices SET paid_at = $1 WHERE id = $2 AND paid_at IS NULL`,
                  [backfillTimestamp, row.id]
                );
              }
              rowActions.push('backfill_paid_at');
            }

            if (row.status !== 'PAID' && row.paid_at !== null && row.paid_at !== undefined) {
              if (!dryRun) {
                await this.db.query(
                  `UPDATE invoices SET paid_at = NULL WHERE id = $1 AND status <> 'PAID'`,
                  [row.id]
                );
              }
              rowActions.push('clear_paid_at');
            }

            if (row.status === 'PAID' && !row.payment_tx_hash && row.tx_hash) {
              if (!dryRun) {
                await this.db.query(
                  `UPDATE invoices SET payment_tx_hash = $1 WHERE id = $2 AND payment_tx_hash IS NULL`,
                  [row.tx_hash, row.id]
                );
              }
              rowActions.push('backfill_payment_tx_hash');
            }

            if (row.version === null || row.version === undefined || Number(row.version) < 1) {
              if (!dryRun) {
                await this.db.query(
                  `UPDATE invoices SET version = 1 WHERE id = $1 AND (version IS NULL OR version < 1)`,
                  [row.id]
                );
              }
              rowActions.push('reset_version');
            }

            if (rowActions.length > 0) {
              repaired++;
              actions.push({
                timestamp: new Date().toISOString(),
                phase,
                recordId: String(row.id),
                action: rowActions.join('+'),
                details: { status: row.status, subActions: rowActions },
              });
            } else {
              skipped++;
            }
          } catch (err) {
            failed++;
            errors.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].id) : null;
        return {
          scanned,
          repaired,
          skipped,
          failed,
          nextCursor,
          hasMore: rows.length === batchSize,
          actions,
          errors,
        };
      }

      case 'inconsistent_jobs': {
        const { rows } = await this.db.query(
          `SELECT j.id, j.status, j.locked_until, j.completed_at, j.updated_at, j.created_at
           FROM jobs j
           WHERE (
             (j.status = 'running' AND (j.locked_until IS NULL OR j.locked_until < NOW()))
             OR (j.status IN ('succeeded', 'dead') AND j.completed_at IS NULL)
             OR (j.status IN ('queued', 'running') AND j.completed_at IS NOT NULL)
           )
             AND ($1::text IS NULL OR j.id::text > $1::text)
           ORDER BY j.id ASC
           LIMIT $2`,
          [cursor, batchSize]
        );

        scanned = rows.length;
        for (const row of rows) {
          try {
            const isStaleLease =
              row.status === 'running' &&
              (!row.locked_until || new Date(row.locked_until).getTime() < Date.now());
            const isMissingCompleted =
              ['succeeded', 'dead'].includes(row.status) && !row.completed_at;
            const isUnexpectedCompleted =
              ['queued', 'running'].includes(row.status) && row.completed_at !== null && row.completed_at !== undefined;

            const rowActions: string[] = [];

            if (isStaleLease) {
              if (!dryRun) {
                await this.db.query(
                  `UPDATE jobs
                   SET status = 'queued', locked_until = NULL, locked_by = NULL, updated_at = NOW()
                   WHERE id = $1 AND status = 'running'`,
                  [row.id]
                );
              }
              rowActions.push('requeue_stale_lease');
            }

            if (isMissingCompleted) {
              const completedTime = row.updated_at ?? row.created_at ?? new Date().toISOString();
              if (!dryRun) {
                await this.db.query(
                  `UPDATE jobs SET completed_at = $1 WHERE id = $2 AND completed_at IS NULL`,
                  [completedTime, row.id]
                );
              }
              rowActions.push('backfill_completed_at');
            }

            if (isUnexpectedCompleted) {
              if (!dryRun) {
                await this.db.query(
                  `UPDATE jobs SET completed_at = NULL WHERE id = $1 AND status IN ('queued', 'running')`,
                  [row.id]
                );
              }
              rowActions.push('clear_completed_at');
            }

            if (rowActions.length > 0) {
              repaired++;
              actions.push({
                timestamp: new Date().toISOString(),
                phase,
                recordId: String(row.id),
                action: rowActions.join('+'),
                details: { status: row.status, subActions: rowActions },
              });
            } else {
              skipped++;
            }
          } catch (err) {
            failed++;
            errors.push({
              timestamp: new Date().toISOString(),
              phase,
              recordId: String(row.id),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].id) : null;
        return {
          scanned,
          repaired,
          skipped,
          failed,
          nextCursor,
          hasMore: rows.length === batchSize,
          actions,
          errors,
        };
      }
    }
  }

  private buildReport(checkpoint: RepairCheckpoint): RepairExecutionReport {
    const started = new Date(checkpoint.startedAt).getTime();
    const end = checkpoint.completedAt
      ? new Date(checkpoint.completedAt).getTime()
      : new Date(checkpoint.updatedAt).getTime();

    return {
      jobId: checkpoint.id,
      status: checkpoint.status,
      dryRun: checkpoint.dryRun,
      startedAt: checkpoint.startedAt,
      completedAt: checkpoint.completedAt,
      durationMs: Math.max(0, end - started),
      currentPhase: checkpoint.phase,
      cursor: checkpoint.cursor,
      counts: {
        scanned: checkpoint.scannedCount,
        repaired: checkpoint.repairedCount,
        skipped: checkpoint.skippedCount,
        failed: checkpoint.failedCount,
      },
      errors: checkpoint.errors,
      actionLogSample: checkpoint.actionLog.slice(-50),
    };
  }
}
