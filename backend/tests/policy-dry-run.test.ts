/**
 * Dry-run policy evaluator with affected-record previews (#296).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import {
  MAX_PREVIEW_LIMIT,
  PolicyDryRunError,
  STELLAR_MAX_AMOUNT,
  evaluatePolicyDryRun,
  parsePolicyDryRunRequest,
} from '../src/domain/policy-dry-run';
import { DEFAULT_POLICY } from '../src/domain/policy';
import type { StoredInvoice } from '../src/storage/invoice-storage';
import { createOpsRouter } from '../src/routes/ops.routes';

const DAY = 86_400_000;
const BASE = Date.parse('2026-10-01T00:00:00.000Z');
const SELLER_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SELLER_B = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const ISSUER_1 = 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG';
const ISSUER_2 = 'GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX';

function invoice(n: number, fields: Partial<StoredInvoice> & { days?: number }): StoredInvoice {
  const createdAt = new Date(BASE + n * 1000);
  const { days = 7, ...rest } = fields;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sellerPublicKey: SELLER_A,
    amount: 1,
    assetCode: 'XLM',
    memo: `INV-${n}`,
    status: 'PENDING',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + days * DAY),
    ...rest,
  };
}

const INVOICES: StoredInvoice[] = [
  invoice(1, { amount: 50 }),
  invoice(2, { amount: 600 }),
  invoice(3, { amount: 0.1, assetCode: 'USDC', assetIssuer: ISSUER_1, sellerPublicKey: SELLER_B }),
  invoice(4, { amount: 0.2, assetCode: 'USDC', assetIssuer: ISSUER_1, sellerPublicKey: SELLER_B, days: 30 }),
  invoice(5, { amount: 700, assetCode: 'USDC', assetIssuer: ISSUER_2, sellerPublicKey: SELLER_B }),
  invoice(6, { amount: 900, status: 'PAID' }),
  invoice(7, { amount: 1000, status: 'CANCELLED' }),
  invoice(8, { amount: 20, status: 'EXPIRED', days: 30 }),
];

const run = (proposedPolicy: unknown, extra: Record<string, unknown> = {}, invoices = INVOICES) =>
  evaluatePolicyDryRun(invoices, parsePolicyDryRunRequest({ proposedPolicy, ...extra }, DEFAULT_POLICY));

function invalid(body: unknown, code: 'INVALID_POLICY_PROPOSAL' | 'INVALID_CURSOR', message?: RegExp) {
  assert.throws(() => parsePolicyDryRunRequest(body, DEFAULT_POLICY), (err: unknown) => {
    assert.ok(err instanceof PolicyDryRunError);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, 400);
    if (message) assert.match(err.message, message);
    return true;
  });
}

describe('policy dry-run — proposal validation (#296)', () => {
  it('rejects anything that is not a proposal object', () => {
    for (const proposedPolicy of [undefined, null, 'maxAmount=5', [1], 5]) {
      invalid({ proposedPolicy }, 'INVALID_POLICY_PROPOSAL', /must be an object/);
    }
  });

  it('rejects unknown fields and empty proposals instead of reporting "no impact"', () => {
    invalid({ proposedPolicy: { maxAmmount: 5 } }, 'INVALID_POLICY_PROPOSAL', /unknown field "maxAmmount"/);
    invalid({ proposedPolicy: {} }, 'INVALID_POLICY_PROPOSAL', /at least one field/);
  });

  it('enforces Stellar amount rules: positive, at most 7 decimals, within int64 stroops', () => {
    for (const maxAmount of [0, -1, '500', Number.NaN, Infinity, 0.00000001, STELLAR_MAX_AMOUNT * 2]) {
      invalid({ proposedPolicy: { maxAmount } }, 'INVALID_POLICY_PROPOSAL', /maxAmount must be a positive amount/);
    }
    assert.equal(parsePolicyDryRunRequest({ proposedPolicy: { minAmount: 0.0000001 } }, DEFAULT_POLICY).proposedPolicy.invoice.minAmount, 0.0000001);
  });

  it('checks ranges against the merged policy', () => {
    invalid({ proposedPolicy: { minAmount: 2_000_000_000 } }, 'INVALID_POLICY_PROPOSAL', /minAmount must not exceed maxAmount/);
    invalid({ proposedPolicy: { maxExpiryDays: 3 } }, 'INVALID_POLICY_PROPOSAL', /minExpiryDays <= defaultExpiryDays <= maxExpiryDays/);
    invalid({ proposedPolicy: { minExpiryDays: 1.5 } }, 'INVALID_POLICY_PROPOSAL', /whole number of days/);
  });

  it('accepts only Stellar asset codes (1-12 of a-z, A-Z, 0-9) and normalises like loadPolicy()', () => {
    for (const allowedAssets of ['XLM', ['US$'], ['ABCDEFGHIJKLM'], [''], [42]]) {
      invalid({ proposedPolicy: { allowedAssets } }, 'INVALID_POLICY_PROPOSAL', /allowedAssets/);
    }
    const parsed = parsePolicyDryRunRequest({ proposedPolicy: { allowedAssets: ['xlm', 'USDC', 'XLM'] } }, DEFAULT_POLICY);
    assert.deepEqual(parsed.proposedPolicy.invoice.allowedAssets, ['XLM', 'USDC']);
  });

  it('reports every issue in one response', () => {
    invalid({ proposedPolicy: { maxAmount: -1, minExpiryDays: 0, extra: true } }, 'INVALID_POLICY_PROPOSAL', /unknown field "extra".*maxAmount.*minExpiryDays/);
  });
});

describe('policy dry-run — evaluation (#296)', () => {
  it('previews records a lower cap would deny, with dataset totals by status and rule', () => {
    const report = run({ maxAmount: 500 });

    assert.equal(report.dryRun, true);
    assert.deepEqual(report.changes, [{ field: 'maxAmount', from: DEFAULT_POLICY.invoice.maxAmount, to: 500 }]);
    assert.equal(report.summary.totalEvaluated, 8);
    assert.equal(report.summary.totalAffected, 4);
    assert.deepEqual(report.summary.affectedByStatus, { PENDING: 2, PAID: 1, EXPIRED: 0, CANCELLED: 1 });
    assert.deepEqual(report.summary.affectedByRule, { AMOUNT_TOO_HIGH: 4 });
    assert.equal(report.summary.pendingAtRisk, 2);
    assert.equal(report.summary.sellersWithPendingAtRisk, 2);
    assert.deepEqual(
      report.preview.records.map((r) => [r.invoiceId.slice(-1), r.status, r.proposedOutcome]),
      [['7', 'CANCELLED', 'AMOUNT_TOO_HIGH'], ['6', 'PAID', 'AMOUNT_TOO_HIGH'], ['5', 'PENDING', 'AMOUNT_TOO_HIGH'], ['2', 'PENDING', 'AMOUNT_TOO_HIGH']]
    );
    assert.equal(report.preview.records[0].reason, 'Amount must be at most 500.');
  });

  it('sums pending volume in exact stroops, keyed by asset identity so issuers never merge', () => {
    const report = run({ allowedAssets: ['XLM'] });

    assert.deepEqual(report.summary.affectedByRule, { ASSET_NOT_ALLOWED: 3 });
    assert.deepEqual(report.summary.pendingVolumeAtRisk, {
      [`USDC:${ISSUER_1}`]: '0.3000000', // 0.1 + 0.2 without floating-point drift
      [`USDC:${ISSUER_2}`]: '700.0000000',
    });
    assert.equal(report.preview.records.find((r) => r.invoiceId.endsWith('5'))?.asset, `USDC:${ISSUER_2}`);
  });

  it('evaluates expiry-window rules from each invoice\'s createdAt/expiresAt', () => {
    const report = run({ maxExpiryDays: 14 });

    assert.deepEqual(report.summary.affectedByRule, { EXPIRY_OUT_OF_RANGE: 2 });
    assert.deepEqual(report.preview.records.map((r) => r.invoiceId.slice(-1)), ['8', '4']);
    assert.deepEqual(report.summary.pendingVolumeAtRisk, { [`USDC:${ISSUER_1}`]: '0.2000000' });
  });

  it('does not count relaxations: records already allowed stay unaffected', () => {
    const report = run({ maxAmount: 2_000_000_000, allowedAssets: [] });
    assert.equal(report.summary.totalAffected, 0);
    assert.deepEqual(report.preview, { records: [], limit: 25, hasMore: false, nextCursor: null });
  });

  it('is read-only: invoices and policies are not mutated', () => {
    const snapshot = structuredClone(INVOICES);
    const policy = structuredClone(DEFAULT_POLICY);
    run({ maxAmount: 10, allowedAssets: ['XLM'], maxExpiryDays: 14 });
    assert.deepEqual(INVOICES, snapshot);
    assert.deepEqual(DEFAULT_POLICY, policy);
  });
});

describe('policy dry-run — paginated previews (#296)', () => {
  const PROPOSAL = { maxAmount: 10 };

  it('walks every affected record exactly once, newest first, with stable totals on every page', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const report = run(PROPOSAL, { previewLimit: 2, cursor });
      assert.equal(report.summary.totalAffected, 6, 'totals cover the whole dataset on every page');
      assert.equal(report.preview.hasMore, report.preview.nextCursor !== null);
      assert.ok(report.preview.records.length <= 2);
      seen.push(...report.preview.records.map((r) => r.invoiceId.slice(-1)));
      cursor = report.preview.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    assert.equal(pages, 3);
    assert.deepEqual(seen, ['8', '7', '6', '5', '2', '1']);
  });

  it('returns the identical page when a request is retried with the same cursor', () => {
    const first = run(PROPOSAL, { previewLimit: 2 });
    const a = run(PROPOSAL, { previewLimit: 2, cursor: first.preview.nextCursor });
    const b = run(PROPOSAL, { previewLimit: 2, cursor: first.preview.nextCursor });
    assert.deepEqual(a.preview, b.preview);
    assert.equal(a.proposalHash, b.proposalHash);
  });

  it('binds the cursor to the proposal and rejects tampering', () => {
    const { preview } = run(PROPOSAL, { previewLimit: 2 });
    invalid({ proposedPolicy: { maxAmount: 11 }, cursor: preview.nextCursor }, 'INVALID_CURSOR');
    invalid({ proposedPolicy: PROPOSAL, cursor: `${preview.nextCursor}x` }, 'INVALID_CURSOR');
    invalid({ proposedPolicy: PROPOSAL, cursor: `${preview.nextCursor}.extra` }, 'INVALID_CURSOR');
    invalid({ proposedPolicy: PROPOSAL, cursor: 42 }, 'INVALID_CURSOR');
  });

  it('clamps previewLimit to 1..100 and defaults to 25', () => {
    assert.equal(run(PROPOSAL, { previewLimit: 0 }).preview.limit, 1);
    assert.equal(run(PROPOSAL, { previewLimit: 10_000 }).preview.limit, MAX_PREVIEW_LIMIT);
    assert.equal(run(PROPOSAL, { previewLimit: 'many' }).preview.limit, 25);
  });

  it('keeps the preview bounded no matter how many records are affected', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => invoice(i + 1, { amount: 100 }));
    const report = run(PROPOSAL, { previewLimit: 5 }, many);
    assert.equal(report.summary.totalAffected, 1_000);
    assert.equal(report.preview.records.length, 5);
    assert.deepEqual(report.preview.records.map((r) => r.invoiceId), many.slice(-5).reverse().map((i) => i.id));
  });
});

describe('POST /api/ops/policy/dry-run (#296)', () => {
  const ADMIN = 'policy-dry-run-admin-token';
  let server: Server;
  let base: string;
  let reads = 0;
  let storage: any = {};

  before(async () => {
    const app = express();
    app.use(express.json());
    // Storage is resolved per request so each test can swap it.
    app.use('/api', (req, res, next) =>
      createOpsRouter({ storage, adminToken: ADMIN, approvals: null, capabilities: null })(req, res, next)
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/policy/dry-run`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const post = async (body: unknown, token: string | null = ADMIN) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  it('requires the admin bearer token', async () => {
    storage = { getAllInvoices: async () => (reads++, INVOICES) };
    assert.equal((await post({ proposedPolicy: { maxAmount: 5 } }, null)).status, 401);
    assert.equal((await post({ proposedPolicy: { maxAmount: 5 } }, 'wrong')).status, 401);
    assert.equal(reads, 0);
  });

  it('validates before reading any record', async () => {
    storage = { getAllInvoices: async () => (reads++, INVOICES) };
    const res = await post({ proposedPolicy: { maxAmount: 'cheap' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_POLICY_PROPOSAL');
    assert.equal(reads, 0);
  });

  it('fails closed (503) when storage cannot enumerate invoices', async () => {
    storage = {};
    const res = await post({ proposedPolicy: { maxAmount: 5 } });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'DRY_RUN_UNAVAILABLE');
  });

  it('returns the dry-run report in the shared envelope', async () => {
    storage = { getAllInvoices: async () => (reads++, INVOICES) };
    const res = await post({ proposedPolicy: { maxAmount: 500 }, previewLimit: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.dryRun, true);
    assert.equal(res.body.data.summary.totalAffected, 4);
    assert.equal(res.body.data.preview.records.length, 3);
    assert.ok(res.body.data.preview.nextCursor);
  });

  it('surfaces storage failures as errors, never as an empty impact', async () => {
    storage = { getAllInvoices: async () => { throw new Error('connection reset'); } };
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ proposedPolicy: { maxAmount: 5 } }),
    });
    assert.equal(res.status, 500);
  });
});
