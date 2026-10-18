const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePayAmountViewModel } = require('../lib/pay-amount-block-contract');

test('resolves active pending invoice with countdown and "Amount to Pay"', () => {
  const future = new Date(Date.now() + 3600 * 1000 * 24).toISOString();
  const invoice = {
    id: 'inv-1',
    amount: 15.5,
    assetCode: 'xlm',
    status: 'PENDING',
    expiresAt: future,
    description: '  Web Development Services  ',
    sellerName: '  Alice Corp  ',
    sellerEmail: '  alice@corp.com  ',
  };

  const vm = resolvePayAmountViewModel(invoice);
  assert.equal(vm.isValid, true);
  assert.equal(vm.expired, false);
  assert.equal(vm.status, 'PENDING');
  assert.equal(vm.headerLabel, 'Amount to Pay');
  assert.equal(vm.formattedAmount, '15.5000000');
  assert.equal(vm.assetCode, 'XLM');
  assert.equal(vm.description, 'Web Development Services');
  assert.equal(vm.sellerName, 'Alice Corp');
  assert.equal(vm.sellerEmail, 'alice@corp.com');
  assert.equal(vm.hasSellerInfo, true);
  assert.ok(vm.expiryRemaining);
  assert.equal(vm.formattedPaidAt, null);
});

test('resolves expired invoice status to "Invoice Amount" without countdown', () => {
  const invoice = {
    id: 'inv-2',
    amount: '100',
    assetCode: 'USDC',
    status: 'EXPIRED',
    expiresAt: '2020-01-01T00:00:00.000Z',
  };

  const vm = resolvePayAmountViewModel(invoice);
  assert.equal(vm.isValid, true);
  assert.equal(vm.expired, true);
  assert.equal(vm.headerLabel, 'Invoice Amount');
  assert.equal(vm.expiryRemaining, null);
  assert.equal(vm.formattedAmount, '100.0000000');
});

test('stale pending invoice past expiresAt fails closed to "Invoice Amount"', () => {
  const invoice = {
    id: 'inv-3',
    amount: 50,
    assetCode: 'XLM',
    status: 'PENDING',
    expiresAt: '2020-01-01T00:00:00.000Z',
  };

  const vm = resolvePayAmountViewModel(invoice, '2026-08-30T12:00:00.000Z');
  assert.equal(vm.isValid, true);
  assert.equal(vm.expired, true);
  assert.equal(vm.headerLabel, 'Invoice Amount');
  assert.equal(vm.expiryRemaining, null);
});

test('resolves paid invoice with formatted completion date and txHash', () => {
  const invoice = {
    id: 'inv-4',
    amount: 42,
    assetCode: 'XLM',
    status: 'PAID',
    paidAt: '2026-06-15T14:30:00.000Z',
    paymentTxHash: 'e'.repeat(64),
  };

  const vm = resolvePayAmountViewModel(invoice);
  assert.equal(vm.isValid, true);
  assert.equal(vm.isPaid, true);
  assert.equal(vm.paymentTxHash, 'e'.repeat(64));
  assert.ok(vm.formattedPaidAt);
  assert.equal(vm.expiryRemaining, null);
});

test('degrades gracefully for missing or nullish invoice without throwing', () => {
  for (const empty of [null, undefined, '', 123]) {
    const vm = resolvePayAmountViewModel(empty);
    assert.equal(vm.isValid, false);
    assert.equal(vm.formattedAmount, '0.0000000');
    assert.equal(vm.assetCode, 'XLM');
    assert.equal(vm.hasSellerInfo, false);
  }
});

test('handles malformed amount safely', () => {
  for (const amt of ['not-a-number', -10, NaN, null, undefined]) {
    const vm = resolvePayAmountViewModel({
      id: 'inv-5',
      amount: amt,
      status: 'PENDING',
    });
    assert.equal(vm.isValid, true);
    assert.equal(vm.formattedAmount, '0.0000000');
  }
});

test('trims whitespace-only description and seller details', () => {
  const invoice = {
    id: 'inv-6',
    amount: 10,
    status: 'PENDING',
    description: '   ',
    sellerName: '   ',
    sellerEmail: '   ',
  };

  const vm = resolvePayAmountViewModel(invoice);
  assert.equal(vm.description, null);
  assert.equal(vm.sellerName, null);
  assert.equal(vm.sellerEmail, null);
  assert.equal(vm.hasSellerInfo, false);
});

test('handles invalid paidAt and expiresAt date strings safely', () => {
  const invoice = {
    id: 'inv-7',
    amount: 10,
    status: 'PAID',
    paidAt: 'not-a-valid-date',
    expiresAt: 'not-a-valid-date',
  };

  const vm = resolvePayAmountViewModel(invoice);
  assert.equal(vm.isValid, true);
  assert.equal(vm.formattedPaidAt, null);
});
