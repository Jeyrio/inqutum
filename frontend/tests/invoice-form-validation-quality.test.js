const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInvoiceForm,
  firstInvalidField,
  MAX_INVOICE_AMOUNT,
  MAX_DECIMAL_PLACES,
} = require('../lib/invoice-form-validation');

test('Issue #149: validateInvoiceForm accepts valid inputs', () => {
  const valid = {
    amount: '125.50',
    sellerEmail: 'seller@example.com',
    customerEmail: 'customer@domain.org',
  };
  assert.deepEqual(validateInvoiceForm(valid), {});
  assert.equal(firstInvalidField({}), null);

  // Optional emails left blank or undefined
  assert.deepEqual(validateInvoiceForm({ amount: 10 }), {});
  assert.deepEqual(validateInvoiceForm({ amount: '0.0000001' }), {});
});

test('Issue #149: validateInvoiceForm rejects invalid amounts', () => {
  const invalidAmounts = [
    null,
    undefined,
    '',
    '   ',
    '0',
    '-1',
    'abc',
    '12.34.56',
    '0.0000',
    'NaN',
    'Infinity',
    '-Infinity',
  ];

  for (const amt of invalidAmounts) {
    const res = validateInvoiceForm({ amount: amt });
    assert.equal(res.amount, 'Enter an amount greater than 0.');
    assert.equal(firstInvalidField(res), 'amount');
  }
});

test('Issue #149: validateInvoiceForm enforces decimal precision boundary', () => {
  // Max decimals allowed is 7 (Stellar lumens / assets precision)
  const valid7Decimals = '10.1234567';
  assert.deepEqual(validateInvoiceForm({ amount: valid7Decimals }), {});

  const invalid8Decimals = '10.12345678';
  const res = validateInvoiceForm({ amount: invalid8Decimals });
  assert.equal(
    res.amount,
    `Amount cannot have more than ${MAX_DECIMAL_PLACES} decimal places.`
  );
});

test('Issue #149: validateInvoiceForm enforces maximum amount cap', () => {
  const atMax = validateInvoiceForm({ amount: MAX_INVOICE_AMOUNT });
  assert.deepEqual(atMax, {});

  const overMax = validateInvoiceForm({ amount: MAX_INVOICE_AMOUNT + 1 });
  assert.equal(overMax.amount, 'Amount exceeds maximum allowed limit.');
});

test('Issue #149: validateInvoiceForm validates seller and customer emails', () => {
  const badEmails = [
    'plainaddress',
    'missing@domain',
    '@missinguser.com',
    'spaces in@email.com',
    'a'.repeat(250) + '@example.com', // Exceeds 254 chars
  ];

  for (const email of badEmails) {
    const resSeller = validateInvoiceForm({ amount: '10', sellerEmail: email });
    assert.equal(
      resSeller.sellerEmail,
      'Enter a valid email address, like you@example.com.'
    );

    const resCustomer = validateInvoiceForm({ amount: '10', customerEmail: email });
    assert.equal(
      resCustomer.customerEmail,
      'Enter a valid client email address, like client@example.com.'
    );
  }
});

test('Issue #149: firstInvalidField preserves form tab order', () => {
  const allErrors = {
    customerEmail: 'Invalid customer email',
    amount: 'Invalid amount',
    sellerEmail: 'Invalid seller email',
  };
  // Should report amount first, then sellerEmail, then customerEmail
  assert.equal(firstInvalidField(allErrors), 'amount');

  delete allErrors.amount;
  assert.equal(firstInvalidField(allErrors), 'sellerEmail');

  delete allErrors.sellerEmail;
  assert.equal(firstInvalidField(allErrors), 'customerEmail');

  delete allErrors.customerEmail;
  assert.equal(firstInvalidField(allErrors), null);
});
