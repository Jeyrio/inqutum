import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  escapeHtml,
  escapeHtmlAttribute,
  sanitizeEmailHeader,
  sanitizePlainText,
  validateClientName,
  validateNotesOrDescription,
  validateWebhookDestinationUrl,
  sanitizeWebhookPayload,
  API_SECURITY_HEADERS,
} from '../src/security/content-safety';
import {
  ExportService,
  toExportRecord,
  csvCell,
  EXPORT_FIELDS,
  type ExportRequest,
} from '../src/exports/export-service';
import type { InvoiceStorage, StoredInvoice } from '../src/storage/invoice-storage';

describe('Sensitive content boundary contracts (Issue #266)', () => {
  describe('Rendering boundary tests', () => {
    it('proves script tags and nested script payloads cannot execute or re-form', () => {
      const maliciousPayloads = [
        '<script>alert("XSS")</script>',
        '<SCRIPT>alert(1)</SCRIPT>',
        '<script src="https://attacker.com/malware.js"></script>',
        '<<script>script>alert(1)<</script>/script>',
        '<img src="x" onerror="alert(1)">',
        '<svg onload="alert(1)">',
        '<iframe src="javascript:alert(1)"></iframe>',
      ];

      for (const payload of maliciousPayloads) {
        const sanitized = sanitizePlainText(payload);
        assert.doesNotMatch(sanitized, /<script/i, `Payload should strip script tag: ${payload}`);
        assert.doesNotMatch(sanitized, /onerror=/i, `Payload should strip onerror attribute: ${payload}`);
        assert.doesNotMatch(sanitized, /onload=/i, `Payload should strip onload attribute: ${payload}`);
        assert.doesNotMatch(sanitized, /<iframe/i, `Payload should strip iframe tag: ${payload}`);

        const escaped = escapeHtml(payload);
        assert.doesNotMatch(escaped, /<[a-zA-Z]/, `Escaped payload should not have raw tag openings: ${payload}`);
      }
    });

    it('proves attribute breakouts cannot escape double- or single-quoted contexts', () => {
      const payloads = [
        '" onfocus="alert(1)" x="',
        "' onclick='alert(1)' y='",
        '` onload=`alert(1)`',
      ];

      for (const payload of payloads) {
        const escaped = escapeHtmlAttribute(payload);
        assert.doesNotMatch(escaped, /"/, 'Double quotes must be escaped in attribute context');
        assert.doesNotMatch(escaped, /'/, 'Single quotes must be escaped in attribute context');
        assert.doesNotMatch(escaped, /`/, 'Backticks must be escaped in attribute context');
      }
    });

    it('proves template injection tokens are rejected by field validators', () => {
      const templatePayloads = [
        '{{7*7}}',
        '${process.env.DATABASE_URL}',
        '<% system("calc") %>',
        '#{root.process}',
      ];

      for (const payload of templatePayloads) {
        assert.equal(validateClientName(payload), false, `validateClientName should reject template: ${payload}`);
        assert.equal(validateNotesOrDescription(payload), false, `validateNotesOrDescription should reject template: ${payload}`);
      }
    });

    it('proves CRLF injection is stripped from email headers', () => {
      const headerAttack = 'Subject\r\nBcc: evil@attacker.com\r\n\r\nMalicious body text';
      const clean = sanitizeEmailHeader(headerAttack);
      assert.doesNotMatch(clean, /\r/, 'Must not contain CR');
      assert.doesNotMatch(clean, /\n/, 'Must not contain LF');
      assert.equal(clean, 'Subject Bcc: evil@attacker.com Malicious body text');
    });

    it('verifies strict nosniff and frame-ancestors headers on API responses', () => {
      assert.equal(API_SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
      assert.equal(API_SECURITY_HEADERS['X-Frame-Options'], 'DENY');
      assert.match(API_SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
    });
  });

  describe('Downloads boundary tests', () => {
    it('proves spreadsheet formula injection triggers are neutralised with leading apostrophes', () => {
      const dangerousCellValues = [
        '=cmd|\' /C calc\'!A0',
        '+1+1',
        '-2+3',
        '@SUM(A1:A10)',
        '\t=2+2',
        '\r=1+1',
      ];

      for (const val of dangerousCellValues) {
        const cell = csvCell(val);
        assert.ok(
          cell.startsWith(`"'`) || cell.startsWith(`'`),
          `Cell starting with formula char must be prefixed with apostrophe: ${val} -> ${cell}`
        );
      }
    });

    it('leaves ordinary numbers and text unaffected in CSV cells', () => {
      assert.equal(csvCell(100.5), '100.5');
      assert.equal(csvCell('Standard Product'), 'Standard Product');
      assert.equal(csvCell(''), '');
      assert.equal(csvCell(null), '');
    });
  });

  describe('Webhooks boundary tests', () => {
    it('proves SSRF prevention blocks loopback, cloud metadata, and RFC 1918 private IPs', () => {
      const blockedDestinations = [
        'http://localhost/webhook',
        'https://127.0.0.1/callback',
        'https://0.0.0.0/test',
        'https://169.254.169.254/latest/meta-data/',
        'https://metadata.google.internal/computeMetadata/v1/',
        'https://10.0.0.1/hook',
        'https://172.16.1.1/hook',
        'https://192.168.1.100/hook',
        'https://user:password@legit-domain.com/webhook',
        'javascript:alert(1)',
        'file:///etc/hosts',
      ];

      for (const url of blockedDestinations) {
        assert.equal(
          validateWebhookDestinationUrl(url),
          false,
          `validateWebhookDestinationUrl should reject dangerous destination: ${url}`
        );
      }
    });

    it('permits valid public HTTPS webhook destinations', () => {
      assert.equal(validateWebhookDestinationUrl('https://api.merchant.com/webhooks/inqutum'), true);
      assert.equal(validateWebhookDestinationUrl('https://hooks.slack.com/services/T00/B00/X00'), true);
    });

    it('proves webhook payloads strip sensitive internal fields and preserve allowlisted fields', () => {
      const rawEvent = {
        id: 'evt-100',
        type: 'invoice.settled',
        invoiceId: 'inv-123',
        memo: 'MEMO-999',
        status: 'PAID',
        amount: 500,
        assetCode: 'USDC',
        sellerPublicKey: 'GABC123',
        createdAt: '2026-10-15T12:00:00Z',
        // SENSITIVE INTERNAL FIELDS THAT MUST NEVER LEAK:
        internalDatabaseId: 42,
        sellerPrivateKey: 'SABCD1234567890',
        adminAuthToken: 'secret_token_xyz',
        dbConnectionString: 'postgres://user:pass@db:5432/inqutum',
      };

      const sanitized = sanitizeWebhookPayload(rawEvent);

      // Verify public fields preserved
      assert.equal(sanitized.id, 'evt-100');
      assert.equal(sanitized.type, 'invoice.settled');
      assert.equal(sanitized.invoiceId, 'inv-123');
      assert.equal(sanitized.amount, 500);

      // Verify sensitive fields stripped
      assert.equal((sanitized as any).internalDatabaseId, undefined);
      assert.equal((sanitized as any).sellerPrivateKey, undefined);
      assert.equal((sanitized as any).adminAuthToken, undefined);
      assert.equal((sanitized as any).dbConnectionString, undefined);
    });
  });

  describe('Exports boundary tests', () => {
    it('proves invoice export strictly adheres to EXPORT_FIELDS allowlist and strips internal data', () => {
      const mockInvoice: StoredInvoice = {
        id: 'inv-export-01',
        sellerPublicKey: 'GSELLER123',
        amount: 250,
        assetCode: 'XLM',
        memo: 'EXPMEMO',
        status: 'PAID',
        createdAt: new Date('2026-10-15T10:00:00Z'),
        updatedAt: new Date('2026-10-15T10:05:00Z'),
        version: 2,
        customerName: 'Secret Customer',
        customerEmail: 'secret@customer.com',
      } as any;

      const record = toExportRecord(mockInvoice);

      // Verify all emitted fields are explicitly in EXPORT_FIELDS
      for (const key of Object.keys(record)) {
        assert.ok(
          EXPORT_FIELDS.includes(key as any),
          `Exported field ${key} must be in EXPORT_FIELDS allowlist`
        );
      }

      // Verify private fields never leak into export record
      assert.equal((record as any).customerName, undefined);
      assert.equal((record as any).customerEmail, undefined);
      assert.equal((record as any).version, undefined);
      assert.equal((record as any).sellerPublicKey, undefined); // Scope metadata tracks owner, record stays minimal
    });

    it('proves multi-tenant export authorization prevents cross-wallet data exfiltration', async () => {
      const sellerA = 'GSELLER_A_11111111111111111111111111111111111111111111111111';
      const sellerB = 'GSELLER_B_22222222222222222222222222222222222222222222222222';

      const mockStorage: InvoiceStorage = {
        createInvoice: async () => ({} as any),
        getInvoiceById: async () => null,
        getInvoiceByMemo: async () => null,
        getInvoicesBySeller: async (seller) => {
          if (seller === sellerA) {
            return [
              {
                id: 'inv-A1',
                sellerPublicKey: sellerA,
                amount: 10,
                assetCode: 'XLM',
                memo: 'MEMOA',
                status: 'PAID',
                createdAt: new Date(),
                version: 1,
              } as any,
            ];
          }
          return [];
        },
        updateInvoiceStatus: async () => null,
        getAllInvoices: async () => [],
      };

      const exportService = new ExportService(mockStorage);

      // Seller A creates export
      const req: ExportRequest = { format: 'json' };
      const artifact = await exportService.create(sellerA, req);
      assert.ok(artifact.meta.exportId);

      // Seller A can fetch it
      const lookupA = exportService.get(sellerA, artifact.meta.exportId);
      assert.equal(lookupA.state, 'ok');

      // Seller B CANNOT fetch it — returns not_found without leaking existence
      const lookupB = exportService.get(sellerB, artifact.meta.exportId);
      assert.equal(lookupB.state, 'not_found');

      // Seller B cannot request export scoped to Seller A
      await assert.rejects(
        async () => {
          await exportService.create(sellerB, req, sellerA);
        },
        { name: 'ExportForbiddenError' }
      );
    });
  });
});
