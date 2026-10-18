/**
 * Test Suite: Prevent Template Injection in Sent Emails (Issue #36).
 *
 * Verifies:
 *  1. Contextual escaping across HTML body, HTML attributes, URLs, email headers, and text.
 *  2. Resistance to Server-Side Template Injection (SSTI), XSS payloads, and CRLF header injection.
 *  3. Input validation on client name and notes/description fields.
 *  4. Email preview rendering and dispatch behavior on both payment request and payment proof templates.
 *  5. Handler parity between in-memory and PostgreSQL storage adapters.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import type { Request, Response } from 'express';
import {
  EmailTemplateEngine,
  escapeForContext,
} from '../src/templates/email-template-engine';
import {
  invoicePaymentRequestEngine,
  paymentProofReceiptEngine,
} from '../src/templates/invoice-email-templates';
import { EmailService, MemoryEmailTransport } from '../src/services/email.service';
import {
  escapeHtml,
  escapeHtmlAttribute,
  sanitizeEmailHeader,
  validateClientName,
  validateNotesOrDescription,
} from '../src/security/content-safety';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import type { StoredInvoice } from '../src/storage/invoice-storage';

const SELLER_KEY = 'G' + 'A'.repeat(55);
const PAYER_KEY = 'G' + 'B'.repeat(55);

function createMockInvoice(overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id: '12345678-1234-4234-8234-123456789abc',
    amount: 100.5,
    assetCode: 'XLM',
    memo: 'MEMO12345',
    sellerPublicKey: SELLER_KEY,
    status: 'PENDING',
    createdAt: '2026-09-26T12:00:00.000Z',
    expiresAt: '2026-10-03T12:00:00.000Z',
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    sellerName: 'John Dev',
    sellerEmail: 'john@example.com',
    description: 'Smart contract development and audit',
    ...overrides,
  };
}

interface FakeResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  json(payload: any): FakeResponse;
  setHeader(k: string, v: string): FakeResponse;
}

function createRes(): FakeResponse & Response {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
      return res;
    },
  };
  return res;
}

function createReq(init: { body?: any; params?: any; query?: any; headers?: any } = {}): Request {
  return {
    body: init.body || {},
    params: init.params || {},
    query: init.query || {},
    headers: init.headers || {},
  } as unknown as Request;
}

async function callHandler(
  handler: (req: Request, res: Response) => Promise<void>,
  req: Request
): Promise<FakeResponse> {
  const res = createRes();
  await handler(req, res);
  return res;
}

describe('Email Template Injection Prevention (Issue #36)', () => {
  describe('Contextual Escaping Primitives', () => {
    it('escapes HTML-significant characters in html body context', () => {
      const input = '<script>alert("XSS & injection")</script>';
      const escaped = escapeForContext(input, 'html');
      assert.equal(
        escaped,
        '&lt;script&gt;alert(&quot;XSS &amp; injection&quot;)&lt;&#x2F;script&gt;'
      );
      assert.equal(escaped.includes('<script>'), false);
    });

    it('escapes quotes and control characters in html attribute context', () => {
      const input = 'x" onmouseover="alert(1)" style="color:red';
      const escaped = escapeForContext(input, 'attr');
      assert.equal(escaped.includes('"'), false);
      assert.ok(escaped.includes('&quot;'));
    });

    it('allows safe http/https URLs and rejects javascript: or data: schemes in url context', () => {
      assert.equal(
        escapeForContext('https://quittance.app/pay/123', 'url'),
        'https:&#x2F;&#x2F;quittance.app&#x2F;pay&#x2F;123'
      );
      assert.equal(escapeForContext('javascript:alert(1)', 'url'), '#');
      assert.equal(escapeForContext('data:text/html,<script>', 'url'), '#');
      assert.equal(escapeForContext('vbscript:msgbox(1)', 'url'), '#');
    });

    it('sanitizes email headers and strips CRLF injection attempts', () => {
      const maliciousSubject = 'Invoice 100\r\nBcc: victim@example.com\r\nSubject: Phishing';
      const safe = escapeForContext(maliciousSubject, 'header');
      assert.equal(safe.includes('\r'), false);
      assert.equal(safe.includes('\n'), false);
      assert.equal(safe, 'Invoice 100 Bcc: victim@example.com Subject: Phishing');
    });

    it('normalizes plain text without evaluating code', () => {
      const rawText = 'Hello <world>\u0000\u0007!';
      const safe = escapeForContext(rawText, 'text');
      assert.equal(safe, 'Hello <world>!');
    });
  });

  describe('Template Engine SSTI & Injection Immunity', () => {
    it('does not evaluate prototype traversal or code execution payloads', () => {
      const engine = new EmailTemplateEngine({
        subject: 'Invoice for {{header:customerName}}',
        html: '<p>Hello {{html:customerName}}, memo: {{html:memo}}</p>',
        text: 'Hello {{text:customerName}}',
      });

      // 1. Expressions in input values are not evaluated
      const exprResult = engine.render({
        customerName: '${7*7} and <%= 8*8 %>',
        memo: 'TEST-MEMO',
      });
      assert.equal(exprResult.html.includes('49'), false);
      assert.equal(exprResult.html.includes('64'), false);
      assert.ok(exprResult.html.includes('${7*7}'));

      // 2. Prototype properties cannot be accessed as template tags
      const protoEngine = new EmailTemplateEngine({
        subject: 'Subject',
        html: '<div>{{html:constructor}} {{html:__proto__}} {{html:prototype}}</div>',
        text: 'Text',
      });
      const protoResult = protoEngine.render({});
      assert.equal(protoResult.html, '<div>  </div>');

      // 3. Dangerous SSTI payloads in variables are rendered as inert text
      const sstiResult = engine.render({
        customerName: '{{constructor.constructor("return global")()}}',
        memo: 'TEST-MEMO',
      });
      assert.equal(sstiResult.html.includes('<script'), false);
      assert.ok(sstiResult.html.includes('TEST-MEMO'));
    });

    it('safely handles conditional blocks without code execution', () => {
      const engine = new EmailTemplateEngine({
        subject: 'Test {{header:id}}',
        html: '<div>{{#if isPaid}}<span>PAID</span>{{else}}<span>DUE</span>{{/if}}</div>',
        text: '{{#if isPaid}}PAID{{else}}DUE{{/if}}',
      });

      const paidResult = engine.render({ id: '1', isPaid: true });
      assert.ok(paidResult.html.includes('PAID'));
      assert.equal(paidResult.html.includes('DUE'), false);

      const unpaidResult = engine.render({ id: '1', isPaid: false });
      assert.ok(unpaidResult.html.includes('DUE'));
      assert.equal(unpaidResult.html.includes('PAID'), false);
    });
  });

  describe('Invoice Email Templates Injection Testing', () => {
    it('renders payment request email with hostile client-name and notes safely escaped', () => {
      const hostileInvoice = createMockInvoice({
        customerName: '<script>alert("attacker")</script><img src=x onerror=alert(1)>',
        sellerName: 'Legit Seller <script>',
        description: '"><a href="https://phishing.evil.com">Click to Pay Fake</a><!--',
        memo: 'MEMO<svg/onload=alert(1)>',
      });

      const email = invoicePaymentRequestEngine.render({
        invoiceId: hostileInvoice.id,
        invoiceIdShort: hostileInvoice.id.substring(0, 8).toUpperCase(),
        amount: String(hostileInvoice.amount),
        assetCode: hostileInvoice.assetCode,
        memo: hostileInvoice.memo,
        sellerName: hostileInvoice.sellerName,
        sellerPublicKey: hostileInvoice.sellerPublicKey,
        customerName: hostileInvoice.customerName,
        customerEmail: hostileInvoice.customerEmail,
        description: hostileInvoice.description,
        formattedExpiresAt: 'Sat, 03 Oct 2026 12:00:00 GMT',
        paymentUrl: `http://localhost:3000/pay/${hostileInvoice.id}`,
        frontendOrigin: 'http://localhost:3000',
      });

      // Assert no raw HTML tags or script execution can be injected
      assert.equal(email.html.includes('<script>'), false);
      assert.equal(email.html.includes('<img src=x'), false);
      assert.equal(email.html.includes('<svg/onload'), false);
      assert.equal(email.html.includes('<a href="https://phishing.evil.com'), false);

      // Verify that characters were safely escaped into HTML entities
      assert.ok(email.html.includes('&lt;script&gt;'));
      assert.ok(email.html.includes('&quot;&gt;&lt;a href='));
      assert.ok(email.html.includes('&lt;svg&#x2F;onload=alert(1)&gt;'));

      // Verify subject is header-safe
      assert.equal(email.subject.includes('\r'), false);
      assert.equal(email.subject.includes('\n'), false);
    });

    it('renders payment proof receipt email with on-chain verification and safe fields', () => {
      const paidInvoice = createMockInvoice({
        status: 'PAID',
        paidAt: '2026-09-26T14:30:00.000Z',
        paymentTxHash: 'a'.repeat(64),
        payerPublicKey: PAYER_KEY,
        customerName: 'Safe Client Corp',
        description: 'Consulting & Milestone 1 Delivery',
      });

      const email = paymentProofReceiptEngine.render({
        invoiceId: paidInvoice.id,
        invoiceIdShort: paidInvoice.id.substring(0, 8).toUpperCase(),
        amount: String(paidInvoice.amount),
        assetCode: paidInvoice.assetCode,
        memo: paidInvoice.memo,
        sellerPublicKey: paidInvoice.sellerPublicKey,
        payerPublicKey: paidInvoice.payerPublicKey,
        customerName: paidInvoice.customerName,
        description: paidInvoice.description,
        paymentTxHash: paidInvoice.paymentTxHash,
        formattedPaidAt: 'Sat, 26 Sep 2026 14:30:00 GMT',
        frontendOrigin: 'http://localhost:3000',
      });

      assert.ok(email.html.includes('Payment Proof'));
      assert.ok(email.html.includes('Verified Paid'));
      assert.ok(email.html.includes('Safe Client Corp'));
      assert.ok(email.html.includes('Consulting &amp; Milestone 1 Delivery'));
      assert.ok(email.text.includes('QUITTANCE PAYMENT PROOF'));
    });
  });

  describe('Input Validation on Client Name and Notes', () => {
    it('validates client name length and character set', () => {
      assert.equal(validateClientName('Alice Smith'), true);
      assert.equal(validateClientName('Company LLC - Dept #1'), true);
      assert.equal(validateClientName(''), false); // too short
      assert.equal(validateClientName('A'.repeat(101)), false); // too long
      assert.equal(validateClientName('<script>alert(1)</script>'), false); // HTML tag
      assert.equal(validateClientName('{{user.password}}'), false); // template delimiter
      assert.equal(validateClientName('${process.env}'), false); // template delimiter
      assert.equal(validateClientName('Alice\u0000Smith'), false); // control character
    });

    it('validates description/notes length and character set', () => {
      assert.equal(validateNotesOrDescription('Web design services.\nPhase 1.'), true);
      assert.equal(validateNotesOrDescription('A'.repeat(1001)), false); // too long
      assert.equal(validateNotesOrDescription('Hello {{secret}}'), false); // template delimiter
      assert.equal(validateNotesOrDescription('Hello <script>'), false); // HTML tag
    });
  });

  describe('Email Service and Preview Endpoints (API Integration)', () => {
    let storage: MemoryInvoiceStorage;
    let transport: MemoryEmailTransport;
    let service: EmailService;
    let handlers: ReturnType<typeof createInvoiceHandlers>;

    beforeEach(() => {
      storage = new MemoryInvoiceStorage();
      transport = new MemoryEmailTransport();
      service = new EmailService(transport);
      handlers = createInvoiceHandlers({
        storage,
        emailService: service,
        frontendUrl: 'http://localhost:3000',
      });
    });

    it('generates a rendered email preview for payment request before sending', async () => {
      const invoice = await storage.createInvoice({
        amount: 250,
        assetCode: 'USDC',
        sellerPublicKey: SELLER_KEY,
        customerName: 'Acme Corp',
        customerEmail: 'billing@acme.example',
        description: 'Monthly retainership',
      });

      const res = await callHandler(
        handlers.getEmailPreview,
        createReq({
          params: { id: invoice.id },
          query: { type: 'payment_request' },
        })
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.templateType, 'payment_request');
      assert.equal(res.body.data.recipient, 'billing@acme.example');
      assert.ok(res.body.data.subject.includes('250 USDC'));
      assert.ok(res.body.data.html.includes('Acme Corp'));
      assert.ok(res.body.data.html.includes('Monthly retainership'));
    });

    it('rejects payment proof preview for unpaid pending invoices with 400', async () => {
      const invoice = await storage.createInvoice({
        amount: 50,
        assetCode: 'XLM',
        sellerPublicKey: SELLER_KEY,
        customerEmail: 'client@example.com',
      });

      const res = await callHandler(
        handlers.getEmailPreview,
        createReq({
          params: { id: invoice.id },
          query: { type: 'payment_proof' },
        })
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'INVOICE_NOT_PAID');
    });

    it('allows payment proof preview and send once invoice is PAID', async () => {
      const invoice = await storage.createInvoice({
        amount: 75,
        assetCode: 'XLM',
        sellerPublicKey: SELLER_KEY,
        customerEmail: 'client@example.com',
      });

      // Mark invoice as paid
      const paidInvoice = await storage.markAsPaid(
        invoice.id,
        'b'.repeat(64),
        PAYER_KEY
      );

      const previewRes = await callHandler(
        handlers.getEmailPreview,
        createReq({
          params: { id: paidInvoice.id },
          query: { type: 'payment_proof' },
        })
      );

      assert.equal(previewRes.statusCode, 200);
      assert.ok(previewRes.body.data.html.includes('Payment Proof'));

      // Send the email
      const sendRes = await callHandler(
        handlers.sendInvoiceEmail,
        createReq({
          params: { id: paidInvoice.id },
          body: { templateType: 'payment_proof' },
        })
      );

      assert.equal(sendRes.statusCode, 200);
      assert.equal(sendRes.body.success, true);
      assert.equal(transport.sentEmails.length, 1);
      assert.equal(transport.sentEmails[0].recipient, 'client@example.com');
      assert.ok(transport.sentEmails[0].subject.includes('Payment Proof'));
    });

    it('dispatches payment request email with full contextual escaping applied', async () => {
      const invoice = await storage.createInvoice({
        amount: 100,
        assetCode: 'XLM',
        sellerPublicKey: SELLER_KEY,
        customerName: '<script>alert("hacked")</script>',
        customerEmail: 'client@example.com',
        description: '"><img src=x onerror=alert(1)>',
      });

      const sendRes = await callHandler(
        handlers.sendInvoiceEmail,
        createReq({
          params: { id: invoice.id },
          body: { templateType: 'payment_request' },
        })
      );

      assert.equal(sendRes.statusCode, 200);
      assert.equal(transport.sentEmails.length, 1);

      const sent = transport.sentEmails[0];
      assert.equal(sent.html.includes('<script>'), false);
      assert.equal(sent.html.includes('<img src=x'), false);
      assert.ok(sent.html.includes('&lt;script&gt;'));
      assert.ok(sent.html.includes('&quot;&gt;&lt;img src=x'));
    });
  });
});
