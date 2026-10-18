/**
 * Stable keyset (cursor) pagination under inserts, deletes and permission changes.
 *
 * Guarantees (pinned by tests/stable-cursor.test.ts):
 *   1. Deterministic order: (sortKey DESC, id DESC) is a total order, so a
 *      cursor always sits between two exact positions.
 *   2. Inserts: rows inserted "above" the cursor (newer) never appear on later
 *      pages; rows inserted below appear exactly once. No duplicates.
 *   3. Deletes: the cursor stores values, not a row reference, so deleting the
 *      anchor row (or any row) never breaks or shifts paging.
 *   4. Permissions: `canView` is evaluated on every request against current
 *      state. A row that became forbidden between pages is never returned, and
 *      `hasMore`/`nextCursor` are computed from visible rows only, so the
 *      existence of hidden rows does not leak through page sizes.
 *   5. Scope binding: the cursor is HMAC-signed together with a hash of the
 *      viewer + filter. Replaying a cursor as another viewer, with a changed
 *      filter, or after tampering returns INVALID_CURSOR (restart from page 1)
 *      instead of silently paging a different result set.
 *
 * Cursors carry no record content: only the sort value, the id and a signature.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export interface Pageable {
  id: string;
  /** Sort key; Date, ISO string or epoch ms. Truncated to ms. */
  sortKey: Date | string | number;
}

export interface StableCursorOptions<T> {
  /** Opaque cursor from a previous page, or undefined for page 1. */
  cursor?: string | null;
  limit?: number;
  maxLimit?: number;
  /** Current permission check; evaluated per row on every request. */
  canView: (row: T) => boolean;
  /** Viewer identity + active filters. Cursor is only valid for the same scope. */
  scope: Record<string, unknown>;
  secret: string;
}

export interface StablePage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export class InvalidStableCursorError extends Error {
  readonly code = 'INVALID_CURSOR';
  constructor(public readonly reason: 'malformed' | 'signature' | 'scope') {
    super('cursor is not valid; restart from the first page');
    this.name = 'InvalidStableCursorError';
  }
}

const toMs = (v: Date | string | number): number => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? Math.trunc(t) : 0;
};

/** (sortKey DESC, id DESC). Negative when a sorts first. */
export function compareStable(a: { id: string; ms: number }, b: { id: string; ms: number }): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function scopeHash(scope: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(scope)).digest('base64url').slice(0, 22);
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
}

export function encodeStableCursor(position: { ms: number; id: string }, scope: Record<string, unknown>, secret: string): string {
  const body = `${position.ms}|${position.id}|${scopeHash(scope)}`;
  return Buffer.from(`${body}|${sign(secret, body)}`, 'utf8').toString('base64url');
}

export function decodeStableCursor(cursor: string, scope: Record<string, unknown>, secret: string): { ms: number; id: string } {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidStableCursorError('malformed');
  }
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length !== 4) throw new InvalidStableCursorError('malformed');
  const [msRaw, id, scopePart, sig] = parts;
  const ms = Number(msRaw);
  if (!/^\d{1,16}$/.test(msRaw) || !Number.isSafeInteger(ms) || !id) throw new InvalidStableCursorError('malformed');
  const expected = Buffer.from(sign(secret, `${msRaw}|${id}|${scopePart}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new InvalidStableCursorError('signature');
  }
  if (scopePart !== scopeHash(scope)) throw new InvalidStableCursorError('scope');
  return { ms, id };
}

/**
 * Paginate a snapshot of rows (in-memory backends, or the candidate set a
 * database keyset query returned). The function is pure: same input -> same page.
 */
export function paginateStable<T extends Pageable>(rows: readonly T[], options: StableCursorOptions<T>): StablePage<T> {
  const maxLimit = options.maxLimit ?? 200;
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50) || 50), maxLimit);
  const after = options.cursor ? decodeStableCursor(options.cursor, options.scope, options.secret) : null;

  const visible = rows
    .map((row) => ({ row, pos: { id: String(row.id), ms: toMs(row.sortKey) } }))
    .filter(({ row }) => {
      try {
        return options.canView(row) === true;
      } catch {
        return false; // permission check errors fail closed
      }
    })
    .filter(({ pos }) => !after || compareStable(after, pos) < 0)
    .sort((a, b) => compareStable(a.pos, b.pos));

  // Drop exact duplicate ids defensively (e.g. a row seen twice in a merged source).
  const seen = new Set<string>();
  const unique = visible.filter(({ pos }) => (seen.has(pos.id) ? false : (seen.add(pos.id), true)));

  const page = unique.slice(0, limit);
  const hasMore = unique.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((p) => p.row),
    hasMore,
    nextCursor: hasMore && last ? encodeStableCursor(last.pos, options.scope, options.secret) : null,
    limit,
  };
}

/** Postgres keyset predicate equivalent to `compareStable(after, row) < 0`. */
export function keysetSqlPredicate(sortColumn: string, idColumn: string, firstParam: number): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(sortColumn) || !/^[a-z_][a-z0-9_.]*$/i.test(idColumn)) {
    throw new Error('Invalid column identifier');
  }
  return `(date_trunc('milliseconds', ${sortColumn}), ${idColumn}) < (to_timestamp($${firstParam}::double precision / 1000), $${firstParam + 1})`;
}
