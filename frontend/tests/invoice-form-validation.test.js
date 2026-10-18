const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInvoiceForm, firstInvalidField } = require('../lib/invoice-form-validation');

const valid = { amount: '10', sellerEmail: '', customerEmail: '' };

test('valid input has no errors', () => {
  assert.deepEqual(validateInvoiceForm(valid), {});
  assert.equal(firstInvalidField({}), null);
});

test('missing, zero and non-numeric amounts are rejected', () => {
  for (const amount of ['', '0', '-1', 'abc']) {
    assert.ok(validateInvoiceForm({ ...valid, amount }).amount, amount);
  }
});

test('optional emails are only checked when present', () => {
  const errors = validateInvoiceForm({ ...valid, sellerEmail: 'nope', customerEmail: 'a@b' });
  assert.ok(errors.sellerEmail);
  assert.ok(errors.customerEmail);
  assert.deepEqual(validateInvoiceForm({ ...valid, sellerEmail: ' me@x.io ' }), {});
});

test('focus goes to the first invalid field in form order', () => {
  assert.equal(firstInvalidField({ customerEmail: 'x', amount: 'y' }), 'amount');
  assert.equal(firstInvalidField({ customerEmail: 'x', sellerEmail: 'y' }), 'sellerEmail');
});
