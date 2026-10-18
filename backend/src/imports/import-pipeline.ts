/**
 * Import validation and planning (#53).
 *
 * Everything in this module is pure: it takes parsed rows, an existing-record
 * lookup and a clock, and returns a decision per row. No database handle, no
 * writes, no clock reads. That is the same separation the retention sweep uses,
 * and for the same reason: the decision is the dangerous part, so it must be
 * reviewable and testable on its own.
 *
 * The importer can produce four outcomes, and the issue's dry-run output is
 * exactly the histogram of them:
 *
 *   create — the source record is new
 *   update — it exists and descriptive fields drifted
 *   skip   — it exists and already matches, so a re-run is a no-op
 *   error  — the row is invalid, conflicts, or asks for something an import
 *            is not allowed to do
 */

import { z } from 'zod';

import { createInvoiceSchema, stellarPublicKeySchema } from '../utils/validation';
import { NATIVE_ASSET_CODE, requiresIssuer } from '../utils/asset-helpers';
import { MIN_INVOICE_EXPIRY_DAYS, MAX_INVOICE_EXPIRY_DAYS, DEFAULT_INVOICE_EXPIRY_DAYS } from '../domain/invoice-expiry';
import { isValidMemo } from '../utils/memo';
import type { RawImportRow } from './import-format';

export type ImportAction = 'create' | 'update' | 'skip' | 'error';

/** Fields an import may change on an existing invoice. */
const MUTABLE_FIELDS = [
  'sellerName',
  'sellerEmail',
  'customerName',
  'customerEmail',
  'description',
  'expiresAt',
  'metadata',
] as const;

/** Fields that identify what is being paid; changing them is not an update. */
const IDENTITY_FIELDS = ['amount', 'assetCode', 'assetIssuer', 'sellerPublicKey'] as const;

export interface ImportError {
  line: number;
  field?: string;
  message: string;
}

export interface ExistingInvoice {
  id: string;
  externalId: string | null;
  memo: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  amount: number;
  assetCode: string;
  assetIssuer: string | null;
  sellerPublicKey: string;
  sellerName: string | null;
  sellerEmail: string | null;
  customerName: string | null;
  customerEmail: string | null;
  description: string | null;
  expiresAt: Date;
  metadata: Record<string, unknown> | null;
}

/** A row that survived validation, normalised into insertable/updateable shape. */
export interface ValidatedRow {
  line: number;
  externalId: string | null;
  /**
   * Mutable fields the source row actually supplied. An import omits a column
   * to mean "leave this alone", not "reset it to the default" — so a file with
   * no expiry column must not shift an existing invoice's expiry, or every
   * re-import would report a change and rewrite rows that never moved.
   */
  supplied: readonly string[];
  /** Present when the row cannot be made idempotent across runs. */
  nonIdempotent: boolean;
  invoice: z.infer<typeof createInvoiceSchema> & {
    createdAt?: Date;
    expiresAt?: Date;
    memo?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface PlannedRow {
  line: number;
  action: ImportAction;
  externalId: string | null;
  /**
   * The validated, normalised values for this row, present whenever the action
   * is one that writes. Carried on the plan so the executor never has to
   * re-derive, or disagree with, what validation decided.
   */
  invoice?: ValidatedRow['invoice'];
  /** Existing row this decision refers to, when the action is not a create. */
  existingId?: string;
  changes?: Partial<Record<string, { from: unknown; to: unknown }>>;
  errors: ImportError[];
  /** Non-fatal remark worth surfacing in the dry-run report. */
  warnings: string[];
}

export interface ImportPlan {
  rows: PlannedRow[];
  counts: Record<ImportAction, number>;
  total: number;
  /** Fatal problems that stopped planning before any row was examined. */
  formatErrors: string[];
  /**
   * How this plan was built. `applyImport` reads it so an operator who
   * deliberately chose `skip` is not blocked by the errors they chose to skip,
   * and an `abort` plan still cannot be applied with errors in it.
   */
  onError: 'abort' | 'skip';
  dryRun: true;
}

export interface ValidateOptions {
  now?: Date;
}

function firstError(error: z.ZodError): ImportError {
  const issue = error.issues[0]!;
  const field = issue.path.length > 0 ? String(issue.path[0]) : undefined;
  return { line: 0, field, message: issue.message };
}

function parseNumber(raw: string | undefined, field: string, line: number): number | ImportError {
  if (raw === undefined || raw === '') return { line, field, message: `${field} is required` };
  // Tolerate a thousands separator and a currency symbol only if unambiguous;
  // "1,234.50" in a CSV arrives unquoted as two fields, so anything still
  // containing a comma here is an operator error worth reporting.
  const cleaned = raw.replace(/^\$/, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { line, field, message: `${field} must be a plain decimal number (got "${raw}")` };
  }
  return Number(cleaned);
}

function parseTimestamp(raw: string | undefined, field: string, line: number): Date | ImportError | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return { line, field, message: `${field} must be an ISO-8601 timestamp (got "${raw}")` };
  }
  return new Date(ms);
}

function parseMetadata(raw: string | undefined, line: number): Record<string, unknown> | ImportError | undefined {
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { line, field: 'metadata', message: `metadata must be a JSON object (${(error as Error).message})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { line, field: 'metadata', message: 'metadata must be a JSON object' };
  }
  return parsed as Record<string, unknown>;
}

function isError(value: unknown): value is ImportError {
  return typeof value === 'object' && value !== null && 'message' in value && 'line' in value;
}

/**
 * Validate one row against the import format and the same rules the public API
 * enforces, by funnelling the row through `createInvoiceSchema`. Reusing the
 * schema is the point: an import must not be able to create an invoice the API
 * would reject.
 */
export function validateRow(row: RawImportRow, options: ValidateOptions = {}): ValidatedRow | ImportError[] {
  const now = options.now ?? new Date();
  const errors: ImportError[] = [];
  const v = row.values;

  const externalId = v.externalId === '' ? null : v.externalId;
  if (externalId !== null && externalId.length > 255) {
    errors.push({ line: row.line, field: 'externalId', message: 'externalId must be at most 255 characters' });
  }

  const amount = parseNumber(v.amount ?? '', 'amount', row.line);
  if (isError(amount)) errors.push(amount);
  else if (amount <= 0) errors.push({ line: row.line, field: 'amount', message: 'amount must be greater than zero' });

  // An absent column and an empty one mean the same thing here, so a file that
  // omits assetCode gets the default rather than being asked for an issuer.
  const assetCode = v.assetCode === undefined || v.assetCode === '' ? NATIVE_ASSET_CODE : v.assetCode;
  const assetIssuer = v.assetIssuer === undefined || v.assetIssuer === '' ? undefined : v.assetIssuer;

  if (assetIssuer !== undefined && !stellarPublicKeySchema.safeParse(assetIssuer).success) {
    errors.push({ line: row.line, field: 'assetIssuer', message: 'assetIssuer is not a valid Stellar public key' });
  }
  if (assetCode !== NATIVE_ASSET_CODE && !assetIssuer) {
    errors.push({
      line: row.line,
      field: 'assetIssuer',
      message: `assetIssuer is required for asset "${assetCode}"; only ${NATIVE_ASSET_CODE} may omit it`,
    });
  }
  if (assetCode === NATIVE_ASSET_CODE && assetIssuer) {
    errors.push({
      line: row.line,
      field: 'assetIssuer',
      message: `${NATIVE_ASSET_CODE} is the native asset and must not carry an issuer`,
    });
  }

  const parsedCreatedAt = parseTimestamp(v.createdAt ?? '', 'createdAt', row.line);
  const createdAt = isError(parsedCreatedAt) ? undefined : parsedCreatedAt;
  if (isError(parsedCreatedAt)) errors.push(parsedCreatedAt);

  const parsedExpiresAt = parseTimestamp(v.expiresAt ?? '', 'expiresAt', row.line);
  const expiresAt = isError(parsedExpiresAt) ? undefined : parsedExpiresAt;
  if (isError(parsedExpiresAt)) errors.push(parsedExpiresAt);

  const parsedMetadata = parseMetadata(v.metadata ?? '', row.line);
  const metadata = isError(parsedMetadata) ? undefined : parsedMetadata;
  if (isError(parsedMetadata)) errors.push(parsedMetadata);

  let expiresInDays = DEFAULT_INVOICE_EXPIRY_DAYS;
  if (v.expiresInDays !== undefined && v.expiresInDays !== '') {
    const parsed = parseNumber(v.expiresInDays, 'expiresInDays', row.line);
    if (isError(parsed)) {
      errors.push(parsed);
    } else if (!Number.isInteger(parsed)) {
      errors.push({ line: row.line, field: 'expiresInDays', message: 'expiresInDays must be a whole number of days' });
    } else {
      expiresInDays = parsed;
      if (parsed < MIN_INVOICE_EXPIRY_DAYS || parsed > MAX_INVOICE_EXPIRY_DAYS) {
        errors.push({
          line: row.line,
          field: 'expiresInDays',
          message: `expiresInDays must be between ${MIN_INVOICE_EXPIRY_DAYS} and ${MAX_INVOICE_EXPIRY_DAYS}`,
        });
      }
    }
  }

  if (expiresAt && createdAt) {
    if (expiresAt.getTime() <= createdAt.getTime()) {
      errors.push({ line: row.line, field: 'expiresAt', message: 'expiresAt must be after createdAt' });
    }
  }

  if (v.memo !== undefined && v.memo !== '' && !isValidMemo(v.memo)) {
    errors.push({
      line: row.line,
      field: 'memo',
      message: 'memo must match INV-<alphanumeric>-<alphanumeric> when supplied',
    });
  }

  for (const [field, value] of [
    ['customerEmail', v.customerEmail],
    ['sellerEmail', v.sellerEmail],
  ] as const) {
    if (value !== undefined && value !== '' && !z.string().email().safeParse(value).success) {
      errors.push({ line: row.line, field, message: `${field} must be a valid email address` });
    }
  }

  if (errors.length > 0) return errors;

  // Funnel through the API's own schema so import and HTTP cannot diverge.
  const candidate = {
    amount: amount as number,
    assetCode,
    assetIssuer,
    description: v.description === '' ? undefined : v.description,
    customerName: v.customerName === '' ? undefined : v.customerName,
    customerEmail: v.customerEmail === '' ? undefined : v.customerEmail,
    sellerName: v.sellerName === '' ? undefined : v.sellerName,
    sellerEmail: v.sellerEmail === '' ? undefined : v.sellerEmail,
    expiresInDays,
    sellerPublicKey: v.sellerPublicKey ?? '',
  };
  const parsedInvoice = createInvoiceSchema.safeParse(candidate);
  if (!parsedInvoice.success) {
    return parsedInvoice.error.issues.map((issue) => {
      const base = firstError(parsedInvoice.error);
      return {
        line: row.line,
        field: issue.path.length > 0 ? String(issue.path[0]) : base.field,
        message: issue.message,
      };
    });
  }

  const supplied: string[] = ['amount', 'sellerPublicKey', 'assetCode'];
  if (v.assetIssuer !== undefined && v.assetIssuer !== '') supplied.push('__assetIssuer', 'assetIssuer');
  supplied.push(...MUTABLE_FIELDS.filter((field) => {
    if (field === 'expiresAt') {
      return v.expiresAt !== undefined && v.expiresAt !== ''
        ? true
        : v.expiresInDays !== undefined && v.expiresInDays !== '';
    }
    if (field === 'metadata') return v.metadata !== undefined && v.metadata !== '';
    return v[field] !== undefined && v[field] !== '';
  }));

  return {
    line: row.line,
    externalId,
    nonIdempotent: externalId === null,
    supplied,
    invoice: {
      ...parsedInvoice.data,
      ...(createdAt ? { createdAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(v.memo === undefined || v.memo === '' ? {} : { memo: v.memo }),
      ...(metadata === undefined ? {} : { metadata }),
    },
  };
}

/**
 * Whether the source row named an asset issuer. The validated invoice cannot
 * tell us, because an absent issuer and an XLM row both end up undefined.
 */
function v_assetIssuerSupplied(row: ValidatedRow): boolean {
  return row.supplied.includes('__assetIssuer');
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return String(a) === String(b);
}

export interface PlanOptions extends ValidateOptions {
  /**
   * Records already in the database, keyed by externalId and by id. Memo is
   * also an identity key so a file that supplies memos is idempotent without
   * supplying external IDs.
   */
  existing?: ExistingInvoice[];
  /**
   * `abort` (default) refuses the whole file when any row is invalid, so a
   * half-valid file cannot be applied. `skip` imports the valid rows and
   * reports the rest.
   */
  onError?: 'abort' | 'skip';
}

function indexExisting(existing: ExistingInvoice[]): Map<string, ExistingInvoice> {
  const byKey = new Map<string, ExistingInvoice>();
  for (const record of existing) {
    if (record.externalId) byKey.set(`external:${record.externalId}`, record);
    byKey.set(`memo:${record.memo}`, record);
  }
  return byKey;
}

function expiryFor(row: ValidatedRow): Date {
  if (row.invoice.expiresAt) return row.invoice.expiresAt;
  const createdAt = row.invoice.createdAt ?? new Date();
  return new Date(createdAt.getTime() + row.invoice.expiresInDays * 24 * 60 * 60 * 1000);
}

/**
 * Decide what to do with every row. Pure and side-effect free.
 */
export function planImport(rows: RawImportRow[], options: PlanOptions = {}): ImportPlan {
  const now = options.now ?? new Date();
  const onError = options.onError ?? 'abort';
  const byKey = indexExisting(options.existing ?? []);

  const planned: PlannedRow[] = [];
  // First occurrence of an identity wins, so a duplicated row cannot overwrite
  // the row above it in the same file.
  const claimed = new Map<string, number>();

  for (const raw of rows) {
    const errors: ImportError[] = [];
    const warnings: string[] = [];
    const validated = validateRow(raw, { now });

    if (Array.isArray(validated)) {
      errors.push(...validated);
      planned.push({ line: raw.line, action: 'error', externalId: null, errors, warnings });
      continue;
    }

    const identityKeys = [
      ...(validated.externalId ? [`external:${validated.externalId}`] : []),
      ...(validated.invoice.memo ? [`memo:${validated.invoice.memo}`] : []),
    ];
    const seen = identityKeys.map((k) => claimed.get(k)).find((line) => line !== undefined);
    if (seen !== undefined) {
      errors.push({
        line: raw.line,
        field: validated.externalId ? 'externalId' : 'memo',
        message: `duplicate: already defined on row ${seen} of this file`,
      });
      planned.push({
        line: raw.line,
        action: 'error',
        externalId: validated.externalId,
        errors,
        warnings,
      });
      continue;
    }

    const match = identityKeys.map((k) => byKey.get(k)).find((r) => r !== undefined);

    if (!match) {
      if (validated.nonIdempotent) {
        warnings.push(
          'no externalId supplied, so this row is not idempotent: re-running the file will create a second invoice'
        );
      }
      for (const key of identityKeys) claimed.set(key, raw.line);
      planned.push({
        line: raw.line,
        action: 'create',
        externalId: validated.externalId,
        invoice: validated.invoice,
        errors,
        warnings,
      });
      continue;
    }

    // A settled invoice is evidence, not editable state. It is reported as an
    // error only when the file actually asks for a change; a matching row skips
    // quietly, so re-importing an archived file stays a no-op.
    const changes: PlannedRow['changes'] = {};
    for (const field of IDENTITY_FIELDS) {
      // An omitted identity column carries no claim about the stored value, so
      // there is nothing to disagree with. What it does supply must match.
      if (field === 'amount' || field === 'sellerPublicKey' || field === 'assetCode' || field === 'assetIssuer') {
        const column = { amount: 'amount', sellerPublicKey: 'sellerPublicKey', assetCode: 'assetCode', assetIssuer: 'assetIssuer' }[field]!;
        const suppliedHere =
          column === 'amount' || column === 'sellerPublicKey' || column === 'assetCode'
            ? true
            : v_assetIssuerSupplied(validated);
        if (!suppliedHere) continue;
      }
      const next = validated.invoice[field] ?? null;
      const current = (match as unknown as Record<string, unknown>)[field] ?? null;
      if (!sameValue(next, current)) {
        errors.push({
          line: raw.line,
          field,
          message: `${field} differs from the stored invoice (${String(current)} -> ${String(next)}); a payment's terms are not editable by import`,
        });
      }
    }
    for (const field of MUTABLE_FIELDS) {
      if (!validated.supplied.includes(field)) continue;
      const next = normalisedField(validated, field);
      const current = (match as unknown as Record<string, unknown>)[field] ?? null;
      if (!sameValue(next, current)) changes![field] = { from: current, to: next };
    }

    if (errors.length > 0) {
      planned.push({
        line: raw.line,
        action: 'error',
        externalId: validated.externalId,
        existingId: match.id,
        errors,
        warnings,
      });
      continue;
    }

    if (match.status === 'PAID' && Object.keys(changes!).length > 0) {
      planned.push({
        line: raw.line,
        action: 'error',
        externalId: validated.externalId,
        existingId: match.id,
        errors: [
          {
            line: raw.line,
            message: `invoice is already PAID; refusing to modify a settled invoice (${Object.keys(changes!).join(', ')})`,
          },
        ],
        warnings,
      });
      continue;
    }

    const action: ImportAction = Object.keys(changes!).length === 0 ? 'skip' : 'update';
    for (const key of identityKeys) claimed.set(key, raw.line);
    planned.push({
      line: raw.line,
      action,
      externalId: validated.externalId,
      invoice: validated.invoice,
      existingId: match.id,
      changes: action === 'update' ? changes : undefined,
      errors,
      warnings,
    });
  }

  const counts: Record<ImportAction, number> = { create: 0, update: 0, skip: 0, error: 0 };
  for (const row of planned) counts[row.action] += 1;

  const formatErrors: string[] = [];
  if (onError === 'abort' && counts.error > 0) {
    formatErrors.push(
      `refusing to import: ${counts.error} row(s) failed validation and onError=abort is in effect`
    );
  }

  return { rows: planned, counts, total: planned.length, formatErrors, onError, dryRun: true };
}

function normalisedField(
  row: ValidatedRow,
  field: (typeof MUTABLE_FIELDS)[number]
): unknown {
  switch (field) {
    case 'expiresAt':
      return expiryFor(row);
    case 'metadata':
      return row.invoice.metadata ?? null;
    default: {
      const value = (row.invoice as Record<string, unknown>)[field];
      return value === undefined ? null : value;
    }
  }
}
