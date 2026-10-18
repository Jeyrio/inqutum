/**
 * Import execution and rollback (#53).
 *
 * `planImport` decides; this file executes. The executor is deliberately dull:
 * it takes a plan, opens one transaction, writes each row, and either commits
 * the whole thing or rolls back the whole thing. It never decides anything.
 *
 * Because "did the import half-work?" is the question every operator asks
 * afterwards, the executor takes a snapshot of every row it is about to touch
 * *before* it touches any of them, and hands it back. That snapshot is a
 * complete undo, and `rollbackImport` replays it — including deleting the rows
 * the import created, which a transaction rollback alone cannot do once the
 * import has committed and the session has moved on.
 */

import { randomUUID } from 'node:crypto';

import { generateInvoiceMemo } from '../utils/memo';
import type { ImportPlan, PlannedRow } from './import-pipeline';

export interface ImportClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}

export interface ImportDatabase {
  connect(): Promise<ImportClient>;
}

/** Everything needed to undo one applied import. */
export interface ImportSnapshot {
  version: 1;
  createdAt: string;
  /** Rows the import inserted, by invoice id. */
  created: { id: string; externalId: string | null; memo: string }[];
  /** Rows the import overwrote, with the values as they were before. */
  updated: { id: string; before: Record<string, unknown> }[];
  /** Free-form note about where the file came from. */
  source?: string;
}

export interface ApplyResult {
  dryRun: false;
  source: string;
  counts: ImportPlan['counts'];
  created: { line: number; id: string; memo: string; externalId: string | null }[];
  updated: { line: number; id: string; changed: string[] }[];
  skipped: number;
  snapshot: ImportSnapshot;
}

export class ImportAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportAbortedError';
  }
}

/**
 * Raised when an import or rollback is cancelled (#288). It is only ever thrown
 * before COMMIT, so the transaction was rolled back and nothing was written.
 */
export class ImportCancelledError extends Error {
  constructor(message = 'Import was cancelled before it committed; no rows were written') {
    super(message);
    this.name = 'ImportCancelledError';
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportCancelledError();
}

const COLUMNS = [
  'seller_public_key',
  'seller_name',
  'seller_email',
  'amount',
  'asset_code',
  'asset_issuer',
  'memo',
  'description',
  'customer_name',
  'customer_email',
  'expires_at',
  'metadata',
  'external_id',
  'created_at',
] as const;

function rowToSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    // Dates and numerics round-trip through JSON as strings; keep them as the
    // database returned them so the UPDATE below is a literal restore.
    before[key] = value instanceof Date ? value.toISOString() : value;
  }
  return before;
}

export interface ApplyOptions {
  source: string;
  now?: () => Date;
  client?: ImportClient;
  /**
   * Checked before every row and once more before COMMIT. An abort after COMMIT
   * is ignored: the import has landed and the caller still gets its snapshot.
   */
  signal?: AbortSignal;
}

/**
 * Load the current state of every row a plan would touch, so the plan can be
 * validated against reality and the snapshot can be taken in the same pass.
 */
export async function loadExisting(
  client: ImportClient,
  plan: ImportPlan
): Promise<Map<string, Record<string, unknown>>> {
  const ids = plan.rows.map((r) => r.externalId).filter((id): id is string => id !== null);
  if (ids.length === 0) return new Map();

  const { rows } = await client.query(
    `SELECT id, external_id, memo, status, amount, asset_code, asset_issuer, seller_public_key,
            seller_name, seller_email, customer_name, customer_email, description, expires_at, metadata
       FROM invoices
      WHERE external_id = ANY($1::text[])
         OR memo = ANY($1::text[])`,
    [ids]
  );

  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.external_id) byKey.set(`external:${row.external_id}`, row);
    byKey.set(`memo:${row.memo}`, row);
  }
  return byKey;
}

async function insertRow(
  client: ImportClient,
  row: PlannedRow,
  source: Required<{ source: string }> | { source: string },
  now: Date
): Promise<{ id: string; memo: string; externalId: string | null }> {
  const values = row.invoice;
  if (!values) {
    throw new ImportAbortedError(
      `row ${row.line}: internal error, validated values were not carried into the plan`
    );
  }

  const id = randomUUID();
  const memo = values.memo ?? generateInvoiceMemo();
  const createdAt = values.createdAt ?? now;

  const params: unknown[] = [
    values.sellerPublicKey,
    values.sellerName ?? null,
    values.sellerEmail ?? null,
    values.amount,
    values.assetCode,
    values.assetIssuer ?? null,
    memo,
    values.description ?? null,
    values.customerName ?? null,
    values.customerEmail ?? null,
    resolveExpiry(values, now).toISOString(),
    JSON.stringify(values.metadata ?? {}),
    row.externalId,
    createdAt.toISOString(),
  ];

  await client.query(
    `INSERT INTO invoices (id, ${COLUMNS.join(', ')})
     VALUES ($1, ${params.map((_, i) => `$${i + 2}`).join(', ')})`,
    [id, ...params]
  );

  return { id, memo, externalId: row.externalId };
}

/**
 * A row may carry an explicit `expiresAt`, or only `expiresInDays`. Resolve the
 * latter here so the INSERT always writes a concrete timestamp.
 */
function resolveExpiry(
  values: NonNullable<PlannedRow['invoice']>,
  now: Date
): Date {
  if (values.expiresAt) return values.expiresAt;
  const from = values.createdAt ?? now;
  return new Date(from.getTime() + values.expiresInDays * 24 * 60 * 60 * 1000);
}

/**
 * Apply a plan. Nothing is written unless the whole plan is applicable.
 */
export async function applyImport(
  db: ImportDatabase,
  plan: ImportPlan,
  options: ApplyOptions
): Promise<ApplyResult> {
  if (plan.formatErrors.length > 0) {
    throw new ImportAbortedError(
      `import aborted: ${plan.formatErrors.join('; ')}. Fix the rows above and re-run the dry run.`
    );
  }
  if (plan.counts.error > 0 && plan.onError === 'abort') {
    throw new ImportAbortedError(
      `import aborted: ${plan.counts.error} row(s) failed validation. Re-run with onError=skip to import the rest.`
    );
  }

  throwIfCancelled(options.signal);
  const now = options.now?.() ?? new Date();
  const ownsClient = options.client === undefined;
  const client = options.client ?? (await db.connect());

  const created: ApplyResult['created'] = [];
  const updated: ApplyResult['updated'] = [];
  const snapshot: ImportSnapshot = {
    version: 1,
    createdAt: now.toISOString(),
    created: [],
    updated: [],
    source: options.source,
  };

  try {
    await client.query('BEGIN');

    for (const row of plan.rows) {
      throwIfCancelled(options.signal);
      if (row.action === 'create') {
        const inserted = await insertRow(client, row, options, now);
        created.push({ line: row.line, ...inserted });
        snapshot.created.push(inserted);
        continue;
      }

      if (row.action !== 'update' || !row.existingId || !row.changes) continue;

      const { rows: beforeRows } = await client.query(
        'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
        [row.existingId]
      );
      const before = beforeRows[0];
      if (!before) {
        throw new ImportAbortedError(
          `row ${row.line}: invoice ${row.existingId} disappeared between the dry run and the apply`
        );
      }
      snapshot.updated.push({ id: row.existingId, before: rowToSnapshot(before) });

      const sets: string[] = [];
      const params: unknown[] = [row.existingId];
      const columnFor: Record<string, string> = {
        sellerName: 'seller_name',
        sellerEmail: 'seller_email',
        customerName: 'customer_name',
        customerEmail: 'customer_email',
        description: 'description',
        expiresAt: 'expires_at',
        metadata: 'metadata',
      };
      const changed = Object.entries(row.changes).filter(
        (entry): entry is [string, { from: unknown; to: unknown }] => entry[1] !== undefined
      );
      for (const [field, change] of changed) {
        const column = columnFor[field];
        if (!column) continue;
        params.push(
          field === 'metadata'
            ? JSON.stringify(change.to ?? {})
            : change.to instanceof Date
              ? (change.to as Date).toISOString()
              : (change.to ?? null)
        );
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) continue;
      sets.push('version = version + 1');

      await client.query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $1`, params);
      updated.push({ line: row.line, id: row.existingId, changed: Object.keys(row.changes) });
    }

    throwIfCancelled(options.signal);
    await client.query('COMMIT');
  } catch (error) {
    // One transaction for the whole file: a failure on row 900 cannot leave
    // rows 1-899 committed.
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    if (ownsClient) client.release();
    throw error;
  }

  if (ownsClient) client.release();

  return {
    dryRun: false,
    source: options.source,
    counts: { ...plan.counts, create: created.length, update: updated.length },
    created,
    updated,
    skipped: plan.counts.skip,
    snapshot,
  };
}

/**
 * Undo an applied import. Restores overwritten rows and deletes inserted ones.
 */
export async function rollbackImport(
  db: ImportDatabase,
  snapshot: ImportSnapshot,
  signal?: AbortSignal
): Promise<{
  restored: number;
  deleted: number;
}> {
  if (snapshot.version !== 1) {
    throw new ImportAbortedError(`unsupported snapshot version ${snapshot.version}`);
  }
  if (snapshot.created.length === 0 && snapshot.updated.length === 0) {
    return { restored: 0, deleted: 0 };
  }

  throwIfCancelled(signal);
  const client = await db.connect();
  let restored = 0;
  let deleted = 0;
  try {
    await client.query('BEGIN');

    for (const { id, before } of snapshot.updated) {
      throwIfCancelled(signal);
      const entries = Object.entries(before).filter(([key]) => key !== 'id');
      if (entries.length === 0) continue;
      const params: unknown[] = [id];
      const sets = entries.map(([key, value]) => {
        params.push(key === 'metadata' && value !== null ? JSON.stringify(value) : value);
        return `${key} = $${params.length}`;
      });
      await client.query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $1`, params);
      restored += 1;
    }

    for (const { id } of snapshot.created) {
      throwIfCancelled(signal);
      const result = await client.query('DELETE FROM invoices WHERE id = $1', [id]);
      deleted += result.rowCount ?? 0;
    }

    throwIfCancelled(signal);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore: surface the original failure.
    }
    client.release();
    throw error;
  }
  client.release();

  return { restored, deleted };
}
