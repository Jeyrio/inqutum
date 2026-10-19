const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPaymentProofAvailable,
  canExportPaymentProof,
} = require('../lib/payment-proof-policy');

test('only a paid invoice can produce a payment proof', () => {
  assert.equal(canExportPaymentProof({ status: 'PAID' }), true);
  assert.equal(canExportPaymentProof({ status: 'PENDING' }), false);
  assert.equal(canExportPaymentProof({ status: 'EXPIRED' }), false);
});

test('unpaid expired invoices cannot download or email proof', () => {
  assert.throws(
    () => assertPaymentProofAvailable({ status: 'EXPIRED' }),
    /expired unpaid/
  );
});

test('paid proof remains available', () => {
  assert.doesNotThrow(() => assertPaymentProofAvailable({ status: 'PAID' }));
});

// ── Hardened edge cases (issue #177) ─────────────────────────────────────────

test('null, undefined, and non-object invoices fail closed', () => {
  assert.equal(canExportPaymentProof(null), false);
  assert.equal(canExportPaymentProof(undefined), false);
  assert.equal(canExportPaymentProof('PAID'), false);
  assert.equal(canExportPaymentProof(42), false);
  assert.equal(canExportPaymentProof(true), false);
  assert.throws(() => assertPaymentProofAvailable(null), /only after the invoice is paid/);
  assert.throws(() => assertPaymentProofAvailable(undefined), /only after the invoice is paid/);
});

test('missing or non-string status fails closed', () => {
  assert.equal(canExportPaymentProof({}), false);
  assert.equal(canExportPaymentProof({ status: null }), false);
  assert.equal(canExportPaymentProof({ status: 123 }), false);
  assert.equal(canExportPaymentProof({ status: '' }), false);
});

test('status comparison is case-insensitive and trims whitespace', () => {
  assert.equal(canExportPaymentProof({ status: 'paid' }), true);
  assert.equal(canExportPaymentProof({ status: 'PAID' }), true);
  assert.equal(canExportPaymentProof({ status: 'Paid' }), true);
  assert.equal(canExportPaymentProof({ status: ' PAID ' }), true);
  assert.equal(canExportPaymentProof({ status: 'expired' }), false);
  assert.equal(canExportPaymentProof({ status: ' pending ' }), false);
});

test('expired error message is case-insensitive', () => {
  assert.throws(() => assertPaymentProofAvailable({ status: 'expired' }), /expired unpaid/);
  assert.throws(() => assertPaymentProofAvailable({ status: 'Expired' }), /expired unpaid/);
});
