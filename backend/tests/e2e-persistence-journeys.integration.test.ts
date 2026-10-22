/**
 * End-to-end integration test suite exercising full user journeys against
 * BOTH persistence modes: In-Memory MVP mode and Postgres persistence mode (Issue #40).
 *
 * User Journey under test:
 * 1. Create invoice (seller wallet, amount, memo, asset, customer details)
 * 2. Pay via stubbed Freighter wallet flow (simulated transaction signing & ledger submission)
 * 3. Verify payment via API -> transition to PAID, record payer details & tx hash
 * 4. Generate quittance proof + queue proof delivery email
 * 5. Dashboard history and revenue aggregation assertions
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import express, { type Application } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createInvoiceRouter } from '../src/routes/invoice.routes';
import { createEmailRouter } from '../src/routes/email.routes';
import { createAuthRouter } from '../src/routes/auth.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service';
import { MemoryStorage } from '../src/storage/memory-storage';
import { PostgresInvoiceStorage } from '../src/storage/postgres-invoice-storage';
import { FakeInvoiceDb } from './fixtures/fake-invoice-db.fixture';
import { EmailQueueService, MockTransporter } from '../src/services/email-queue.service';
import { MemoryEmailDeliveryStorage } from '../src/storage/memory-email-delivery-storage';
import { PostgresEmailDeliveryStorage } from '../src/storage/postgres-email-delivery-storage';
import { EmailAntiSpamService } from '../src/services/email-anti-spam.service';
import { buildQuittanceProof, isQuittanceProof } from '../../frontend/lib/quittance-proof';
import { walletAuth } from './fixtures/auth.fixture';

const SELLER_WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const PAYER_WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

import { InvoiceService } from '../src/services/invoice.service';

// Request and queue logging is noise here and, at volume, makes the node:test
// runner's IPC stream fail ("Unable to deserialize cloned data"), as in
// access-control.test.ts.
for (const method of ['log', 'warn', 'error', 'info'] as const) {
  console[method] = () => undefined;
}

interface PersistenceModeConfig {
  name: string;
  setup: () => {
    storage: any;
    emailStorage: any;
  };
}

const PERSISTENCE_MODES: PersistenceModeConfig[] = [
  {
    name: 'Mode 1: In-Memory MVP Persistence',
    setup: () => {
      const memoryStore = new MemoryStorage();
      const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(memoryStore));
      const emailStorage = new MemoryEmailDeliveryStorage();
      return { storage, emailStorage };
    },
  },
  {
    name: 'Mode 2: PostgreSQL Persistence (via FakeInvoiceDb schema double)',
    setup: () => {
      const fakeDb = new FakeInvoiceDb();
      const storage = new PostgresInvoiceStorage(new InvoiceService(fakeDb as any));
      const emailStorage = new MemoryEmailDeliveryStorage(); // In-memory double for delivery storage
      return { storage, emailStorage };
    },
  },
];

class StubFreighterWallet {
  public publicKey: string;

  constructor(publicKey: string) {
    this.publicKey = publicKey;
  }

  public signAndSubmitPayment(invoice: {
    memo: string;
    amount: string | number;
    sellerPublicKey: string;
    assetCode: string;
    assetIssuer?: string;
  }) {
    const txHash = 'f'.repeat(60) + Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    const transaction = {
      hash: txHash,
      memo: invoice.memo,
      memo_type: 'text',
      created_at: new Date().toISOString(),
    };

    const isCredit = invoice.assetCode !== 'XLM';
    const operations = [
      {
        type: isCredit ? 'payment' : 'payment',
        from: this.publicKey,
        to: invoice.sellerPublicKey,
        amount: typeof invoice.amount === 'number' ? invoice.amount.toFixed(7) : invoice.amount,
        asset_type: isCredit ? 'credit_alphanum4' : 'native',
        asset_code: isCredit ? invoice.assetCode : undefined,
        asset_issuer: isCredit ? invoice.assetIssuer : undefined,
      },
    ];

    return { txHash, transaction, operations };
  }
}

function jsonRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string | number> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const reqHeaders: Record<string, string | number> = {
      Accept: 'application/json',
      ...headers,
    };
    if (payload !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('Issue #40: End-to-End User Journeys Across MVP and Postgres Persistence Modes', () => {
  for (const mode of PERSISTENCE_MODES) {
    describe(mode.name, () => {
      let app: Application;
      let server: http.Server;
      let port: number;
      let storage: any;
      let emailQueue: EmailQueueService;
      let transporter: MockTransporter;
      let horizonStubTxs: Map<string, { transaction: any; operations: any[] }> = new Map();

      before(async () => {
        const env = mode.setup();
        storage = env.storage;

        transporter = new MockTransporter();
        const antiSpam = new EmailAntiSpamService({ maxEmailsPerHourPerWallet: 50 });
        emailQueue = new EmailQueueService({
          storage: env.emailStorage,
          antiSpam,
          transporter,
        });

        const mockStellar = {
          getTransaction: async (hash: string) => {
            const found = horizonStubTxs.get(hash);
            if (!found) throw new Error('Transaction not found on Stellar');
            return found;
          },
        };

        app = express();
        app.use(express.json());
        app.use('/api', createAuthRouter());
        app.use('/api', createInvoiceRouter({ storage, stellar: mockStellar as any }));
        app.use('/api', createEmailRouter({ storage, queueService: emailQueue }));

        await new Promise<void>((resolve) => {
          server = app.listen(0, '127.0.0.1', () => {
            port = (server.address() as AddressInfo).port;
            resolve();
          });
        });
      });

      after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      it('executes full journey: Create -> Pay via Freighter -> Verify -> Proof -> Deliveries -> Dashboard', async () => {
        const auth = walletAuth(SELLER_WALLET);

        // Step 1: Create Invoice
        const createRes = await jsonRequest(
          port,
          'POST',
          '/api/invoices',
          {
            sellerPublicKey: SELLER_WALLET,
            sellerName: 'Alice Freelancer',
            sellerEmail: 'alice@freelance.example',
            amount: 150.0,
            assetCode: 'USDC',
            assetIssuer: USDC_ISSUER,
            description: 'Web development work for Q3',
            customerName: 'Acme Corp',
            customerEmail: 'billing@acme.example',
          },
          auth
        );

        assert.equal(createRes.status, 201, `Failed to create invoice: ${JSON.stringify(createRes.body)}`);
        assert.equal(createRes.body.success, true);
        const invoice = createRes.body.data.invoice ?? createRes.body.data;
        assert.equal(invoice.status, 'PENDING');
        assert.equal(invoice.sellerPublicKey, SELLER_WALLET);
        assert.equal(invoice.assetCode, 'USDC');
        assert.ok(invoice.memo.startsWith('INV-'));

        // Step 2: Pay via Stubbed Freighter Wallet
        const wallet = new StubFreighterWallet(PAYER_WALLET);
        const paymentResult = wallet.signAndSubmitPayment({
          memo: invoice.memo,
          amount: '150.0000000',
          sellerPublicKey: SELLER_WALLET,
          assetCode: 'USDC',
          assetIssuer: USDC_ISSUER,
        });

        // Register tx in Horizon stub
        horizonStubTxs.set(paymentResult.txHash, {
          transaction: paymentResult.transaction,
          operations: paymentResult.operations,
        });

        // Step 3: Verify Payment
        const verifyRes = await jsonRequest(
          port,
          'POST',
          `/api/invoices/${invoice.id}/verify`,
          {
            txHash: paymentResult.txHash,
            payerName: 'Acme Accounts Payable',
            payerEmail: 'ap@acme.example',
            network: 'TESTNET',
          }
        );

        assert.equal(verifyRes.status, 200, `Failed to verify payment: ${JSON.stringify(verifyRes.body)}`);
        assert.equal(verifyRes.body.success, true);
        const paidInvoice = verifyRes.body.data;
        assert.equal(paidInvoice.status, 'PAID');
        assert.equal(paidInvoice.paymentTxHash, paymentResult.txHash);
        assert.equal(paidInvoice.payerPublicKey, PAYER_WALLET);
        assert.equal(paidInvoice.payerName, 'Acme Accounts Payable');
        assert.equal(paidInvoice.payerEmail, 'ap@acme.example');
        assert.ok(paidInvoice.paidAt);

        // Step 4: Quittance Proof Generation & Email Proof
        const proofResult = buildQuittanceProof(paidInvoice, {
          network: 'testnet',
          now: new Date(),
        });
        assert.equal(proofResult.ok, true);
        assert.equal(isQuittanceProof(proofResult.proof), true);
        assert.equal(proofResult.proof?.invoiceId, invoice.id);
        assert.equal(proofResult.proof?.status, 'PAID');

        // Queue payment proof email
        const proofEmailRes = await jsonRequest(
          port,
          'POST',
          `/api/invoices/${invoice.id}/send-proof`,
          {
            recipientEmail: 'ap@acme.example',
          },
          auth
        );
        assert.equal(proofEmailRes.status, 202);
        assert.equal(proofEmailRes.body.success, true);
        const deliveryId = proofEmailRes.body.data.id;

        // Process email queue
        await emailQueue.processDelivery(deliveryId);
        assert.equal(transporter.sentEmails.length, 1);
        assert.equal(transporter.sentEmails[0].to, 'ap@acme.example');

        // Check freelancer delivery visibility
        const deliveriesRes = await jsonRequest(
          port,
          'GET',
          `/api/invoices/${invoice.id}/deliveries`,
          undefined,
          auth
        );
        assert.equal(deliveriesRes.status, 200);
        assert.equal(deliveriesRes.body.data.length, 1);
        assert.equal(deliveriesRes.body.data[0].status, 'SENT');

        // Step 5: Dashboard & Stats View
        const listRes = await jsonRequest(
          port,
          'GET',
          `/api/invoices?sellerPublicKey=${SELLER_WALLET}`,
          undefined,
          auth
        );
        assert.equal(listRes.status, 200);
        assert.equal(listRes.body.data.length >= 1, true);

        const statsRes = await jsonRequest(
          port,
          'GET',
          `/api/invoices/stats?sellerPublicKey=${SELLER_WALLET}`,
          undefined,
          auth
        );
        assert.equal(statsRes.status, 200);
        const stats = statsRes.body.data;
        assert.ok(Array.isArray(stats) && stats.length >= 1);
        const firstStat = stats[0];
        assert.equal(Number(firstStat.paid_invoices ?? firstStat.paidInvoices), 1);
        const usdcRevenue = firstStat.revenue_by_asset?.USDC ?? firstStat.revenueByAsset?.USDC;
        assert.equal(Number(usdcRevenue), 150);
      });
    });
  }
});
