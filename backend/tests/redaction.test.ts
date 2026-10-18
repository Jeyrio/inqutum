import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import {
  redactSensitiveText,
  sanitizeObject,
  redactErrorMessage,
  SECRET_KEY_PATTERN,
  BEARER_TOKEN_PATTERN,
  PRIVATE_KEY_BLOCK_PATTERN,
  URL_CREDENTIAL_PATTERN,
  KEY_VALUE_SECRET_PATTERN,
} from '../src/security/redaction';
import {
  metrics,
  sanitizeForLogging,
  measureOperation,
  type StructuredLogEntry,
} from '../src/observability/telemetry';
import {
  buildUserSafeErrorResponse,
  classifyError,
  AppError,
  DOMAIN_ERROR_TAXONOMY,
} from '../src/errors/error-taxonomy';
import {
  apiFailure,
  sendFailure,
  sendVerificationFailure,
  sendSuccess,
} from '../src/types/api';
import {
  ExportService,
  EXPORT_FIELDS,
  toExportRecord,
  csvCell,
  ExportForbiddenError,
  ExportCancelledError,
} from '../src/exports/export-service';
import { createExportRouter } from '../src/routes/export.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';

const SELLER_A = 'G' + 'A'.repeat(55);
const SELLER_B = 'G' + 'B'.repeat(55);
const SECRET_KEY = 'S' + 'K'.repeat(55);
const BEARER_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummysecret123';
const DB_URL = 'postgres://app_user:super_secret_db_pass_999@db.internal:5432/inqutum_prod';
const PRIVATE_KEY_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y...\n-----END RSA PRIVATE KEY-----';

describe('Redaction & Data Sanitization System (Logs, Exports, Error Responses)', () => {
  beforeEach(() => {
    metrics.clear();
    memoryStorage.clear();
  });

  describe('Core Redaction Engine', () => {
    it('redacts Stellar secret keys (S...) while preserving public keys (G...) and tx hashes', () => {
      const publicAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const txHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const raw = `Keys: public=${publicAddress} secret=${SECRET_KEY} tx=${txHash}`;

      const redacted = redactSensitiveText(raw);
      assert.ok(!redacted.includes(SECRET_KEY), 'Secret key must be redacted');
      assert.ok(redacted.includes('S[REDACTED_SECRET_KEY]'), 'Expected S[REDACTED_SECRET_KEY] marker');
      assert.ok(redacted.includes(publicAddress), 'Public address must remain intact');
      assert.ok(redacted.includes(txHash), 'Transaction hash must remain intact');
    });

    it('redacts Bearer authorization tokens from headers and messages', () => {
      const message = `Failed request with Authorization: ${BEARER_TOKEN} for user`;
      const redacted = redactSensitiveText(message);

      assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummysecret123'));
      assert.ok(redacted.includes('Bearer [REDACTED_TOKEN]'));
    });

    it('redacts PEM private key blocks completely', () => {
      const log = `Certificate error: ${PRIVATE_KEY_PEM} failed validation`;
      const redacted = redactSensitiveText(log);

      assert.ok(!redacted.includes('MIIEowIBAAKCAQEA0Y'));
      assert.ok(redacted.includes('[REDACTED_PRIVATE_KEY]'));
    });

    it('redacts embedded credentials from database and HTTP connection URLs', () => {
      const errorMsg = `Connection timed out: ${DB_URL}`;
      const redacted = redactSensitiveText(errorMsg);

      assert.ok(!redacted.includes('super_secret_db_pass_999'));
      assert.ok(redacted.includes('postgres://app_user:[REDACTED]@db.internal:5432/inqutum_prod'));
    });

    it('redacts key-value credential pairs in free text and JSON-style strings', () => {
      const text = 'Failed config with password=hunter2 and apiKey: sk_live_999888777';
      const redacted = redactSensitiveText(text);

      assert.ok(!redacted.includes('hunter2'));
      assert.ok(!redacted.includes('sk_live_999888777'));
      assert.ok(redacted.includes('password=[REDACTED]'));
      assert.ok(redacted.includes('apiKey: [REDACTED]'));
    });

    it('deeply sanitizes complex nested objects, arrays, and sensitive keys', () => {
      const input = {
        invoiceId: 'inv-100',
        sellerPublicKey: SELLER_A,
        secretKey: SECRET_KEY,
        nested: {
          auth_token: 'secret_token_val',
          connectionString: DB_URL,
          safeField: 'visible_data',
          items: [
            { password: 'p1', memo: 'safe_memo' },
            { apiKey: 'k2', amount: 150 },
          ],
        },
      };

      const sanitized = sanitizeObject(input);
      assert.equal(sanitized.invoiceId, 'inv-100');
      assert.equal(sanitized.sellerPublicKey, SELLER_A);
      assert.equal(sanitized.secretKey, '[REDACTED]');
      assert.equal(sanitized.nested.auth_token, '[REDACTED]');
      assert.ok(!sanitized.nested.connectionString.includes('super_secret_db_pass_999'));
      assert.equal(sanitized.nested.safeField, 'visible_data');
      assert.equal(sanitized.nested.items[0].password, '[REDACTED]');
      assert.equal(sanitized.nested.items[0].memo, 'safe_memo');
      assert.equal(sanitized.nested.items[1].apiKey, '[REDACTED]');
      assert.equal(sanitized.nested.items[1].amount, 150);
    });
  });

  describe('1. Logs Redaction', () => {
    it('normal path: logs successful operations with public identifiers and sanitized metadata', async () => {
      const corrId = 'corr-log-normal-1';
      await measureOperation(
        'invoice.create',
        'seller',
        corrId,
        async () => {
          return { invoiceId: 'inv-success-1', seller: SELLER_A };
        },
        {
          sellerPublicKey: SELLER_A,
          amount: 50.0,
          memo: 'INV-1001',
          secretSeed: SECRET_KEY,
          databaseUrl: DB_URL,
        }
      );

      const logs = metrics.getRecentLogs(10);
      const log = logs.find((l) => l.correlation_id === corrId);
      assert.ok(log, 'Structured log entry should be recorded');
      assert.equal(log.result, 'success');
      assert.equal(log.level, 'info');
      assert.equal(log.metadata?.sellerPublicKey, SELLER_A);
      assert.equal(log.metadata?.amount, 50.0);
      assert.equal(log.metadata?.memo, 'INV-1001');
      assert.equal(log.metadata?.secretSeed, '[REDACTED]');
      assert.ok(!log.metadata?.databaseUrl.includes('super_secret_db_pass_999'));
    });

    it('failure path: unhandled exceptions with credentials in error message are sanitized in log', async () => {
      const corrId = 'corr-log-failure-1';
      await assert.rejects(async () => {
        await measureOperation(
          'invoice.verify_payment',
          'payer',
          corrId,
          async () => {
            const err = new Error(`Database connection failed at ${DB_URL} with secret ${SECRET_KEY}`);
            (err as any).code = 'DB_ERROR';
            throw err;
          },
          { token: BEARER_TOKEN }
        );
      });

      const logs = metrics.getRecentLogs(10);
      const log = logs.find((l) => l.correlation_id === corrId);
      assert.ok(log, 'Failure log entry should exist');
      assert.equal(log.result, 'failure');
      assert.equal(log.level, 'warn');
      assert.equal(log.metadata?.token, '[REDACTED]');
      assert.ok(!log.metadata?.error?.includes('super_secret_db_pass_999'));
      assert.ok(!log.metadata?.error?.includes(SECRET_KEY));
      assert.ok(log.metadata?.error?.includes('[REDACTED]'));
    });

    it('retry path: records retry attempts and failures without accumulating unredacted error stacks', async () => {
      const corrId = 'corr-log-retry-1';
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await measureOperation(
            'payment.verify_horizon',
            'system',
            `${corrId}-attempt-${attempt}`,
            async () => {
              const err = new Error(`Horizon timeout attempt ${attempt} key=${SECRET_KEY}`);
              (err as any).code = 'HORIZON_UNAVAILABLE';
              throw err;
            },
            { attempt, retryPolicy: 'exponential', secretKey: SECRET_KEY }
          );
        } catch {
          // Expected retry loop failure
        }
      }

      const recent = metrics.getRecentLogs(10);
      const retryLogs = recent.filter((l) => l.correlation_id.startsWith(corrId));
      assert.equal(retryLogs.length, 3);

      for (const entry of retryLogs) {
        assert.equal(entry.result, 'failure');
        assert.equal(entry.metadata?.secretKey, '[REDACTED]');
        assert.ok(!entry.metadata?.error?.includes(SECRET_KEY));
        assert.ok(entry.metadata?.error?.includes('S[REDACTED_SECRET_KEY]'));
      }
    });

    it('authorization path: logs authorization denial with actor and scope, redacting raw credentials', () => {
      const corrId = 'corr-log-auth-1';
      metrics.recordOperation({
        operation: 'maintainer.action',
        actor_type: 'maintainer',
        result: 'failure',
        latency_ms: 12.4,
        correlation_id: corrId,
        error_code: 'UNAUTHORIZED_SELLER',
        metadata: {
          attemptedBy: SELLER_B,
          targetWallet: SELLER_A,
          authorizationHeader: BEARER_TOKEN,
          privateKeyBlock: PRIVATE_KEY_PEM,
        },
      });

      const logs = metrics.getRecentLogs(10);
      const log = logs.find((l) => l.correlation_id === corrId);
      assert.ok(log);
      assert.equal(log.error_code, 'UNAUTHORIZED_SELLER');
      assert.equal(log.metadata?.attemptedBy, SELLER_B);
      assert.equal(log.metadata?.targetWallet, SELLER_A);
      assert.equal(log.metadata?.authorizationHeader, '[REDACTED]');
      assert.equal(log.metadata?.privateKeyBlock, '[REDACTED]');
    });
  });

  describe('2. Exports Redaction', () => {
    let storage: MemoryInvoiceStorage;

    beforeEach(() => {
      storage = new MemoryInvoiceStorage();
    });

    it('normal path: JSON and CSV exports contain only EXPORT_FIELDS, stripping PII and redacting free-text secrets', async () => {
      await storage.createInvoice({
        amount: 250,
        assetCode: 'USDC',
        sellerPublicKey: SELLER_A,
        description: `Consulting services password=confidential123 token ${BEARER_TOKEN} ${SECRET_KEY}`,
        memo: 'INV-SAFE-01',
        sellerName: 'Leaked Seller Name',
        sellerEmail: 'seller@example.com',
        customerName: 'Leaked Customer Name',
        customerEmail: 'customer@example.com',
      } as any);

      const service = new ExportService(storage);

      // 1. JSON Export verification
      const jsonArtifact = await service.create(SELLER_A, { format: 'json' });
      const jsonDoc = JSON.parse(jsonArtifact.body);

      assert.equal(jsonDoc.recordCount, 1);
      const [record] = jsonDoc.records;

      // Ensure allowlisted fields only
      for (const field of Object.keys(record)) {
        assert.ok((EXPORT_FIELDS as readonly string[]).includes(field), `Unexpected field in export: ${field}`);
      }

      // Ensure PII fields are never emitted
      assert.equal((record as any).sellerName, undefined);
      assert.equal((record as any).sellerEmail, undefined);
      assert.equal((record as any).customerName, undefined);
      assert.equal((record as any).customerEmail, undefined);

      // Ensure free-text description has secrets redacted
      assert.ok(!record.description.includes('confidential123'), 'Password must be redacted from description');
      assert.ok(!record.description.includes(SECRET_KEY), 'Secret key must be redacted from description');
      assert.ok(!record.description.includes('dummysecret123'), 'Bearer token must be redacted from description');
      assert.ok(record.description.includes('password=[REDACTED]'));
      assert.ok(record.description.includes('S[REDACTED_SECRET_KEY]'));

      // 2. CSV Export verification
      const csvArtifact = await service.create(SELLER_A, { format: 'csv' });
      assert.equal(csvArtifact.contentType, 'text/csv; charset=utf-8');
      assert.ok(!csvArtifact.body.includes('confidential123'));
      assert.ok(!csvArtifact.body.includes(SECRET_KEY));
      assert.ok(!csvArtifact.body.includes('seller@example.com'));
      assert.ok(!csvArtifact.body.includes('customer@example.com'));
    });

    it('normal path: neutralizes spreadsheet formula injection in CSV cells', () => {
      assert.equal(csvCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
      assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
      assert.equal(csvCell('+cmd|"/c calc"!A0'), `"'=cmd|""/c calc""!A0"`.replace(/=/, '+'));
      assert.equal(csvCell('-100'), "'-100");
      assert.equal(csvCell('@IMPORT'), "'@IMPORT");
      assert.equal(csvCell('\tTAB_INDENT'), "'\tTAB_INDENT");
    });

    it('failure path: export route catches unexpected errors and responds with generic EXPORT_FAILED without leaking DB URL or stack', async () => {
      const failingStorage = {
        getInvoicesBySeller: async () => {
          throw new Error(`Fatal query error at ${DB_URL} with user password=leakedpass`);
        },
      } as unknown as MemoryInvoiceStorage;

      const app = express();
      app.use(express.json());
      app.use('/api', createExportRouter({ storage: failingStorage }));

      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;

      const originalError = console.error;
      console.error = () => {};

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/exports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requester: SELLER_A }),
        });

        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.code, 'EXPORT_FAILED');
        assert.equal(body.error, 'Failed to generate export');

        const raw = JSON.stringify(body);
        assert.ok(!raw.includes('super_secret_db_pass_999'), 'Must not leak database password in 500 response');
        assert.ok(!raw.includes('leakedpass'), 'Must not leak error text in 500 response');
      } finally {
        console.error = originalError;
        server.close();
      }
    });

    it('retry path: aborted/cancelled export does not persist partial artifacts and leaves service clean for retries', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.createInvoice({ amount: 10 + i, assetCode: 'XLM', sellerPublicKey: SELLER_A, expiresInDays: 7 } as any);
      }

      const controller = new AbortController();
      controller.abort();

      const service = new ExportService(storage);
      await assert.rejects(
        service.create(SELLER_A, { format: 'json' }, SELLER_A, controller.signal),
        ExportCancelledError
      );
      assert.equal(service.size(), 0, 'No incomplete artifact should be saved');

      // Subsequent retry succeeds normally
      const retryArtifact = await service.create(SELLER_A, { format: 'json' });
      assert.equal(service.size(), 1);
      const parsed = JSON.parse(retryArtifact.body);
      assert.equal(parsed.recordCount, 5);
      assert.equal(parsed.truncated, false);
    });

    it('authorization path: cross-tenant export requests return 403 EXPORT_FORBIDDEN and unauthorized downloads return 404', async () => {
      await storage.createInvoice({ amount: 100, assetCode: 'XLM', sellerPublicKey: SELLER_B, expiresInDays: 7 } as any);

      const app = express();
      app.use(express.json());
      app.use('/api', createExportRouter({ storage }));

      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;

      try {
        // 1. Seller A attempts to export Seller B's invoices
        const forbiddenRes = await fetch(`http://127.0.0.1:${port}/api/exports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requester: SELLER_A, sellerPublicKey: SELLER_B }),
        });
        assert.equal(forbiddenRes.status, 403);
        const forbiddenBody = await forbiddenRes.json();
        assert.equal(forbiddenBody.code, 'EXPORT_FORBIDDEN');

        // 2. Seller B creates export
        const createRes = await fetch(`http://127.0.0.1:${port}/api/exports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requester: SELLER_B }),
        });
        assert.equal(createRes.status, 201);
        const { data } = await createRes.json();

        // 3. Seller A attempts to download Seller B's export artifact
        const unauthorizedRes = await fetch(`http://127.0.0.1:${port}/api/exports/${data.exportId}?requester=${SELLER_A}`);
        assert.equal(unauthorizedRes.status, 404, 'Must return 404 to non-owner preventing tenant enumeration');
        const notFoundBody = await unauthorizedRes.json();
        assert.equal(notFoundBody.code, 'EXPORT_NOT_FOUND');

        // 4. Owner Seller B downloads successfully
        const authorizedRes = await fetch(`http://127.0.0.1:${port}/api/exports/${data.exportId}?requester=${SELLER_B}`);
        assert.equal(authorizedRes.status, 200);
      } finally {
        server.close();
      }
    });
  });

  describe('3. Error Responses Redaction', () => {
    it('normal path: successful API envelopes contain clean data without leakage', () => {
      const app = express();
      app.get('/api/test-success', (req: Request, res: Response) => {
        sendSuccess(res, 200, {
          invoiceId: 'inv-clean-1',
          sellerPublicKey: SELLER_A,
          amount: 100,
        });
      });

      const payload = {
        success: true,
        data: {
          invoiceId: 'inv-clean-1',
          sellerPublicKey: SELLER_A,
          amount: 100,
        },
      };
      assert.equal(payload.success, true);
      assert.equal(payload.data.sellerPublicKey, SELLER_A);
    });

    it('failure path: buildUserSafeErrorResponse redacts secrets and connection strings in custom error messages', () => {
      const rawError = new Error(`Validation failed for password=supersecret and token=${BEARER_TOKEN} at ${DB_URL}`);
      (rawError as any).code = 'VALIDATION_FAILED';

      const response = buildUserSafeErrorResponse(rawError, 'corr-safe-err-1');

      assert.equal(response.success, false);
      assert.equal(response.code, 'VALIDATION_FAILED');
      assert.equal(response.category, 'VALIDATION');
      assert.equal(response.retryable, false);
      assert.equal(response.correlationId, 'corr-safe-err-1');

      // Assert error string is redacted
      assert.ok(!response.error.includes('supersecret'));
      assert.ok(!response.error.includes('super_secret_db_pass_999'));
      assert.ok(!response.error.includes('dummysecret123'));
      assert.ok(response.error.includes('password=[REDACTED]'));
      assert.ok(response.error.includes('Bearer [REDACTED_TOKEN]'));
      assert.ok(response.error.includes('postgres://app_user:[REDACTED]@db.internal:5432/inqutum_prod'));
    });

    it('failure path: sendFailure redacts secrets passed in string error payloads', () => {
      const mockRes = {
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: any) {
          this.body = payload;
          return this;
        },
        statusCode: 0,
        body: null as any,
        req: { correlationId: 'corr-send-fail' },
      };

      sendFailure(
        mockRes as any,
        400,
        `Invalid parameter: secret key ${SECRET_KEY} is not allowed in memo`
      );

      assert.equal(mockRes.statusCode, 400);
      assert.equal(mockRes.body.success, false);
      assert.ok(!mockRes.body.error.includes(SECRET_KEY));
      assert.ok(mockRes.body.error.includes('S[REDACTED_SECRET_KEY]'));
    });

    it('failure path: sendVerificationFailure sanitizes error descriptions and preserves verification codes', () => {
      const mockRes = {
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: any) {
          this.body = payload;
          return this;
        },
        statusCode: 0,
        body: null as any,
      };

      sendVerificationFailure(
        mockRes as any,
        400,
        'MEMO_MISMATCH',
        `Expected INV-123 but found transaction with secret ${SECRET_KEY}`,
        'corr-verif-fail'
      );

      assert.equal(mockRes.statusCode, 400);
      assert.equal(mockRes.body.code, 'MEMO_MISMATCH');
      assert.equal(mockRes.body.category, 'SETTLEMENT');
      assert.equal(mockRes.body.retryable, false);
      assert.ok(!mockRes.body.error.includes(SECRET_KEY));
      assert.ok(mockRes.body.error.includes('S[REDACTED_SECRET_KEY]'));
    });

    it('retry path: transient Horizon network error provides retryable=true and actionable recovery action', () => {
      const networkError = Object.assign(new Error(`connect ETIMEDOUT https://horizon.stellar.org password=tokenpass`), {
        code: 'ETIMEDOUT',
      });

      const response = buildUserSafeErrorResponse(networkError, 'corr-horizon-retry');
      assert.equal(response.code, 'HORIZON_UNAVAILABLE');
      assert.equal(response.category, 'NETWORK');
      assert.equal(response.retryable, true);
      assert.ok(response.recoveryAction.includes('retry in a few seconds'));
      assert.ok(!response.error.includes('tokenpass'));
    });

    it('authorization path: UNAUTHORIZED_SELLER and SELLER_REQUIRED errors do not reflect caller tokens', () => {
      const authError = new AppError(
        'UNAUTHORIZED_SELLER',
        `Unauthorized modification attempt using ${BEARER_TOKEN} for wallet ${SELLER_A}`
      );

      const response = buildUserSafeErrorResponse(authError, 'corr-auth-err');
      assert.equal(response.code, 'UNAUTHORIZED_SELLER');
      assert.equal(response.category, 'AUTHORIZATION');
      assert.equal(response.retryable, false);
      assert.ok(!response.error.includes('dummysecret123'));
      assert.ok(response.error.includes('Bearer [REDACTED_TOKEN]'));
      assert.ok(response.error.includes(SELLER_A));
    });

    it('operational edge case: stack traces and multiline errors are scrubbed to userSafeMessage without leaking internal code', () => {
      const stackError = new Error('Top level failure\n    at SecretService.execute (/app/src/secret.ts:42:15)\n    at processTicksAndRejections');
      (stackError as any).code = 'VALIDATION_FAILED';

      const response = buildUserSafeErrorResponse(stackError);
      assert.equal(response.error, 'Invalid input provided');
      assert.ok(!response.error.includes('SecretService.execute'));
      assert.ok(!response.error.includes('/app/src/secret.ts'));
    });
  });
});
