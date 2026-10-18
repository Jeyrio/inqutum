import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers';
import memoryInvoiceStorage from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import { auditStore } from '../src/audit/audit-service';
import { metrics } from '../src/observability/telemetry';

// Realistic Stellar public keys and addresses for deterministic testing
const SELLER_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const PAYER_KEY = 'GC5F6UDFX5QG2N46TWBWWVWW5I523N2P42T3N6A7P63L6G4M6N6Q7Y64';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ATTACKER_ISSUER = 'GATTACKERISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const VALID_TX_HASH = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

// Helper mock response builder
function createMockRes() {
  const res: any = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
    setHeader(key: string, value: any) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
}

describe('End-to-End High-Risk User Journey: Invoicing & Horizon Settlement (Issue #49)', () => {
  let handlers: ReturnType<typeof createInvoiceHandlers>;
  let mockHorizonTx: any;

  beforeEach(() => {
    memoryStorage.clear();
    auditStore.clear();
    metrics.clear();

    handlers = createInvoiceHandlers({
      storage: memoryInvoiceStorage,
      frontendUrl: 'http://localhost:3000',
      allowSimulate: false,
      stellar: {
        getTransaction: async (_hash: string) => {
          if (!mockHorizonTx) {
            const err: any = new Error('Transaction not found on Horizon');
            err.response = { status: 404 };
            throw err;
          }
          return mockHorizonTx;
        },
      },
    });
  });

  describe('Happy Path 1: Native XLM Invoice Creation -> Payment -> Verification -> Proof', () => {
    it('executes full happy path lifecycle with audit trail and telemetry recording', async () => {
      // Step 1: Seller creates 100 XLM invoice
      const createReq: any = {
        body: {
          sellerPublicKey: SELLER_KEY,
          sellerName: 'Freelance Design Pro',
          sellerEmail: 'pro@freelance.example',
          amount: 100.0,
          assetCode: 'XLM',
          description: 'UI Design Sprint',
          customerName: 'Acme Corp',
          customerEmail: 'billing@acme.example',
          expiresInDays: 7,
        },
        correlationId: 'req-e2e-happy-1',
        ip: '127.0.0.1',
      };

      const createRes = createMockRes();
      await handlers.createInvoice(createReq, createRes);

      assert.equal(createRes.statusCode, 201);
      assert.equal(createRes.body.success, true);
      const invoice = createRes.body.data.invoice;
      assert.ok(invoice.id);
      assert.equal(invoice.status, 'PENDING');
      assert.equal(invoice.amount, 100.0);
      assert.ok(invoice.memo);
      assert.ok(createRes.body.data.qrCode);
      assert.ok(createRes.body.data.stellarQrCode);

      // Step 2: Client loads payment page
      const payInfoReq: any = { params: { id: invoice.id }, correlationId: 'req-e2e-payinfo' };
      const payInfoRes = createMockRes();
      await handlers.getPaymentInfo(payInfoReq, payInfoRes);
      assert.equal(payInfoRes.statusCode, 200);
      assert.equal(payInfoRes.body.data.paymentAvailable, true);

      // Step 3: Mock Horizon transaction submitted by client on Stellar
      mockHorizonTx = {
        transaction: {
          id: VALID_TX_HASH,
          hash: VALID_TX_HASH,
          memo: invoice.memo,
          memo_type: 'text',
          successful: true,
        },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '100.0000000',
          },
        ],
      };

      // Step 4: Client triggers payment verification
      const verifyReq: any = {
        params: { id: invoice.id },
        body: {
          txHash: VALID_TX_HASH,
          payerName: 'Acme Billing Lead',
          payerEmail: 'billing@acme.example',
          network: 'TESTNET',
        },
        correlationId: 'req-e2e-verify-1',
        ip: '10.0.0.5',
      };
      const verifyRes = createMockRes();
      await handlers.verifyPayment(verifyReq, verifyRes);

      assert.equal(verifyRes.statusCode, 200);
      assert.equal(verifyRes.body.success, true);
      const settledInvoice = verifyRes.body.data;
      assert.equal(settledInvoice.status, 'PAID');
      assert.equal(settledInvoice.paymentTxHash, VALID_TX_HASH);
      assert.equal(settledInvoice.payerPublicKey, PAYER_KEY);
      assert.ok(settledInvoice.paidAt);

      // Step 5: Verify Audit Trail recorded both creation and settlement
      const auditTrailReq: any = { params: { id: invoice.id } };
      const auditTrailRes = createMockRes();
      await handlers.getInvoiceAuditTrail(auditTrailReq, auditTrailRes);
      assert.equal(auditTrailRes.statusCode, 200);
      const auditEvents = auditTrailRes.body.data;
      assert.equal(auditEvents.length, 2);

      const creationAudit = auditEvents.find((e: any) => e.action === 'INVOICE_CREATED');
      const verifyAudit = auditEvents.find((e: any) => e.action === 'PAYMENT_VERIFIED');
      assert.ok(creationAudit);
      assert.ok(verifyAudit);
      assert.equal(verifyAudit.actor.id, PAYER_KEY);
      assert.equal(verifyAudit.afterState.status, 'PAID');

      // Step 6: Verify Telemetry recorded metrics and funnel conversion
      const metricsSummary = metrics.getMetricsSummary();
      assert.equal(metricsSummary.operations['invoice.create'].count, 1);
      assert.equal(metricsSummary.operations['invoice.verify_payment'].count, 1);
      assert.equal(metricsSummary.conversion_funnel.stages.invoice_created, 1);
      assert.equal(metricsSummary.conversion_funnel.stages.payment_verified, 1);
    });
  });

  describe('Happy Path 2: USDC Credit Asset with Pinned Issuer', () => {
    it('verifies non-native USDC payment with matching code and issuer', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: {
            sellerPublicKey: SELLER_KEY,
            amount: 250.0,
            assetCode: 'USDC',
            assetIssuer: USDC_ISSUER,
            expiresInDays: 3,
          },
        } as any,
        createRes
      );

      const invoice = createRes.body.data.invoice;

      mockHorizonTx = {
        transaction: {
          id: VALID_TX_HASH,
          hash: VALID_TX_HASH,
          memo: invoice.memo,
          memo_type: 'text',
        },
        operations: [
          {
            type: 'payment',
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '250.0000000',
          },
        ],
      };

      const verifyRes = createMockRes();
      await handlers.verifyPayment(
        {
          params: { id: invoice.id },
          body: { txHash: VALID_TX_HASH, network: 'TESTNET' },
        } as any,
        verifyRes
      );

      assert.equal(verifyRes.statusCode, 200);
      assert.equal(verifyRes.body.data.status, 'PAID');
    });
  });

  describe('Failure Mode 1: Memo Mismatch & Recovery Flow', () => {
    it('rejects wrong memo, provides user-safe recovery guidance, and allows retry with correct memo', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 50, assetCode: 'XLM', expiresInDays: 7 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      // First attempt: Transaction with wrong memo
      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: 'WRONG-MEMO-9999' },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '50.0000000',
          },
        ],
      };

      const failRes = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        failRes
      );

      assert.equal(failRes.statusCode, 400);
      assert.equal(failRes.body.code, 'MEMO_MISMATCH');
      assert.equal(failRes.body.category, 'SETTLEMENT');
      assert.equal(failRes.body.retryable, false);
      assert.ok(failRes.body.recoveryAction.includes('exact invoice memo'));

      // Recovery: Client resends with correct memo
      mockHorizonTx.transaction.memo = invoice.memo;
      const retryRes = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        retryRes
      );

      assert.equal(retryRes.statusCode, 200);
      assert.equal(retryRes.body.data.status, 'PAID');
    });
  });

  describe('Failure Mode 2: Counterfeit Asset / Fake XLM Token Protection', () => {
    it('refuses credit asset token named XLM against native invoice', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 100, assetCode: 'XLM', expiresInDays: 7 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      // Attacker issues credit token with code XLM
      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: invoice.memo },
        operations: [
          {
            type: 'payment',
            asset_type: 'credit_alphanum4',
            asset_code: 'XLM',
            asset_issuer: ATTACKER_ISSUER,
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '100.0000000',
          },
        ],
      };

      const res = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'ASSET_MISMATCH');
    });
  });

  describe('Failure Mode 3: Amount Mismatch & 7-Decimal Stroop Tolerance', () => {
    it('rejects partial payment by 1 stroop (0.0000001)', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 100.0, assetCode: 'XLM', expiresInDays: 7 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      // 99.9999999 XLM (1 stroop under)
      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: invoice.memo },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '99.9999999',
          },
        ],
      };

      const res = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'AMOUNT_MISMATCH');
    });
  });

  describe('Failure Mode 4: Destination Account Mismatch', () => {
    it('rejects transaction sent to wrong destination account', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 50, assetCode: 'XLM', expiresInDays: 7 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: invoice.memo },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: 'GWRONGDESTINATIONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            amount: '50.0000000',
          },
        ],
      };

      const res = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'DESTINATION_MISMATCH');
    });
  });

  describe('Failure Mode 5: Expired Invoice Rejection', () => {
    it('refuses payment for an invoice whose expiry window has elapsed', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 50, assetCode: 'XLM', expiresInDays: 1 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      // Force expiration
      const stored = memoryStorage.getInvoiceById(invoice.id);
      if (stored) {
        stored.expiresAt = new Date(Date.now() - 10000);
      }

      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: invoice.memo },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '50.0000000',
          },
        ],
      };

      const res = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVOICE_EXPIRED');
    });
  });

  describe('Failure Mode 6: Double Settlement / Replay Attack Prevention', () => {
    it('rejects second verification attempt on already paid invoice', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 50, assetCode: 'XLM', expiresInDays: 7 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: invoice.memo },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '50.0000000',
          },
        ],
      };

      // First verification succeeds
      const firstRes = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        firstRes
      );
      assert.equal(firstRes.statusCode, 200);

      // Replay attempt
      const secondRes = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH } } as any,
        secondRes
      );

      assert.equal(secondRes.statusCode, 400);
      assert.equal(secondRes.body.code, 'INVOICE_ALREADY_PAID');
    });
  });

  describe('Failure Mode 7: Stellar Network Mismatch', () => {
    it('rejects public network transaction for testnet invoice', async () => {
      const createRes = createMockRes();
      await handlers.createInvoice(
        {
          body: { sellerPublicKey: SELLER_KEY, amount: 50, assetCode: 'XLM', expiresInDays: 7 },
        } as any,
        createRes
      );
      const invoice = createRes.body.data.invoice;

      mockHorizonTx = {
        transaction: { id: VALID_TX_HASH, hash: VALID_TX_HASH, memo: invoice.memo },
        operations: [
          {
            type: 'payment',
            asset_type: 'native',
            asset_code: 'XLM',
            from: PAYER_KEY,
            to: SELLER_KEY,
            amount: '50.0000000',
          },
        ],
      };

      const res = createMockRes();
      await handlers.verifyPayment(
        { params: { id: invoice.id }, body: { txHash: VALID_TX_HASH, network: 'PUBLIC' } } as any,
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'NETWORK_MISMATCH');
    });
  });
});
