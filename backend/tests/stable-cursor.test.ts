import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidStableCursorError, paginateStable, type Pageable } from '../src/domain/stable-cursor';

const SECRET = 'cursor-secret';
interface Row extends Pageable { owner: string; hidden?: boolean }

const base = Date.parse('2026-10-16T00:00:00.000Z');
const row = (n: number, owner = 'alice', extra: Partial<Row> = {}): Row => ({
  id: `id-${String(n).padStart(3, '0')}`,
  sortKey: new Date(base + Math.floor(n / 2) * 1000), // pairs share a timestamp -> tie-break on id
  owner,
  ...extra,
});

const viewAs = (viewer: string) => (r: Row) => r.owner === viewer && !r.hidden;

function pageAll(rows: () => Row[], viewer: string, limit: number, mutate?: (page: number) => void) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const p = paginateStable(rows(), { cursor, limit, canView: viewAs(viewer), scope: { viewer }, secret: SECRET });
    seen.push(...p.items.map((r) => r.id));
    cursor = p.nextCursor;
    mutate?.(++page);
  } while (cursor && page < 100);
  return seen;
}

describe('stable cursor pagination', () => {
  it('is deterministic and gap/dup free on a static set, including timestamp ties', () => {
    const data = Array.from({ length: 23 }, (_, i) => row(i));
    const seen = pageAll(() => data, 'alice', 5);
    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23);
    assert.deepEqual(pageAll(() => data, 'alice', 5), seen);
  });

  it('inserts above the cursor never appear; no duplicates', () => {
    const data = Array.from({ length: 10 }, (_, i) => row(i));
    let next = 100;
    const seen = pageAll(() => data, 'alice', 3, () => data.push(row(next++)));
    assert.equal(new Set(seen).size, seen.length);
    for (let i = 0; i < 10; i++) assert.ok(seen.includes(row(i).id));
    // first page was taken before inserts, newer rows sort before the cursor
    assert.ok(!seen.includes('id-101'));
  });

  it('deleting the anchor row and others does not break or shift paging', () => {
    let data = Array.from({ length: 12 }, (_, i) => row(i));
    const first = paginateStable(data, { limit: 4, canView: viewAs('alice'), scope: { viewer: 'alice' }, secret: SECRET });
    const anchor = first.items.at(-1)!.id;
    data = data.filter((r) => r.id !== anchor && r.id !== 'id-002');
    const second = paginateStable(data, { cursor: first.nextCursor, limit: 4, canView: viewAs('alice'), scope: { viewer: 'alice' }, secret: SECRET });
    const expected = [...Array.from({ length: 12 }, (_, i) => row(i))]
      .sort((a, b) => (+new Date(b.sortKey) - +new Date(a.sortKey)) || (a.id < b.id ? 1 : -1))
      .slice(4, 8)
      .map((r) => r.id);
    assert.deepEqual(second.items.map((r) => r.id), expected.filter((id) => id !== 'id-002'));
  });

  it('never returns records that became forbidden between requests', () => {
    const data = Array.from({ length: 10 }, (_, i) => row(i));
    const seen = pageAll(() => data, 'alice', 3, (page) => {
      if (page === 1) for (const r of data) if (Number(r.id.slice(3)) % 2 === 0) r.hidden = true;
    });
    const p1 = seen.slice(0, 3);
    const later = seen.slice(3);
    assert.equal(p1.length, 3);
    assert.ok(later.every((id) => Number(id.slice(3)) % 2 === 1), `leaked ${later}`);
  });

  it('hidden rows do not leak through hasMore', () => {
    const data = [row(1), row(2), row(3, 'mallory'), row(4, 'mallory')];
    data.sort(() => 0);
    const p = paginateStable(data, { limit: 2, canView: viewAs('alice'), scope: { viewer: 'alice' }, secret: SECRET });
    assert.equal(p.items.length, 2);
    assert.equal(p.hasMore, false);
    assert.equal(p.nextCursor, null);
  });

  it('a cursor cannot be replayed by another viewer or with a different filter', () => {
    const data = Array.from({ length: 6 }, (_, i) => row(i));
    const p = paginateStable(data, { limit: 2, canView: viewAs('alice'), scope: { viewer: 'alice', status: 'PENDING' }, secret: SECRET });
    assert.throws(
      () => paginateStable(data, { cursor: p.nextCursor, limit: 2, canView: viewAs('bob'), scope: { viewer: 'bob', status: 'PENDING' }, secret: SECRET }),
      (e: unknown) => e instanceof InvalidStableCursorError && e.reason === 'scope'
    );
    assert.throws(
      () => paginateStable(data, { cursor: p.nextCursor, limit: 2, canView: viewAs('alice'), scope: { viewer: 'alice', status: 'PAID' }, secret: SECRET }),
      InvalidStableCursorError
    );
  });

  it('rejects tampered and malformed cursors', () => {
    const data = Array.from({ length: 6 }, (_, i) => row(i));
    const opts = { limit: 2, canView: viewAs('alice'), scope: { viewer: 'alice' }, secret: SECRET };
    const p = paginateStable(data, opts);
    const decoded = Buffer.from(p.nextCursor!, 'base64url').toString('utf8').split('|');
    decoded[0] = String(Number(decoded[0]) + 1000);
    const forged = Buffer.from(decoded.join('|')).toString('base64url');
    assert.throws(() => paginateStable(data, { ...opts, cursor: forged }), (e: unknown) => (e as InvalidStableCursorError).reason === 'signature');
    for (const bad of ['', '!!!', 'a'.repeat(600), Buffer.from('x|y').toString('base64url')]) {
      assert.throws(() => paginateStable(data, { ...opts, cursor: bad || 'x' }), InvalidStableCursorError);
    }
  });

  it('permission check errors fail closed', () => {
    const p = paginateStable([row(1), row(2)], {
      limit: 5,
      canView: (r) => { if (r.id === 'id-001') throw new Error('acl backend down'); return true; },
      scope: {},
      secret: SECRET,
    });
    assert.deepEqual(p.items.map((r) => r.id), ['id-002']);
  });
});
