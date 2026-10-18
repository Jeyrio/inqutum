import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import type { Request, Response } from 'express';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers.ts';
import { createInvoiceRouter } from '../src/routes/invoice.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { PostgresInvoiceStorage } from '../src/storage/postgres-invoice-storage.ts';
import { InvoiceService } from '../src/services/invoice.service.ts';
import memoryStorage from '../src/storage/memory-storage.ts';
import type { InvoiceStorage } from '../src/storage/invoice-storage.ts';
import { compareNewestFirst } from '../src/storage/invoice-cursor.ts';

const SELLER_A = 'GB3Q3VRHH3OQDYITTLONDLEHWQGKB27T2BEDSFHIUMOERULVXPDXRKG4';
const SELLER_B = 'GB6IHEZ4QNOHJZRYRFLOC45P4SK3KKL6KNPI5WEG6FNVSZ2K5FS2MNY7';
const PAYER = 'GCBIBQVH2B3STCBIYSMTQH6DWKSB2XUGLXH7RGPIN3OXPCFCIQEICVZ6';
const TX_HASH = 'a'.repeat(64);

interface FakeResponse {
  statusCode: number;
  body: any;
}

function createRes(): FakeResponse & Response {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function createReq(init: { body?: any; params?: any; query?: any } = {}): Request {
  return {
    body: init.body || {},
    params: init.params || {},
    query: init.query || {},
  } as unknown as Request;
}

async function call(
  handler: (req: Request, res: Response) => Promise<void>,
  req: Request
): Promise<FakeResponse> {
  const res = createRes();
  await handler(req, res);
  return res;
}

/**
 * Minimal Postgres stand-in: understands only the statements invoice.service
 * issues, so the SQL parameter order and row mapping stay under test.
 */
function createFakePostgres() {
  const rows: any[] = [];
  const events: any[] = [];
  const clone = (row: any) => ({ ...row });

  const query = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('INSERT INTO invoices')) {
      const row = {
        id: params[0],
        seller_public_key: params[1],
        seller_name: params[2],
        seller_email: params[3],
        // Postgres returns DECIMAL columns as strings.
        amount: String(params[4]),
        asset_code: params[5],
        asset_issuer: params[6],
        memo: params[7],
        description: params[8],
        customer_name: params[9],
        customer_email: params[10],
        status: params[11],
        expires_at: params[12],
        payment_tx_hash: null,
        payer_public_key: null,
        payer_name: null,
        payer_email: null,
        created_at: new Date(),
        paid_at: null,
        cancelled_at: null,
        settled_at: null,
        settlement_context: null,
        prior_status: null,
        late_payment_warning_code: null,
        metadata: null,
      };
      rows.push(row);
      return { rows: [clone(row)], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO payment_events')) {
      events.push({ invoiceId: params[0], eventType: params[1] });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE id =')) {
      const found = rows.filter(row => row.id === params[0]);
      return { rows: found.map(clone), rowCount: found.length };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE memo =')) {
      const found = rows.filter(row => row.memo === params[0]);
      return { rows: found.map(clone), rowCount: found.length };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE seller_public_key =')) {
      let found = rows.filter(row => row.seller_public_key === params[0]);
      if (sql.includes('AND status = $2')) {
        found = found.filter(row => row.status === params[1]);
      }
      const offset = params[params.length - 1];
      const limit = params[params.length - 2];
      const key = (row: any) => ({ createdAt: row.created_at, id: row.id });
      if (sql.includes(") < ($")) {
        const cursor = { createdAt: new Date(params[params.length - 4]), id: params[params.length - 3] };
        found = found.filter(row => compareNewestFirst(cursor, key(row)) < 0);
      }
      const page = found
        .slice()
        .sort((a, b) => compareNewestFirst(key(a), key(b)))
        .slice(offset, offset + limit);
      return { rows: page.map(clone), rowCount: page.length };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'EXPIRED'")) {
      const now = new Date(params[0]).getTime();
      const expired = rows.filter(
        row => row.status === 'PENDING' && new Date(row.expires_at).getTime() <= now
      );
      expired.forEach(row => { row.status = 'EXPIRED'; });
      return { rows: expired.map(row => ({ id: row.id })), rowCount: expired.length };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'PAID'")) {
      const txHash = params[1];
      if (txHash && rows.some(r => r.id !== params[0] && r.payment_tx_hash === txHash)) {
        throw new Error('duplicate key value violates unique constraint "idx_invoices_payment_tx_hash"');
      }
      const row = rows.find(
        candidate => candidate.id === params[0] &&
          (
            (candidate.status === 'PENDING' && new Date(candidate.expires_at).getTime() > Date.now()) ||
            (candidate.status === 'CANCELLED' && candidate.cancelled_at && Number.isFinite(settledAt.getTime()))
          )
      );
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      const priorStatus = row.status;
      const afterCancel =
        priorStatus === 'CANCELLED' &&
        settledAt.getTime() >= new Date(row.cancelled_at).getTime();
      Object.assign(row, {
        status: 'PAID',
        payment_tx_hash: params[1],
        payer_public_key: params[2],
        payer_name: params[3],
        payer_email: params[4],
        paid_at: new Date(),
        settled_at: settledAt,
        settlement_context: afterCancel ? 'AFTER_CANCEL' : 'ON_TIME',
        prior_status: priorStatus === 'CANCELLED' ? 'CANCELLED' : null,
        late_payment_warning_code: afterCancel ? 'PAYMENT_RECEIVED_AFTER_CANCEL' : null,
      });
      return { rows: [clone(row)], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'CANCELLED'")) {
      const sellerPublicKey = params[1] ?? null;
      const row = rows.find(
        candidate => candidate.id === params[0] &&
          candidate.status === 'PENDING' &&
          (!sellerPublicKey || candidate.seller_public_key === sellerPublicKey)
      );
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.status = 'CANCELLED';
      row.cancelled_at = new Date();
      return { rows: [clone(row)], rowCount: 1 };
    }

    if (sql.startsWith('SELECT COUNT(*) as total_invoices')) {
      const owned = rows.filter(row => row.seller_public_key === params[0]);
      const revenue: Record<string, number> = {};
      owned
        .filter(row => row.status === 'PAID')
        .forEach(row => {
          revenue[row.asset_code] = (revenue[row.asset_code] || 0) + Number(row.amount);
        });
      return {
        rows: [
          {
            // Postgres reports aggregates as strings.
            total_invoices: String(owned.length),
            paid_invoices: String(owned.filter(row => row.status === 'PAID').length),
            pending_invoices: String(owned.filter(row => row.status === 'PENDING').length),
            actionable_invoices: String(owned.filter(row => row.status === 'PENDING').length),
            expired_invoices: String(owned.filter(row => row.status === 'EXPIRED').length),
            revenue_by_asset: revenue,
          },
        ],
        rowCount: 1,
      };
    }

    throw new Error(`Unhandled query in fake Postgres: ${sql}`);
  };

  const remove = (id: string) => {
    rows.splice(rows.findIndex(row => row.id === id), 1);
  };

  return { query, events, remove };
}

function paymentTransaction(overrides: {
  memo: string;
  amount: string;
  to: string;
  assetType?: string;
  assetCode?: string;
}) {
  return {
    transaction: { memo: overrides.memo, memo_type: 'text' },
    operations: [
      {
        type: 'payment',
        from: PAYER,
        to: overrides.to,
        amount: overrides.amount,
        asset_type: overrides.assetType || 'native',
        asset_code: overrides.assetCode,
      },
    ],
  };
}

function invoiceBody(overrides: Record<string, unknown> = {}) {
  return {
    amount: 42.5,
    assetCode: 'XLM',
    description: 'Design work',
    sellerPublicKey: SELLER_A,
    ...overrides,
  };
}

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * Both storage backends must expose identical request/response behaviour.
 */
interface BackendUnderTest {
  storage: InvoiceStorage;
  /** Hard-deletes a row behind the API's back, as an operator or retention job would. */
  removeInvoice(id: string): void;
}

function runSharedBackendSuite(name: string, createBackend: () => BackendUnderTest) {
  describe(`invoice handlers on ${name} storage`, () => {
    let storage: InvoiceStorage;
    let removeInvoice: (id: string) => void;
    let transaction: any;

    const handlers = () =>
      createInvoiceHandlers({
        storage,
        frontendUrl: 'http://localhost:3000',
        allowSimulate: false,
        stellar: { getTransaction: async () => transaction },
      });

    const createInvoice = async (overrides: Record<string, unknown> = {}) => {
      const res = await call(handlers().createInvoice, createReq({ body: invoiceBody(overrides) }));
      assert.equal(res.statusCode, 201);
      return res.body.data.invoice;
    };

    beforeEach(() => {
      memoryStorage.clear();
      ({ storage, removeInvoice } = createBackend());
      transaction = undefined;
    });

    it('round-trips all seller, payer, asset, customer and expiry parity fields through create+get+verify+list', async () => {
      const sellerName = 'Round-trip Studio';
      const sellerEmail = 'studio@roundtrip.example';
      const customerName = 'Client Co';
      const customerEmail = 'pay@client.example';
      const payerName = 'Percy Payer';
      const payerEmail = 'percy@payer.example';

      const created = await createInvoice({
        amount: 88.25,
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        sellerName,
        sellerEmail,
        customerName,
        customerEmail,
        expiresInDays: 5,
      });

      assert.equal(created.sellerName, sellerName);
      assert.equal(created.sellerEmail, sellerEmail);
      assert.equal(created.customerName, customerName);
      assert.equal(created.customerEmail, customerEmail);
      assert.equal(created.assetCode, 'USDC');
      assert.equal(created.assetIssuer, USDC_ISSUER);
      assert.equal(created.status, 'PENDING');

      const lifetimeHours = (new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime()) / (60 * 60 * 1000);
      assert.ok(lifetimeHours >= 5 * 24 - 1, `5-day expiry window should be ~120h, got ${lifetimeHours}h`);

      const got = await call(handlers().getInvoice, createReq({ params: { id: created.id } }));
      assert.equal(got.statusCode, 200);
      assert.equal(got.body.data.sellerName, sellerName);
      assert.equal(got.body.data.assetIssuer, USDC_ISSUER);
      assert.equal(got.body.data.customerEmail, customerEmail);

      transaction = {
        transaction: { memo: created.memo, memo_type: 'text' },
        operations: [
          {
            type: 'payment',
            from: PAYER,
            to: SELLER_A,
            amount: '88.2500000',
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
          },
        ],
      };

      const verified = await call(
        handlers().verifyPayment,
        createReq({
          params: { id: created.id },
          body: { txHash: TX_HASH, payerName, payerEmail },
        })
      );

      assert.equal(verified.statusCode, 200);
      assert.equal(verified.body.data.payerName, payerName);
      assert.equal(verified.body.data.payerEmail, payerEmail);
      assert.equal(verified.body.data.payerPublicKey, PAYER);
      assert.equal(verified.body.data.paymentTxHash, TX_HASH);
      assert.ok(verified.body.data.paidAt, 'paidAt must be set after verify');
      assert.equal(verified.body.data.status, 'PAID');

      const listed = await call(
        handlers().getInvoices,
        createReq({ query: { sellerPublicKey: SELLER_A, status: 'PAID' } })
      );
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.body.data.length >= 1, true);
      const paidListed = listed.body.data.find((inv: any) => inv.id === created.id);
      assert.equal(paidListed?.payerName, payerName);
      assert.equal(paidListed?.assetIssuer, USDC_ISSUER);
      assert.equal(paidListed?.sellerEmail, sellerEmail);
    });

    it('creates an invoice scoped to the seller wallet', async () => {
      const res = await call(handlers().createInvoice, createReq({ body: invoiceBody() }));

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.invoice.sellerPublicKey, SELLER_A);
      assert.equal(res.body.data.invoice.amount, 42.5);
      assert.equal(res.body.data.invoice.assetCode, 'XLM');
      assert.equal(res.body.data.invoice.status, 'PENDING');
      assert.match(res.body.data.invoice.memo, /^INV-/);
      assert.equal(
        res.body.data.paymentUrl,
        `http://localhost:3000/pay/${res.body.data.invoice.id}`
      );
      assert.match(res.body.data.qrCode, /^data:image\/png;base64,/);
      assert.match(res.body.data.stellarQrCode, /^data:image\/png;base64,/);
      assert.equal(res.body.data.statusPollingIntervalMs, 3000);
      assert.equal(res.body.data.paymentAvailable, true);
    });

    it('normalizes lowercase assetCode to uppercase on creation', async () => {
      const res = await call(
        handlers().createInvoice,
        createReq({ body: invoiceBody({ assetCode: 'xlm' }) })
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.data.invoice.assetCode, 'XLM');
    });

    it('accepts seller-selected expiry only within the 1-30 day contract', async () => {
      const invoice = await createInvoice({ expiresInDays: 30 });
      const lifetime = new Date(invoice.expiresAt).getTime() - new Date(invoice.createdAt).getTime();
      assert.ok(lifetime > 29 * 24 * 60 * 60 * 1000);

      for (const expiresInDays of [0, 31, 1.5]) {
        const res = await call(
          handlers().createInvoice,
          createReq({ body: invoiceBody({ expiresInDays }) })
        );
        assert.equal(res.statusCode, 400);
      }
    });

    it('expires lazily and closes payment, verification, and actionable stats', async () => {
      const invoice = await createInvoice({ expiresInDays: 1 });
      await storage.markExpiredInvoices(new Date(new Date(invoice.expiresAt).getTime() + 1));

      const read = await call(
        handlers().getInvoice,
        createReq({ params: { id: invoice.id } })
      );
      assert.equal(read.body.data.status, 'EXPIRED');

      const paymentInfo = await call(
        handlers().getPaymentInfo,
        createReq({ params: { id: invoice.id } })
      );
      assert.equal(paymentInfo.body.data.paymentAvailable, false);
      assert.equal(paymentInfo.body.data.qrCode, null);
      assert.equal(paymentInfo.body.data.stellarQrCode, null);

      const verify = await call(
        handlers().verifyPayment,
        createReq({ params: { id: invoice.id }, body: { txHash: TX_HASH } })
      );
      assert.equal(verify.statusCode, 400);
      assert.equal(verify.body.code, 'INVOICE_EXPIRED');

      const stats = await call(
        handlers().getStats,
        createReq({ query: { sellerPublicKey: SELLER_A } })
      );
      assert.equal(stats.body.data[0].pending_invoices, 0);
      assert.equal(stats.body.data[0].actionable_invoices, 0);
      assert.equal(stats.body.data[0].expired_invoices, 1);
    });

    it('rejects an invoice with an invalid seller wallet', async () => {
      const res = await call(
        handlers().createInvoice,
        createReq({ body: invoiceBody({ sellerPublicKey: 'not-a-wallet' }) })
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(typeof res.body.error, 'string');
    });

    it('verifies a matching Stellar payment and marks the invoice paid', async () => {
      const invoice = await createInvoice();
      transaction = paymentTransaction({
        memo: invoice.memo,
        amount: '42.5000000',
        to: SELLER_A,
      });

      const res = await call(
        handlers().verifyPayment,
        createReq({
          params: { id: invoice.id },
          body: { txHash: TX_HASH, payerName: ' Ada ', payerEmail: ' ada@example.com ' },
        })
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Payment verified on Stellar');
      assert.equal(res.body.data.status, 'PAID');
      assert.equal(res.body.data.paymentTxHash, TX_HASH);
      assert.equal(res.body.data.payerPublicKey, PAYER);
      assert.equal(res.body.data.payerName, 'Ada');
      assert.equal(res.body.data.payerEmail, 'ada@example.com');

      const stored = await storage.getInvoiceById(invoice.id);
      assert.equal(stored?.status, 'PAID');
    });

    it('requires a transaction hash to verify', async () => {
      const invoice = await createInvoice();

      const res = await call(
        handlers().verifyPayment,
        createReq({ params: { id: invoice.id }, body: {} })
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'MISSING_TX_HASH');
      assert.equal(res.body.error, 'Transaction hash is required');
    });

    it('rejects a payment whose memo does not match', async () => {
      const invoice = await createInvoice();
      transaction = paymentTransaction({
        memo: 'INV-SOMETHING-ELSE',
        amount: '42.5000000',
        to: SELLER_A,
      });

      const res = await call(
        handlers().verifyPayment,
        createReq({ params: { id: invoice.id }, body: { txHash: TX_HASH } })
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'MEMO_MISMATCH');
      assert.equal(res.body.error, 'Memo mismatch');
    });

    it('rejects a payment sent to another wallet', async () => {
      const invoice = await createInvoice();
      transaction = paymentTransaction({
        memo: invoice.memo,
        amount: '42.5000000',
        to: SELLER_B,
      });

      const res = await call(
        handlers().verifyPayment,
        createReq({ params: { id: invoice.id }, body: { txHash: TX_HASH } })
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'DESTINATION_MISMATCH');
      assert.equal(res.body.error, 'Payment destination mismatch');
    });

    it('rejects a payment with the wrong amount', async () => {
      const invoice = await createInvoice();
      transaction = paymentTransaction({
        memo: invoice.memo,
        amount: '1.0000000',
        to: SELLER_A,
      });

      const res = await call(
        handlers().verifyPayment,
        createReq({ params: { id: invoice.id }, body: { txHash: TX_HASH } })
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'AMOUNT_MISMATCH');
      assert.equal(res.body.error, 'Amount mismatch');
    });

    it('refuses to verify an invoice twice', async () => {
      const invoice = await createInvoice();
      transaction = paymentTransaction({
        memo: invoice.memo,
        amount: '42.5000000',
        to: SELLER_A,
      });
      const req = createReq({ params: { id: invoice.id }, body: { txHash: TX_HASH } });

      await call(handlers().verifyPayment, req);
      const res = await call(handlers().verifyPayment, req);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVOICE_ALREADY_PAID');
      assert.equal(res.body.error, 'Invoice has already been paid');
    });

    it('returns 404 when verifying an unknown invoice', async () => {
      const res = await call(
        handlers().verifyPayment,
        createReq({ params: { id: 'missing-id' }, body: { txHash: TX_HASH } })
      );

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error, 'Invoice not found');
    });

    it('lists only the invoices of the requested wallet', async () => {
      await createInvoice();
      await createInvoice({ sellerPublicKey: SELLER_B });

      const res = await call(
        handlers().getInvoices,
        createReq({ query: { sellerPublicKey: SELLER_A } })
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].sellerPublicKey, SELLER_A);
      assert.deepEqual(res.body.pagination, {
        limit: 50,
        offset: 0,
        total: 1,
        nextCursor: null,
        hasMore: false,
      });
    });

    describe('cursor pagination', () => {
      const list = (query: Record<string, unknown>) =>
        call(handlers().getInvoices, createReq({ query: { sellerPublicKey: SELLER_A, ...query } }));

      /** Walks every page with `limit`, running `between` after each page. */
      const collect = async (
        limit: number,
        query: Record<string, unknown> = {},
        between: (page: number) => Promise<void> = async () => {}
      ) => {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const res = await list({ ...query, limit, cursor });
          assert.equal(res.statusCode, 200);
          seen.push(...res.body.data.map((inv: any) => inv.id));
          assert.equal(res.body.pagination.hasMore, res.body.pagination.nextCursor !== null);
          if (!res.body.pagination.hasMore) return seen;
          cursor = res.body.pagination.nextCursor;
          await between(page);
        }
        throw new Error('pagination did not terminate');
      };

      it('returns every invoice once in newest-first order, ties broken by id', async () => {
        // Created back to back, so several share a millisecond timestamp.
        for (let i = 0; i < 7; i++) await createInvoice({ amount: i + 1 });

        const all = (await list({ limit: 100 })).body.data.map((inv: any) => inv.id);
        assert.deepEqual(await collect(2), all);
        assert.equal(new Set(all).size, 7);
      });

      it('does not duplicate or skip rows when invoices are created mid-pagination', async () => {
        const before: string[] = [];
        for (let i = 0; i < 5; i++) before.push((await createInvoice()).id);

        const seen = await collect(2, {}, async () => {
          await createInvoice();
        });

        // New invoices sort ahead of the cursor, so later pages hold exactly the old rows.
        assert.deepEqual([...seen].sort(), [...before].sort());
      });

      it('does not skip rows when the cursor row itself is deleted', async () => {
        for (let i = 0; i < 6; i++) await createInvoice();
        const all = (await list({ limit: 100 })).body.data.map((inv: any) => inv.id);

        const first = await list({ limit: 2 });
        removeInvoice(all[1]); // the row the cursor points at
        const second = await list({ limit: 4, cursor: first.body.pagination.nextCursor });

        assert.deepEqual(second.body.data.map((inv: any) => inv.id), all.slice(2));
      });

      it('never returns other wallets\' invoices, even with a cursor taken from them', async () => {
        for (let i = 0; i < 3; i++) {
          await createInvoice();
          await createInvoice({ sellerPublicKey: SELLER_B });
        }
        const seen = await collect(1);
        assert.equal(seen.length, 3);

        const other = await call(
          handlers().getInvoices,
          createReq({ query: { sellerPublicKey: SELLER_B, limit: 1 } })
        );
        const crossed = await list({ cursor: other.body.pagination.nextCursor });
        assert.ok(crossed.body.data.every((inv: any) => inv.sellerPublicKey === SELLER_A));
      });

      it('keeps status-filtered pages stable when a record leaves the filter', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) ids.push((await createInvoice()).id);

        const first = await list({ status: 'pending', limit: 2 });
        assert.equal(first.statusCode, 200);
        // Cancel an invoice already shown; offset paging would now skip a row.
        await call(handlers().cancelInvoice, createReq({ params: { id: first.body.data[0].id } }));
        const second = await list({ status: 'PENDING', limit: 2, cursor: first.body.pagination.nextCursor });

        const seen = [...first.body.data, ...second.body.data].map((inv: any) => inv.id);
        assert.deepEqual([...seen].sort(), [...ids].sort());
      });

      it('rejects unknown statuses and tampered cursors', async () => {
        const status = await list({ status: 'archived' });
        assert.equal(status.statusCode, 400);
        assert.equal(status.body.code, 'INVALID_STATUS');

        for (const cursor of ['garbage', Buffer.from('2026-01-01T00:00:00Z|1 OR 1=1').toString('base64url')]) {
          const res = await list({ cursor });
          assert.equal(res.statusCode, 400);
          assert.equal(res.body.code, 'INVALID_CURSOR');
        }
      });
    });

    it('requires a wallet when listing invoices', async () => {
      const res = await call(handlers().getInvoices, createReq());

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'sellerPublicKey query parameter is required');
    });

    it('cancels a pending invoice once', async () => {
      const invoice = await createInvoice();

      const cancelled = await call(
        handlers().cancelInvoice,
        createReq({ params: { id: invoice.id }, body: { sellerPublicKey: SELLER_A } })
      );
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.body.data.status, 'CANCELLED');

      const again = await call(
        handlers().cancelInvoice,
        createReq({ params: { id: invoice.id }, body: { sellerPublicKey: SELLER_A } })
      );
      assert.equal(again.statusCode, 400);
      assert.equal(again.body.success, false);
    });

    it('cancels a pending invoice when sellerPublicKey matches', async () => {
      const invoice = await createInvoice();

      const cancelled = await call(
        handlers().cancelInvoice,
        createReq({ params: { id: invoice.id }, body: { sellerPublicKey: SELLER_A } })
      );
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.body.data.status, 'CANCELLED');
    });

    it('rejects cancellation when sellerPublicKey does not match (403)', async () => {
      const invoice = await createInvoice();

      const res = await call(
        handlers().cancelInvoice,
        createReq({ params: { id: invoice.id }, body: { sellerPublicKey: SELLER_B } })
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /unauthorized/i);
    });

    it('rejects invalid sellerPublicKey format on cancel (400)', async () => {
      const invoice = await createInvoice();

      const res = await call(
        handlers().cancelInvoice,
        createReq({ params: { id: invoice.id }, body: { sellerPublicKey: 'not-a-valid-stellar-key' } })
      );
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
    });

    it('reports wallet-scoped stats', async () => {
      const invoice = await createInvoice();
      await createInvoice({ sellerPublicKey: SELLER_B, amount: 10 });
      transaction = paymentTransaction({
        memo: invoice.memo,
        amount: '42.5000000',
        to: SELLER_A,
      });
      await call(
        handlers().verifyPayment,
        createReq({ params: { id: invoice.id }, body: { txHash: TX_HASH } })
      );

      const res = await call(
        handlers().getStats,
        createReq({ query: { sellerPublicKey: SELLER_A } })
      );

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data[0], {
        total_invoices: 1,
        paid_invoices: 1,
        pending_invoices: 0,
        actionable_invoices: 0,
        expired_invoices: 0,
        revenue_by_asset: { XLM: 42.5 },
      });
    });

    it('Issue #16: guarantees collision-free invoice IDs under concurrent creation requests', async () => {
      const concurrency = 20;
      const promises = Array.from({ length: concurrency }, () =>
        call(
          handlers().createInvoice,
          createReq({
            body: {
              sellerPublicKey: SELLER_A,
              amount: 10,
              assetCode: 'XLM',
            },
          })
        )
      );

      const results = await Promise.all(promises);
      const createdIds = new Set<string>();
      const createdMemos = new Set<string>();

      for (const res of results) {
        assert.equal(res.statusCode, 201);
        const inv = res.body.data.invoice;
        assert.ok(inv.id);
        assert.ok(inv.memo);
        assert.equal(createdIds.has(inv.id), false, 'Duplicate invoice ID detected under concurrent creation');
        assert.equal(createdMemos.has(inv.memo), false, 'Duplicate memo detected under concurrent creation');
        createdIds.add(inv.id);
        createdMemos.add(inv.memo);
      }

      assert.equal(createdIds.size, concurrency);
    });

    it('Issue #19: rejects marking a second invoice paid with an already-used tx hash', async () => {
      const inv1 = await createInvoice();
      const inv2 = await createInvoice();

      const txHash = 'f'.repeat(64);

      transaction = {
        transaction: { memo: inv1.memo },
        operations: [
          {
            type: 'payment',
            from: PAYER,
            to: SELLER_A,
            amount: String(inv1.amount),
            asset_type: 'native',
          },
        ],
      };

      const res1 = await call(
        handlers().verifyPayment,
        createReq({
          params: { id: inv1.id },
          body: { txHash, payerPublicKey: PAYER, amount: inv1.amount },
        })
      );
      assert.equal(res1.statusCode, 200);

      // Direct storage layer attempt to reuse the same txHash must be rejected
      await assert.rejects(
        async () => {
          await storage.markAsPaid(inv2.id, txHash, PAYER);
        },
        /duplicate/i
      );

      transaction = {
        transaction: { memo: inv2.memo },
        operations: [
          {
            type: 'payment',
            from: PAYER,
            to: SELLER_A,
            amount: String(inv2.amount),
            asset_type: 'native',
          },
        ],
      };

      const res2 = await call(
        handlers().verifyPayment,
        createReq({
          params: { id: inv2.id },
          body: { txHash, payerPublicKey: PAYER, amount: inv2.amount },
        })
      );
      assert.ok(res2.statusCode >= 400);
      assert.match(String(res2.body.error), /duplicate/i);
    });

    it('hides the simulate endpoint when simulation is disabled', async () => {
      const invoice = await createInvoice();

      const res = await call(
        handlers().simulatePayment,
        createReq({ params: { id: invoice.id } })
      );

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error, 'Endpoint not found');
    });
  });
}

runSharedBackendSuite('in-memory', () => ({
  storage: new MemoryInvoiceStorage(),
  removeInvoice: id => (memoryStorage as any).invoices.delete(id),
}));
runSharedBackendSuite('postgres', () => {
  const db = createFakePostgres();
  return {
    storage: new PostgresInvoiceStorage(new InvoiceService(db)),
    removeInvoice: db.remove,
  };
});

describe('storage adapters', () => {
  it('report the backend they are wired to', () => {
    assert.equal(new MemoryInvoiceStorage().mode, 'in-memory');
    assert.equal(new PostgresInvoiceStorage().mode, 'postgres');
  });
});

describe('shared invoice router', () => {
  const routeTable = (storage: InvoiceStorage) =>
    (createInvoiceRouter({ storage }) as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  it('exposes the same routes for both backends', () => {
    const expected = [
      'POST /invoices',
      // static routes must stay ahead of /invoices/:id or the dynamic route shadows them
      'GET /invoices/lifecycle',
      'GET /invoices/stats',
      'GET /invoices',
      'GET /invoices/:id',
      'GET /invoices/:id/payment-info',
      'GET /invoices/:id/audit',
      'POST /invoices/:id/cancel',
      'POST /invoices/:id/verify',
      'POST /invoices/:id/simulate-payment',
      'GET /invoices/:id/email-preview',
      'POST /invoices/:id/send-email',
    ];

    assert.deepEqual(routeTable(new MemoryInvoiceStorage()), expected);
    assert.deepEqual(routeTable(new PostgresInvoiceStorage()), expected);
  });
});
