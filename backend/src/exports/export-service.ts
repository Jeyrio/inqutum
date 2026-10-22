/**
 * Privacy-safe invoice data export (issue #52).
 *
 *  - Schema: `quittance.invoice-export` with an explicit version. Only fields in
 *    EXPORT_FIELDS are ever emitted (allow-list), so customer/payer/seller
 *    personal data (names, emails) can never leak by adding a column upstream.
 *  - Authorization: an export is generated for, and downloadable by, exactly one
 *    wallet: the requester. Asking for another wallet's scope is denied, and
 *    another wallet's artifact id looks like it does not exist.
 *  - Retention: generated artifacts expire (default 24 h) and are purged; each
 *    requester keeps a bounded number of artifacts.
 *  - Size: generation pages through storage and stops at maxRecords, marking
 *    the export `truncated` so nothing is silently cut.
 *  - Cancellation: `create` accepts an optional AbortSignal, checked between
 *    storage pages, so a caller that disconnects or times out mid-export can
 *    stop in-flight work. No partial artifact is ever persisted — `this.
 *    artifacts.set` only runs after the full page loop completes, so a
 *    cancelled export leaves no stale/incomplete record to clean up.
 */

import { v4 as uuidv4 } from 'uuid';
import type { InvoiceStorage, StoredInvoice } from '../storage/invoice-storage';
import { redactSensitiveText } from '../security/redaction';

export const EXPORT_SCHEMA_ID = 'quittance.invoice-export';
export const EXPORT_SCHEMA_VERSION = 1;

export const EXPORT_FIELDS = [
  'id',
  'memo',
  'status',
  'amount',
  'assetCode',
  'assetIssuer',
  'description',
  'createdAt',
  'expiresAt',
  'paidAt',
  'paymentTxHash',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];
export type ExportRecord = Record<ExportField, string | number | null>;

export type ExportFormat = 'json' | 'csv';

export interface ExportRequest {
  format: ExportFormat;
  status?: string;
  from?: Date;
  to?: Date;
}

export interface ExportMetadata {
  schema: typeof EXPORT_SCHEMA_ID;
  schemaVersion: number;
  exportId: string;
  generatedAt: string;
  /** After this instant the artifact is deleted and can no longer be downloaded. */
  expiresAt: string;
  scope: { sellerPublicKey: string };
  filters: { status: string | null; from: string | null; to: string | null };
  recordCount: number;
  /** True when the record cap was hit; narrow the filters to get the rest. */
  truncated: boolean;
  fields: readonly ExportField[];
}

export interface ExportArtifact {
  meta: ExportMetadata;
  format: ExportFormat;
  contentType: string;
  body: string;
  owner: string;
}

export type ExportLookup =
  | { state: 'ok'; artifact: ExportArtifact }
  | { state: 'not_found' }
  | { state: 'expired' };

export interface ExportServiceOptions {
  now?: () => Date;
  retentionMs?: number;
  maxRecords?: number;
  pageSize?: number;
  maxArtifactsPerRequester?: number;
}

export class ExportForbiddenError extends Error {
  constructor(message = 'You can only export your own invoices') {
    super(message);
    this.name = 'ExportForbiddenError';
  }
}

export class ExportCancelledError extends Error {
  constructor(message = 'Export was cancelled before it completed') {
    super(message);
    this.name = 'ExportCancelledError';
  }
}

export class ExportConfigurationError extends Error {
  constructor(field: keyof Pick<ExportServiceOptions, 'retentionMs' | 'maxRecords' | 'pageSize' | 'maxArtifactsPerRequester'>) {
    super(`${field} must be a positive safe integer`);
    this.name = 'ExportConfigurationError';
  }
}

const DEFAULTS = {
  retentionMs: 24 * 60 * 60 * 1000,
  maxRecords: 10_000,
  pageSize: 500,
  maxArtifactsPerRequester: 20,
};

const MAX_EXPIRED_TOMBSTONES = 1_000;

/** Cells starting with these are interpreted as formulas by spreadsheet apps. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const iso = (d: Date | string | undefined): string | null => (d ? new Date(d).toISOString() : null);

function positiveInt(
  field: keyof Pick<ExportServiceOptions, 'retentionMs' | 'maxRecords' | 'pageSize' | 'maxArtifactsPerRequester'>,
  value: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ExportConfigurationError(field);
  return value;
}

export function toExportRecord(invoice: StoredInvoice): ExportRecord {
  return {
    id: invoice.id,
    memo: typeof invoice.memo === 'string' ? redactSensitiveText(invoice.memo) : invoice.memo,
    status: invoice.status,
    amount: invoice.amount,
    assetCode: invoice.assetCode,
    assetIssuer: invoice.assetIssuer ?? null,
    description: typeof invoice.description === 'string' ? redactSensitiveText(invoice.description) : null,
    createdAt: iso(invoice.createdAt),
    expiresAt: iso(invoice.expiresAt),
    paidAt: iso(invoice.paidAt),
    paymentTxHash: invoice.paymentTxHash ?? null,
  };
}

export class ExportService {
  private artifacts = new Map<string, ExportArtifact>();
  /** Remembers who an expired id belonged to so the owner gets 410 instead of 404. Bounded. */
  private expiredIds = new Map<string, string>();
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly pageSize: number;
  private readonly maxArtifacts: number;

  constructor(private readonly storage: InvoiceStorage, options: ExportServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retentionMs = positiveInt('retentionMs', options.retentionMs ?? DEFAULTS.retentionMs);
    this.maxRecords = positiveInt('maxRecords', options.maxRecords ?? DEFAULTS.maxRecords);
    this.pageSize = positiveInt('pageSize', options.pageSize ?? DEFAULTS.pageSize);
    this.maxArtifacts = positiveInt('maxArtifactsPerRequester', options.maxArtifactsPerRequester ?? DEFAULTS.maxArtifactsPerRequester);
  }

  /**
   * @param requester wallet asking for the export
   * @param scope wallet whose data is requested; defaults to the requester and
   *              must equal it, otherwise the export is denied
   * @param signal optional AbortSignal; checked between storage pages so a
   *               caller that disconnects or times out can cancel a large
   *               export in flight. Throws ExportCancelledError on abort.
   */
  async create(
    requester: string,
    request: ExportRequest,
    scope: string = requester,
    signal?: AbortSignal
  ): Promise<ExportArtifact> {
    if (scope !== requester) throw new ExportForbiddenError();
    this.purgeExpired();

    const records: ExportRecord[] = [];
    let truncated = false;
    // Keyset paging (createdAt, id): stable when invoices are inserted or
    // deleted while the export runs, unlike offset paging which shifts rows.
    let after: { createdAt: Date; id: string } | undefined;
    const seenIds = new Set<string>();
    while (!truncated) {
      if (signal?.aborted) throw new ExportCancelledError();
      const page = await this.storage.getInvoicesBySeller(requester, request.status, this.pageSize, 0, after);
      if (signal?.aborted) throw new ExportCancelledError();
      const tail = page[page.length - 1];
      if (tail) after = { createdAt: new Date(new Date(tail.createdAt).getTime()), id: tail.id };
      const before = seenIds.size;
      for (const invoice of page) {
        if (seenIds.has(invoice.id)) continue;
        seenIds.add(invoice.id);
        // Defence in depth: never emit a row that is not the requester's.
        if (invoice.sellerPublicKey !== requester) continue;
        const created = new Date(invoice.createdAt).getTime();
        if (request.from && created < request.from.getTime()) continue;
        if (request.to && created > request.to.getTime()) continue;
        if (records.length >= this.maxRecords) {
          truncated = true;
          break;
        }
        records.push(toExportRecord(invoice));
      }
      if (page.length < this.pageSize || seenIds.size === before) break;
    }

    const generatedAt = this.now();
    const meta: ExportMetadata = {
      schema: EXPORT_SCHEMA_ID,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportId: uuidv4(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + this.retentionMs).toISOString(),
      scope: { sellerPublicKey: requester },
      filters: { status: request.status ?? null, from: iso(request.from), to: iso(request.to) },
      recordCount: records.length,
      truncated,
      fields: EXPORT_FIELDS,
    };

    const artifact: ExportArtifact = {
      meta,
      format: request.format,
      contentType: request.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      body: request.format === 'csv' ? this.renderCsv(records) : JSON.stringify({ ...meta, records }, null, 2),
      owner: requester,
    };
    this.artifacts.set(meta.exportId, artifact);
    this.enforceQuota(requester);
    return artifact;
  }

  /** Not-found and not-yours are indistinguishable on purpose. */
  get(requester: string, id: string): ExportLookup {
    this.purgeExpired();
    const artifact = this.artifacts.get(id);
    if (artifact && artifact.owner === requester) return { state: 'ok', artifact };
    if (!artifact && this.expiredIds.get(id) === requester) return { state: 'expired' };
    return { state: 'not_found' };
  }

  purgeExpired(): number {
    const nowMs = this.now().getTime();
    let purged = 0;
    for (const [id, artifact] of this.artifacts) {
      if (new Date(artifact.meta.expiresAt).getTime() <= nowMs) {
        this.artifacts.delete(id);
        this.expiredIds.set(id, artifact.owner);
        purged += 1;
      }
    }
    while (this.expiredIds.size > MAX_EXPIRED_TOMBSTONES) {
      this.expiredIds.delete(this.expiredIds.keys().next().value as string);
    }
    return purged;
  }

  size(): number {
    return this.artifacts.size;
  }

  private enforceQuota(owner: string): void {
    const mine = [...this.artifacts.values()].filter((a) => a.owner === owner);
    for (const old of mine.slice(0, Math.max(0, mine.length - this.maxArtifacts))) {
      this.artifacts.delete(old.meta.exportId);
    }
  }

  private renderCsv(records: ExportRecord[]): string {
    const header = EXPORT_FIELDS.join(',');
    const rows = records.map((r) => EXPORT_FIELDS.map((f) => csvCell(r[f])).join(','));
    return [header, ...rows].join('\r\n') + '\r\n';
  }
}

/** Source of rows for the generic export helper. */
export interface ExportRepository<T extends Record<string, unknown>> {
  load(request: { actorId: string; resource: string }): Promise<T[]>;
}

export type GenericExportResult =
  | { ok: true; code: 'EXPORT_READY'; format: ExportFormat; body: string; count: number }
  | { ok: false; code: 'EXPORT_INVALID_REQUEST'; recoverable: false }
  | { ok: false; code: 'EXPORT_RETRYABLE_DEPENDENCY'; recoverable: true };

/**
 * Exports any row set as JSON or CSV. CSV columns are the sorted union of row
 * keys, so the output is deterministic whatever the key order of the rows.
 */
export async function buildExport<T extends Record<string, unknown>>(
  repository: ExportRepository<T>,
  request: { actorId: string; resource: string; format: ExportFormat }
): Promise<GenericExportResult> {
  if (!request.actorId?.trim() || !request.resource?.trim() || !['json', 'csv'].includes(request.format)) {
    return { ok: false, code: 'EXPORT_INVALID_REQUEST', recoverable: false };
  }
  let rows: T[];
  try {
    rows = await repository.load({ actorId: request.actorId, resource: request.resource });
  } catch {
    return { ok: false, code: 'EXPORT_RETRYABLE_DEPENDENCY', recoverable: true };
  }
  if (request.format === 'json') {
    return { ok: true, code: 'EXPORT_READY', format: 'json', body: JSON.stringify(rows), count: rows.length };
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const cell = (value: unknown) =>
    csvCell(value === null || value === undefined ? null : typeof value === 'number' ? value : String(value));
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))];
  return { ok: true, code: 'EXPORT_READY', format: 'csv', body: lines.join('\n'), count: rows.length };
}
