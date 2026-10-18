// Keyset pagination for invoice lists. Rows are ordered newest first by
// (createdAt ms, id) — id breaks ties so the order is total and a cursor
// always points between two exact rows, regardless of inserts or status
// changes happening while a client pages.

export interface InvoiceCursor {
  /** createdAt truncated to milliseconds (Postgres compares at the same precision). */
  createdAt: Date;
  id: string;
}

export interface CursorValidationResult {
  valid: boolean;
  cursor: InvoiceCursor | null;
  errorCode?: 'INVALID_CURSOR';
  errorMessage?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeInvoiceCursor(invoice: { createdAt: Date | string | number; id: string }): string {
  if (!invoice || typeof invoice !== 'object') {
    throw new TypeError('Cannot encode cursor: invoice must be an object');
  }

  const rawId = typeof invoice.id === 'string' ? invoice.id.trim() : '';
  if (!rawId || !UUID.test(rawId)) {
    throw new TypeError(`Cannot encode cursor: invalid invoice id "${invoice.id}"`);
  }

  const date = invoice.createdAt instanceof Date ? invoice.createdAt : new Date(invoice.createdAt);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Cannot encode cursor: invalid createdAt date "${invoice.createdAt}"`);
  }

  const raw = `${date.toISOString()}|${rawId.toLowerCase()}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this server issued. */
export function decodeInvoiceCursor(value: unknown): InvoiceCursor | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || !BASE64URL_PATTERN.test(trimmed)) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split('|');
  if (parts.length !== 2) return null;

  const [iso, id] = parts;
  if (!id || !UUID.test(id) || !iso || !ISO_DATE_PATTERN.test(iso)) return null;

  const createdAt = new Date(iso);
  if (!Number.isFinite(createdAt.getTime())) return null;

  const isoNormalized = createdAt.toISOString();
  if (isoNormalized !== iso && isoNormalized.replace(/\.000Z$/, 'Z') !== iso) {
    return null;
  }

  return { createdAt, id: id.toLowerCase() };
}

/** Validates an incoming cursor string against the stable server contract. */
export function validateInvoiceCursor(value: unknown): CursorValidationResult {
  const cursor = decodeInvoiceCursor(value);
  if (!cursor) {
    return {
      valid: false,
      cursor: null,
      errorCode: 'INVALID_CURSOR',
      errorMessage: 'cursor is not valid; restart from the first page',
    };
  }
  return { valid: true, cursor };
}

/** Newest first, then id descending — the one ordering every backend uses. */
export function compareNewestFirst(
  a: { createdAt: Date | string | number; id: string },
  b: { createdAt: Date | string | number; id: string }
): number {
  const timeA =
    a?.createdAt instanceof Date
      ? a.createdAt.getTime()
      : typeof a?.createdAt === 'number'
        ? a.createdAt
        : new Date(a?.createdAt).getTime();

  const timeB =
    b?.createdAt instanceof Date
      ? b.createdAt.getTime()
      : typeof b?.createdAt === 'number'
        ? b.createdAt
        : new Date(b?.createdAt).getTime();

  const safeA = Number.isFinite(timeA) ? timeA : 0;
  const safeB = Number.isFinite(timeB) ? timeB : 0;

  const byTime = safeB - safeA;
  if (byTime !== 0) return byTime;

  const idA = String(a?.id ?? '').toLowerCase();
  const idB = String(b?.id ?? '').toLowerCase();
  return idA < idB ? 1 : idA > idB ? -1 : 0;
}

/** True when the invoice sorts strictly after the cursor position. */
export function isAfterCursor(
  invoice: { createdAt: Date | string | number; id: string },
  cursor: InvoiceCursor
): boolean {
  if (!invoice || !cursor) return false;
  return compareNewestFirst(cursor, invoice) < 0;
}
