import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  API_SECURITY_HEADERS,
  safeFrontendOrigin,
  safeHttpUrl,
  sanitizePlainText,
  securityHeaders,
} from '../src/security/content-safety.ts';
import { createInvoiceSchema } from '../src/utils/validation.ts';
import { checkPayerInfo } from '../src/services/payment-verification.ts';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';

const SELLER = 'G' + 'A'.repeat(55);

describe('Security hardening for untrusted content (Issue #54)', () => {
  describe('sanitizePlainText: XSS and HTML edge cases', () => {
    const cases: Array<[string, string]> = [
      ['<script>alert(1)</script>Design work', 'alert(1)Design work'],
      ['<img src=x onerror=alert(1)>Logo', 'Logo'],
      ['<svg/onload=alert(1)>', ''],
      ['<a href="javascript:alert(1)">click</a>', 'click'],
      ['<<script>script>alert(1)<</script>/script>', 'alert(1)'],
      // Nested tag fragments collapse to inert text: no `<` survives to re-form a tag.
      ['<scr<script>ipt>alert(1)</scr</script>ipt>', 'ipt>alert(1)ipt>'],
      ['<!-- hidden --><b>bold</b>', 'bold'],
      ['<!-- unterminated comment <script>', ''],
      ['<?php echo 1 ?>text', 'text'],
      ['<iframe src="//evil.example"></iframe>ok', 'ok'],
      ['<div onmouseover="x()"', ''],
      ['5 < 6 and 7 > 3', '5 < 6 and 7 > 3'],
      // `<` directly followed by a letter is treated as markup, even when unterminated.
      ['a<b', 'a'],
      ['a < b', 'a < b'],
      ['Tom & Jerry "quoted" \'single\'', 'Tom & Jerry "quoted" \'single\''],
    ];
    for (const [input, expected] of cases) {
      it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
        const out = sanitizePlainText(input);
        assert.equal(out, expected);
        assert.equal(/<\s*\/?\s*(script|img|svg|iframe|a)\b/i.test(out), false);
        assert.equal(/<[a-zA-Z\/!?]/.test(out), false, 'no tag start may survive');
      });
    }

    it('removes control, zero-width and BOM characters', () => {
      assert.equal(sanitizePlainText('a\u0000b\u0007c​d﻿e\u007Ff\u0085g'), 'abcdefg');
    });

    it('removes bidi override/isolate characters used to disguise text', () => {
      assert.equal(sanitizePlainText('invoice‮gpj.exe'), 'invoicegpj.exe');
      assert.equal(sanitizePlainText('⁦hidden⁩ ‏text؜'), 'hidden text');
    });

    it('normalises to NFC', () => {
      assert.equal(sanitizePlainText('é'), 'é');
    });

    it('collapses whitespace for single-line fields and preserves paragraphs for multiline', () => {
      assert.equal(sanitizePlainText('  a \n\t b  '), 'a b');
      assert.equal(sanitizePlainText('l1\r\nl2\n\n\n\nl3  x', { multiline: true }), 'l1\nl2\n\nl3 x');
    });

    it('returns an empty string for non-strings', () => {
      for (const v of [undefined, null, 42, {}, ['<b>']]) assert.equal(sanitizePlainText(v), '');
    });

    it('is idempotent and linear-time on hostile input', () => {
      const hostile = '<a'.repeat(50_000) + '<'.repeat(50_000);
      const started = Date.now();
      const once = sanitizePlainText(hostile);
      assert.ok(Date.now() - started < 1000, 'sanitizer must not backtrack');
      assert.equal(sanitizePlainText(once), once);
    });
  });

  describe('safeHttpUrl: protocol abuse and misleading links', () => {
    const rejected = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://example.com', 'blob:https://example.com/x',
      '//evil.example', '/relative/path', 'https://', 'not a url', '',
      'https://user:pass@example.com', 'https://trusted.example@evil.example',
      'https://exa mple.com', 'https://example.com/\nX-Injected: 1', 'https://example.com\\@evil.example',
      ' \t ', 'https://example.com/\u0000',
    ];
    for (const url of rejected) {
      it(`rejects ${JSON.stringify(url)}`, () => assert.equal(safeHttpUrl(url), null));
    }

    it('rejects non-strings', () => {
      for (const v of [undefined, null, 5, {}, ['https://a.example']]) assert.equal(safeHttpUrl(v), null);
    });

    it('accepts https, trims and normalises', () => {
      assert.equal(safeHttpUrl('  https://Example.com/path?q=1#h '), 'https://example.com/path?q=1#h');
    });

    it('accepts plain http only when explicitly allowed', () => {
      assert.equal(safeHttpUrl('http://localhost:3000'), null);
      assert.equal(safeHttpUrl('http://localhost:3000', { allowHttp: true }), 'http://localhost:3000/');
    });
  });

  describe('safeFrontendOrigin', () => {
    it('keeps only the validated origin', () => {
      assert.equal(safeFrontendOrigin('https://app.example.com/some/path?x=1'), 'https://app.example.com');
      assert.equal(safeFrontendOrigin('http://localhost:3000'), 'http://localhost:3000');
    });

    it('falls back for hostile or missing values', () => {
      for (const v of [undefined, '', 'javascript:alert(1)', 'https://u:p@evil.example', 'not a url']) {
        assert.equal(safeFrontendOrigin(v), 'http://localhost:3000');
      }
      assert.equal(safeFrontendOrigin('nope', 'https://fallback.example'), 'https://fallback.example');
    });
  });

  describe('invoice creation schema', () => {
    const base = { amount: 1, assetCode: 'XLM', sellerPublicKey: SELLER };

    it('strips markup from description, customer and seller names', () => {
      const parsed = createInvoiceSchema.parse({
        ...base,
        description: 'Logo <img src=x onerror=alert(1)>\nround 2',
        customerName: '<b>Acme</b> Ltd',
        sellerName: 'Studio‮ X',
      });
      assert.equal(parsed.description, 'Logo \nround 2');
      assert.equal(parsed.customerName, 'Acme Ltd');
      assert.equal(parsed.sellerName, 'Studio X');
    });

    it('drops fields that are empty after stripping and keeps clean text untouched', () => {
      const parsed = createInvoiceSchema.parse({ ...base, description: '<script></script>', customerName: '  ', sellerName: 'Fine & Co' });
      assert.equal(parsed.description, undefined);
      assert.equal(parsed.customerName, undefined);
      assert.equal(parsed.sellerName, 'Fine & Co');
    });

    it('still enforces length limits on the submitted value', () => {
      assert.throws(() => createInvoiceSchema.parse({ ...base, description: 'x'.repeat(501) }));
      assert.throws(() => createInvoiceSchema.parse({ ...base, customerName: 'x'.repeat(256) }));
    });

    it('rejects malformed emails that could carry markup or mailto injection', () => {
      for (const email of ['<script>@x.io', 'a@b.io?bcc=evil@x.io', 'a b@x.io', 'a@x.io\nBcc: e@x.io']) {
        assert.throws(() => createInvoiceSchema.parse({ ...base, customerEmail: email }), email);
      }
    });
  });

  describe('payer info on verification', () => {
    it('strips markup from payer names', () => {
      const r = checkPayerInfo({ payerName: '<img src=x onerror=1>Percy', payerEmail: 'percy@payer.example' });
      assert.deepEqual(r.ok && r.value, { payerName: 'Percy', payerEmail: 'percy@payer.example' });
    });

    it('treats a name that is only markup as absent, and absent fields as undefined', () => {
      assert.deepEqual(checkPayerInfo({ payerName: '<script></script>' }).ok && (checkPayerInfo({ payerName: '<script></script>' }) as any).value.payerName, undefined);
      assert.deepEqual((checkPayerInfo({}) as any).value, { payerName: undefined, payerEmail: undefined });
    });

    it('rejects payer emails with markup, quotes, query or whitespace injection', () => {
      for (const email of ['<script>@x.io', '"a"@x.io', 'a@x.io?bcc=e@x.io', 'a@x.io&x=1', 'a%0A@x.io', 'a@x', 'a b@x.io', '@x.io', 'a@.io']) {
        const r = checkPayerInfo({ payerEmail: email });
        assert.equal(r.ok, false, email);
        assert.equal(!r.ok && r.code, 'INVALID_PAYER_EMAIL');
      }
    });

    it('accepts ordinary emails', () => {
      for (const email of ['percy@payer.example', 'first.last+tag@sub.example.co.uk', 'a_b-c@x-y.io']) {
        assert.equal(checkPayerInfo({ payerEmail: email }).ok, true, email);
      }
    });

    it('still rejects non-string and over-long fields', () => {
      assert.equal((checkPayerInfo({ payerName: 5 }) as any).code, 'INVALID_PAYER_NAME');
      assert.equal((checkPayerInfo({ payerEmail: 5 }) as any).code, 'INVALID_PAYER_EMAIL');
      assert.equal((checkPayerInfo({ payerName: 'x'.repeat(256) }) as any).code, 'PAYER_INFO_TOO_LONG');
    });
  });

  describe('handlers', () => {
    let storage: MemoryInvoiceStorage;
    beforeEach(() => {
      memoryStorage.clear();
      storage = new MemoryInvoiceStorage();
    });

    const create = async (frontendUrl: string | undefined, body: Record<string, unknown>) => {
      const res: any = { statusCode: 200, body: undefined, status(c: number) { res.statusCode = c; return res; }, json(p: any) { res.body = p; return res; } };
      await createInvoiceHandlers({ storage, frontendUrl }).createInvoice({ body, params: {}, query: {} } as any, res);
      return res;
    };

    it('stores sanitised text end to end', async () => {
      const res = await create('http://localhost:3000', { amount: 3, assetCode: 'XLM', sellerPublicKey: SELLER, description: 'Hi <script>alert(1)</script>there', customerName: '<i>Zed</i>' });
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.data.invoice.description, 'Hi alert(1)there');
      assert.equal(res.body.data.invoice.customerName, 'Zed');
      const stored = await storage.getInvoiceById(res.body.data.invoice.id);
      assert.equal(JSON.stringify(stored).includes('<script'), false);
    });

    it('never builds payment links from a hostile FRONTEND_URL', async () => {
      const prior = process.env.FRONTEND_URL;
      try {
        process.env.FRONTEND_URL = 'javascript:alert(1)//';
        const res = await create(undefined, { amount: 3, assetCode: 'XLM', sellerPublicKey: SELLER });
        assert.match(res.body.data.paymentUrl, /^http:\/\/localhost:3000\/pay\//);
        const custom = await create('https://user:pw@evil.example/x', { amount: 3, assetCode: 'XLM', sellerPublicKey: SELLER });
        assert.match(custom.body.data.paymentUrl, /^http:\/\/localhost:3000\/pay\//);
        const good = await create('https://app.example.com/base', { amount: 3, assetCode: 'XLM', sellerPublicKey: SELLER });
        assert.match(good.body.data.paymentUrl, /^https:\/\/app\.example\.com\/pay\//);
      } finally {
        if (prior === undefined) delete process.env.FRONTEND_URL;
        else process.env.FRONTEND_URL = prior;
      }
    });
  });

  describe('security headers', () => {
    it('are set on every response and X-Powered-By is removed', async () => {
      const app = express();
      app.use(securityHeaders());
      app.get('/x', (_req, res) => res.json({ ok: true }));
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/x`);
        for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
          assert.equal(res.headers.get(name), value, name);
        }
        assert.equal(res.headers.get('x-powered-by'), null);
        assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
        assert.match(res.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      } finally {
        server.close();
      }
    });
  });
});
