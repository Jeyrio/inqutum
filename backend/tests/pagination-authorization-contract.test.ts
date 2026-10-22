/**
 * Contract tests for pagination, filtering and authorization boundaries (#286).
 *
 * These run against the real HTTP surface rather than the handlers, and pin the
 * behaviour clients depend on (see docs/PAGINATION.md, docs/API_CONTRACTS.md):
 *
 *  - Pagination: complete newest-first walks with no duplicates or gaps, the
 *    `hasMore === (nextCursor !== null)` invariant, clamped `limit`, cursor
 *    precedence over `offset`, and idempotent page retries.
 *  - Filtering: case-insensitive status filter that holds on every page, and
 *    classified 400s for bad filters and cursors.
 *  - Authorization: wallet scoping (a cursor never widens the result set) and a
 *    sweep that drives every admin route declared in the contract through the
 *    missing / wrong / disabled token paths.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Keypair } from '@stellar/stellar-sdk';

import { API_CONTRACT, collectRoutes } from '../src/api/contract';
import { DOMAIN_ERROR_TAXONOMY } from '../src/errors/error-taxonomy';
import { compareNewestFirst } from '../src/storage/invoice-cursor';
import { walletAuth } from './fixtures/auth.fixture';

const ADMIN = 'pagination-contract-admin-token';
const SELLER_A = Keypair.random().publicKey();
const SELLER_B = Keypair.random().publicKey();
const A_COUNT = 7;
const B_COUNT = 3;

let mvp: Server;
let admin: Server;
let mvpBase: string;
let adminBase: string;
let pgRouter: any;
const createdA: Array<{ id: string; createdAt: string }> = [];
let cancelledA: string[] = [];

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

// Listing is owner-scoped (docs/ACCESS-CONTROL.md): each request acts as the
// wallet it lists.
const list = (query: Record<string, string | number>) =>
  call(
    mvpBase,
    'GET',
    `/api/invoices?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`,
    undefined,
    walletAuth(String(query.sellerPublicKey))
  );

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    STELLAR_NETWORK: 'TESTNET',
    STELLAR_HORIZON_URL: 'http://127.0.0.1:1',
    JOBS_ADMIN_TOKEN: ADMIN,
  });

  const app = (await import('../src/server-mvp')).default;
  mvp = app.listen(0);
  await new Promise((resolve) => mvp.once('listening', resolve));
  mvpBase = `http://127.0.0.1:${(mvp.address() as AddressInfo).port}`;

  const express = (await import('express')).default;
  pgRouter = (await import('../src/routes/index')).default;
  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use('/api', pgRouter);
  admin = adminApp.listen(0);
  await new Promise((resolve) => admin.once('listening', resolve));
  adminBase = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;

  for (let i = 0; i < A_COUNT + B_COUNT; i++) {
    const seller = i < A_COUNT ? SELLER_A : SELLER_B;
    const res = await call(mvpBase, 'POST', '/api/invoices', { sellerPublicKey: seller, amount: 10 + i, assetCode: 'XLM' }, walletAuth(seller));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    if (seller === SELLER_A) createdA.push({ id: res.body.data.invoice.id, createdAt: res.body.data.invoice.createdAt });
  }
  cancelledA = [createdA[1].id, createdA[4].id];
  for (const id of cancelledA) {
    assert.equal((await call(mvpBase, 'POST', `/api/invoices/${id}/cancel`, {}, walletAuth(SELLER_A))).status, 200);
  }
});

after(async () => {
  await Promise.all([mvp, admin].map((s) => s && new Promise((resolve) => s.close(resolve))));
});

/** Follows nextCursor to the end, asserting the page invariants on the way. */
async function walk(query: Record<string, string | number>) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const res = await list({ ...query, ...(cursor ? { cursor } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { pagination, data } = res.body;
    assert.equal(pagination.hasMore, pagination.nextCursor !== null, 'hasMore must agree with nextCursor');
    assert.equal(pagination.total, data.length, 'invoice-list total is the number of rows on the page');
    assert.ok(data.length <= pagination.limit);
    ids.push(...data.map((inv: any) => inv.id));
    if (!pagination.nextCursor) return { ids, rows: data };
    cursor = pagination.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('pagination contract — GET /api/invoices (#286)', () => {
  it('walks every invoice of the wallet exactly once, newest first', async () => {
    const { ids } = await walk({ sellerPublicKey: SELLER_A, limit: 3 });
    const expected = [...createdA].sort(compareNewestFirst).map((i) => i.id);

    assert.equal(new Set(ids).size, ids.length, 'no duplicates');
    assert.deepEqual(ids, expected, 'no gaps, newest first, ties broken by id');
  });

  it('clamps limit to 1..200 and echoes the effective value', async () => {
    const cases: Array<[string | number, number]> = [[0, 1], [1, 1], [250, 200], [1_000_000, 200], ['abc', 50], [-5, 50]];
    for (const [requested, effective] of cases) {
      const res = await list({ sellerPublicKey: SELLER_A, limit: requested });
      assert.equal(res.status, 200);
      assert.equal(res.body.pagination.limit, effective, `limit=${requested}`);
      assert.ok(res.body.data.length >= 1, `limit=${requested} must never return an empty page while rows exist`);
      assert.equal(res.body.pagination.hasMore, res.body.pagination.nextCursor !== null);
    }
  });

  it('gives cursor precedence over offset', async () => {
    const first = await list({ sellerPublicKey: SELLER_A, limit: 2 });
    const withOffset = await list({ sellerPublicKey: SELLER_A, limit: 2, cursor: first.body.pagination.nextCursor, offset: 4 });
    const withoutOffset = await list({ sellerPublicKey: SELLER_A, limit: 2, cursor: first.body.pagination.nextCursor });

    assert.equal(withOffset.body.pagination.offset, 0);
    assert.deepEqual(withOffset.body.data.map((i: any) => i.id), withoutOffset.body.data.map((i: any) => i.id));
  });

  it('returns the identical page when a request is retried with the same cursor', async () => {
    const first = await list({ sellerPublicKey: SELLER_A, limit: 2 });
    const cursor = first.body.pagination.nextCursor;
    const [a, b] = await Promise.all([
      list({ sellerPublicKey: SELLER_A, limit: 2, cursor }),
      list({ sellerPublicKey: SELLER_A, limit: 2, cursor }),
    ]);
    assert.deepEqual(a.body.data, b.body.data);
    assert.deepEqual(a.body.pagination, b.body.pagination);
  });

  it('rejects tampered cursors with a classified, non-retryable INVALID_CURSOR', async () => {
    for (const cursor of ['not-a-cursor', 'Zm9vfGJhcg', '%%%']) {
      const res = await list({ sellerPublicKey: SELLER_A, cursor });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_CURSOR');
      assert.equal(res.body.category, DOMAIN_ERROR_TAXONOMY.INVALID_CURSOR.category);
      assert.equal(res.body.retryable, false);
      assert.ok(res.body.recoveryAction);
      assert.ok(res.body.correlationId);
    }
  });
});

describe('filtering contract — GET /api/invoices (#286)', () => {
  it('matches status case-insensitively', async () => {
    const upper = await list({ sellerPublicKey: SELLER_A, status: 'CANCELLED' });
    const lower = await list({ sellerPublicKey: SELLER_A, status: 'cancelled' });
    assert.deepEqual(lower.body.data.map((i: any) => i.id), upper.body.data.map((i: any) => i.id));
    assert.deepEqual(new Set(upper.body.data.map((i: any) => i.id)), new Set(cancelledA));
  });

  it('applies the filter on every page, even with a cursor taken from an unfiltered walk', async () => {
    const unfiltered = await list({ sellerPublicKey: SELLER_A, limit: 1 });
    const { ids } = await walk({ sellerPublicKey: SELLER_A, status: 'PENDING', limit: 2 });
    const pendingAfterFirst = await list({ sellerPublicKey: SELLER_A, status: 'PENDING', cursor: unfiltered.body.pagination.nextCursor });

    assert.equal(ids.length, A_COUNT - cancelledA.length);
    assert.ok(ids.every((id) => !cancelledA.includes(id)));
    assert.ok(pendingAfterFirst.body.data.every((inv: any) => inv.status === 'PENDING'));
  });

  it('rejects unknown statuses with a classified INVALID_STATUS', async () => {
    const res = await list({ sellerPublicKey: SELLER_A, status: 'REFUNDED' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_STATUS');
    assert.equal(res.body.category, 'VALIDATION');
    assert.equal(res.body.retryable, false);
  });

  it('paginates and filters audit events with total = matching events and limit clamped to 1..500', async () => {
    const res = await call(mvpBase, 'GET', `/api/audit/events?action=INVOICE_CREATED&actorId=${SELLER_A}&limit=2&offset=2`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pagination, { limit: 2, offset: 2, total: A_COUNT });
    assert.equal(res.body.data.length, 2);
    assert.ok(res.body.data.every((e: any) => e.action === 'INVOICE_CREATED' && e.actor.id === SELLER_A));

    const clamped = await call(mvpBase, 'GET', `/api/audit/events?actorId=${SELLER_A}&limit=100000`);
    assert.equal(clamped.body.pagination.limit, 500);
  });
});

describe('authorization boundaries — wallet scoping (#286)', () => {
  it('never returns another wallet\'s invoices, even with a cursor taken from that wallet', async () => {
    const fromA = await list({ sellerPublicKey: SELLER_A, limit: 1 });
    const { ids } = await walk({ sellerPublicKey: SELLER_B, limit: 2 });
    const withForeignCursor = await list({ sellerPublicKey: SELLER_B, cursor: fromA.body.pagination.nextCursor });

    assert.equal(ids.length, B_COUNT);
    assert.ok(withForeignCursor.body.data.every((inv: any) => inv.sellerPublicKey === SELLER_B));
    assert.ok(!ids.some((id) => createdA.some((a) => a.id === id)));
  });

  it('scopes stats to the requesting wallet', async () => {
    const res = await call(mvpBase, 'GET', `/api/invoices/stats?sellerPublicKey=${SELLER_B}`, undefined, walletAuth(SELLER_B));
    assert.equal(res.status, 200);
    const total = res.body.data.reduce((sum: number, row: any) => sum + row.total_invoices, 0);
    assert.equal(total, B_COUNT);
  });

  it('requires a wallet: list and stats refuse an unscoped request', async () => {
    // Authenticated, but naming no wallet: the handler refuses, not the guard.
    for (const path of ['/api/invoices', '/api/invoices/stats']) {
      const res = await call(mvpBase, 'GET', path, undefined, walletAuth(SELLER_A));
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'SELLER_REQUIRED');
      assert.equal(res.body.category, 'AUTHORIZATION');
    }
  });

  it('returns an empty page, not an error, for a wallet with no invoices', async () => {
    const res = await list({ sellerPublicKey: Keypair.random().publicKey() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.pagination.hasMore, false);
  });
});

describe('authorization boundaries — admin surface (#286)', () => {
  const adminEndpoints = API_CONTRACT.filter((e) => e.auth === 'admin');
  const probePath = (path: string) => path.replace(/:[A-Za-z]+/g, 'contract-probe');
  const probeBody = (method: string) => (method === 'GET' ? undefined : {});

  it('declares every mounted /api/ops and /api/jobs route as admin', () => {
    const declared = new Set(adminEndpoints.map((e) => `${e.method} ${e.path}`));
    const mounted = collectRoutes(pgRouter)
      .map((r) => ({ method: r.method, path: `/api${r.path}` }))
      .filter((r) => r.path.startsWith('/api/ops') || r.path.startsWith('/api/jobs'));

    assert.ok(mounted.length >= adminEndpoints.length);
    for (const route of mounted) {
      assert.ok(declared.has(`${route.method} ${route.path}`), `${route.method} ${route.path} is mounted but not declared admin`);
    }
  });

  it('keeps unauthenticated admin-group endpoints to the documented known gap', () => {
    // docs/API_CONTRACTS.md "Known gap". A new admin route without auth fails here.
    assert.deepEqual(
      API_CONTRACT.filter((e) => e.group === 'admin' && e.auth === 'none').map((e) => `${e.method} ${e.path}`).sort(),
      // POST /api/payment/sync left this list once it was guarded by monitor:sync.
      ['GET /api/email/deliveries', 'GET /api/email/problems', 'POST /api/email/send', 'POST /api/email/webhook']
    );
  });

  it('refuses every admin route without a token, and with a wrong one (401)', async () => {
    for (const endpoint of adminEndpoints) {
      for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: ADMIN }]) {
        const res = await call(adminBase, endpoint.method, probePath(endpoint.path), probeBody(endpoint.method), headers);
        assert.equal(res.status, 401, `${endpoint.method} ${endpoint.path} with ${JSON.stringify(headers)}`);
        assert.equal(res.body.code, 'UNAUTHORIZED');
        assert.ok(endpoint.responses.includes(401), `${endpoint.path} must declare 401`);
      }
    }
  });

  it('disables every admin route (403) when no admin token is configured', async () => {
    delete process.env.JOBS_ADMIN_TOKEN;
    try {
      for (const endpoint of adminEndpoints) {
        const res = await call(adminBase, endpoint.method, probePath(endpoint.path), probeBody(endpoint.method), { authorization: `Bearer ${ADMIN}` });
        assert.equal(res.status, 403, `${endpoint.method} ${endpoint.path}`);
        assert.equal(res.body.code, 'JOBS_ADMIN_DISABLED');
        assert.ok(endpoint.responses.includes(403), `${endpoint.path} must declare 403`);
      }
    } finally {
      process.env.JOBS_ADMIN_TOKEN = ADMIN;
    }
  });
});
