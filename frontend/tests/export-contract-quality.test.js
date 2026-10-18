const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPaymentProofAvailable,
  canExportPaymentProof,
} = require('../lib/payment-proof-policy');
const {
  PRINT_DOCUMENT_CSP,
  buildMailtoUrl,
  csvCell,
  escapeHtml,
} = require('../lib/safe-content');

test('Issue #148: export contract enforces payment proof policy', () => {
  // Only PAID invoices can be exported as payment proofs
  assert.equal(canExportPaymentProof({ status: 'PAID' }), true);
  assert.equal(canExportPaymentProof({ status: 'PENDING' }), false);
  assert.equal(canExportPaymentProof({ status: 'EXPIRED' }), false);
  assert.equal(canExportPaymentProof(null), false);
  assert.equal(canExportPaymentProof(undefined), false);

  // Assertion throws informative error for unpayable exports
  assert.doesNotThrow(() => assertPaymentProofAvailable({ status: 'PAID' }));
  assert.throws(
    () => assertPaymentProofAvailable({ status: 'PENDING' }),
    /Payment proof is available only after the invoice is paid/
  );
  assert.throws(
    () => assertPaymentProofAvailable(null),
    /Payment proof is available only after the invoice is paid/
  );
});

test('Issue #148: CSV export sanitizes formula injection characters', () => {
  const formulaPayloads = [
    '=CMD|"/C calc"!A0',
    '+123456789',
    '-SUM(1+1)',
    '@HYPERLINK("http://evil.com")',
    '\tDDE("cmd")',
    '\rcalc',
  ];

  for (const payload of formulaPayloads) {
    const cell = csvCell(payload);
    // Must be quoted and prefixed with apostrophe to neutralize in Excel/Sheets
    assert.match(cell, /^"'/);
  }
});

test('Issue #148: CSV export handles null, undefined, and numeric cells safely', () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(100.5), '"100.5"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell('regular text'), '"regular text"');
  assert.equal(csvCell('contains "quotes"'), '"contains ""quotes"""');
});

test('Issue #148: HTML export escapes malicious tags and script vectors', () => {
  const xssPayload = '<script>alert("xss")</script>';
  const escaped = escapeHtml(xssPayload);
  assert.equal(escaped.includes('<script>'), false);
  assert.equal(escaped.includes('</script>'), false);
  assert.equal(
    escaped,
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
  );
});

test('Issue #148: printable document enforces restrictive CSP', () => {
  assert.ok(PRINT_DOCUMENT_CSP);
  assert.match(PRINT_DOCUMENT_CSP, /default-src 'none'/);
  assert.match(PRINT_DOCUMENT_CSP, /style-src 'unsafe-inline'/);
});

test('Issue #148: mailto link generation validates recipient and constructs query', () => {
  const validLink = buildMailtoUrl(
    'client@example.com',
    'Invoice #INV123',
    'Here is your invoice link.'
  );
  assert.ok(validLink);
  assert.match(validLink, /^mailto:client@example\.com\?/);
  assert.match(validLink, /subject=Invoice%20%23INV123/);

  // Invalid email rejects link creation
  const invalidLink = buildMailtoUrl('not-an-email', 'Subject', 'Body');
  assert.equal(invalidLink, null);
});

test('Issue #28: deterministic proof regeneration produces identical payment facts across downloads', () => {
  const { generateInvoicePDF } = require('../lib/export');
  const paidInvoice = {
    id: '12345678-abcd-1234-abcd-1234567890ab',
    amount: 150.75,
    assetCode: 'XLM',
    status: 'PAID',
    createdAt: '2026-01-01T10:00:00.000Z',
    expiresAt: '2026-01-08T10:00:00.000Z',
    paidAt: '2026-01-02T14:30:00.000Z',
    memo: 'MEMO-STABLE-123',
    sellerPublicKey: 'G' + 'A'.repeat(55),
    payerPublicKey: 'G' + 'B'.repeat(55),
    paymentTxHash: 'a'.repeat(64),
    customerName: 'Alice',
  };

  const html1 = generateInvoicePDF(paidInvoice);
  const html2 = generateInvoicePDF(paidInvoice);

  // Core immutable payment facts must be present in both render outputs
  for (const html of [html1, html2]) {
    assert.match(html, /MEMO-STABLE-123/);
    assert.match(html, /150\.75/);
    assert.match(html, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(html, /Verified At/);
    assert.match(html, /Document Downloaded At/);
  }
});

test('Issue #26: tamper-evident payment proof includes live verification endpoint link and tx hash', () => {
  const { generateInvoicePDF } = require('../lib/export');
  const paidInvoice = {
    id: '87654321-abcd-1234-abcd-1234567890ab',
    amount: 50.0,
    assetCode: 'XLM',
    status: 'PAID',
    createdAt: '2026-01-01T10:00:00.000Z',
    expiresAt: '2026-01-08T10:00:00.000Z',
    paidAt: '2026-01-02T14:30:00.000Z',
    memo: 'MEMO-REVERIFY-999',
    sellerPublicKey: 'G' + 'C'.repeat(55),
    payerPublicKey: 'G' + 'D'.repeat(55),
    paymentTxHash: 'b'.repeat(64),
  };

  const html = generateInvoicePDF(paidInvoice);

  // Must include prominent transaction hash and live re-verification link
  assert.match(html, /Verified Transaction Hash/);
  assert.match(html, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(html, /\/pay\/87654321-abcd-1234-abcd-1234567890ab/);
  assert.match(html, /Verified Settlement Record/);
});
