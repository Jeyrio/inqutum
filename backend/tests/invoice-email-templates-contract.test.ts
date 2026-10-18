import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  invoicePaymentRequestEngine,
  paymentProofReceiptEngine,
} from '../src/templates/invoice-email-templates.ts';

describe('invoice email template contract', () => {
  it('renders with optional fields absent and safely blanks missing values', () => {
    const paymentRequest = invoicePaymentRequestEngine.render({});
    const paymentProof = paymentProofReceiptEngine.render({});

    for (const rendered of [paymentRequest, paymentProof]) {
      assert.equal(typeof rendered.subject, 'string');
      assert.equal(typeof rendered.html, 'string');
      assert.equal(typeof rendered.text, 'string');
      assert.equal(rendered.html.includes('{{'), false);
      assert.equal(rendered.text.includes('{{'), false);
    }
    assert.equal(paymentRequest.recipient, undefined);
    assert.equal(paymentProof.recipient, undefined);
  });

  it('does not retain data between renders and degrades unsafe URLs to a safe placeholder', () => {
    const first = invoicePaymentRequestEngine.render({
      invoiceIdShort: 'FIRST-123',
      sellerName: '<script>first</script>',
      paymentUrl: 'javascript:alert(1)',
    });
    const second = invoicePaymentRequestEngine.render({
      invoiceIdShort: 'SECOND-456',
      sellerName: 'Safe Seller',
      paymentUrl: 'https://example.test/pay',
    });

    assert.ok(first.html.includes('&lt;script&gt;first&lt;&#x2F;script&gt;'));
    assert.ok(first.html.includes('href="#"'));
    assert.equal(second.html.includes('FIRST-123'), false);
    assert.ok(second.html.includes('SECOND-456'));
    assert.ok(second.html.includes('Safe Seller'));
    assert.ok(second.html.includes('href="https:&#x2F;&#x2F;example.test&#x2F;pay"'));
  });
});
