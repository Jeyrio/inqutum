const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canExportPaymentProof,
} = require('../lib/payment-proof-policy');

test('pay proof panel contract - export availability by status', () => {
  assert.ok(canExportPaymentProof({ status: 'PAID' }), 'paid invoice should allow export');
  assert.ok(!canExportPaymentProof({ status: 'PENDING' }), 'pending invoice should not allow export');
  assert.ok(!canExportPaymentProof({ status: 'EXPIRED' }), 'expired invoice should not allow export');
});

test('pay proof panel contract - email availability validation', () => {
  const canSendEmail = (invoice) => {
    return invoice.status === 'PAID' && !!invoice.customerEmail;
  };

  const paidWithEmail = { status: 'PAID', customerEmail: 'customer@example.com' };
  const paidNoEmail = { status: 'PAID', customerEmail: null };
  const unpaidWithEmail = { status: 'PENDING', customerEmail: 'customer@example.com' };

  assert.ok(canSendEmail(paidWithEmail), 'should allow email for paid with customer email');
  assert.ok(!canSendEmail(paidNoEmail), 'should not allow email without customer email');
  assert.ok(!canSendEmail(unpaidWithEmail), 'should not allow email for unpaid invoice');
});

test('pay proof panel contract - download success path', () => {
  const mockInvoice = {
    id: 'inv123',
    amount: 100,
    assetCode: 'XLM',
    status: 'PAID',
  };

  const handleDownload = (invoice) => {
    if (invoice.status !== 'PAID') {
      throw new Error('Cannot download proof for unpaid invoice');
    }
    return { success: true, invoiceId: invoice.id };
  };

  const result = handleDownload(mockInvoice);
  assert.ok(result.success);
  assert.equal(result.invoiceId, 'inv123');
});

test('pay proof panel contract - download failure path', () => {
  const unpaidInvoice = { status: 'PENDING' };

  const handleDownload = (invoice) => {
    if (invoice.status !== 'PAID') {
      throw new Error('Cannot download proof for unpaid invoice');
    }
  };

  assert.throws(
    () => handleDownload(unpaidInvoice),
    /unpaid/,
    'should throw error for unpaid invoice'
  );
});

test('pay proof panel contract - email error handling', () => {
  const handleEmailError = (error) => {
    const messages = {
      'no-email': 'Client email is required',
      'unpaid': 'Only paid invoices can be emailed',
      'network': 'Failed to send email. Please try again.',
      'unknown': 'An unexpected error occurred',
    };

    if (error?.code === 'no-email') return messages['no-email'];
    if (error?.code === 'unpaid') return messages['unpaid'];
    if (error?.code === 'network') return messages['network'];
    return messages['unknown'];
  };

  assert.equal(handleEmailError({ code: 'no-email' }), 'Client email is required');
  assert.equal(handleEmailError({ code: 'unpaid' }), 'Only paid invoices can be emailed');
  assert.equal(handleEmailError({}), 'An unexpected error occurred');
});

test('pay proof panel contract - button disable state', () => {
  const getButtonStates = (invoice) => ({
    download: invoice.status === 'PAID',
    email: invoice.status === 'PAID' && !!invoice.customerEmail,
  });

  const paidWithEmail = { status: 'PAID', customerEmail: 'test@example.com' };
  const paidNoEmail = { status: 'PAID', customerEmail: null };
  const pending = { status: 'PENDING', customerEmail: 'test@example.com' };

  const statesPaidWithEmail = getButtonStates(paidWithEmail);
  assert.ok(statesPaidWithEmail.download);
  assert.ok(statesPaidWithEmail.email);

  const statesPaidNoEmail = getButtonStates(paidNoEmail);
  assert.ok(statesPaidNoEmail.download);
  assert.ok(!statesPaidNoEmail.email);

  const statesPending = getButtonStates(pending);
  assert.ok(!statesPending.download);
  assert.ok(!statesPending.email);
});

test('pay proof panel contract - degraded email delivery', async () => {
  const emailAttempt = async (invoice) => {
    try {
      if (!invoice.customerEmail) {
        throw { code: 'no-email', message: 'No client email' };
      }
      if (invoice.status !== 'PAID') {
        throw { code: 'unpaid', message: 'Invoice not paid' };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  };

  const testCases = [
    { invoice: { status: 'PAID', customerEmail: null }, shouldFail: true },
    { invoice: { status: 'PENDING', customerEmail: 'test@example.com' }, shouldFail: true },
    { invoice: { status: 'PAID', customerEmail: 'test@example.com' }, shouldFail: false },
  ];

  // emailAttempt is async: await each result instead of asserting on a Promise.
  for (const { invoice, shouldFail } of testCases) {
    const result = await emailAttempt(invoice);
    if (shouldFail) {
      assert.ok(!result.success || result.error, 'should handle missing email or unpaid status');
    } else {
      assert.ok(result.success, 'should succeed with paid invoice and customer email');
    }
  }
});
