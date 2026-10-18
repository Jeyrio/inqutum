const test = require('node:test');
const assert = require('node:assert/strict');
const {
  expiryTimestamp,
  hasInvoiceExpired,
  effectiveInvoiceStatus,
  applyExpiryStatus,
  applyExpiryLifecycle,
  isActionableInvoice,
} = require('../lib/invoice-lifecycle');

const BASE_TIME = 1756555200000;
const ISO_STR = new Date(BASE_TIME).toISOString();

test('Issue #150: expiryTimestamp parsing and normalization', () => {
  // ISO-8601 string
  assert.equal(expiryTimestamp(ISO_STR), BASE_TIME);

  // Date instance
  assert.equal(expiryTimestamp(new Date(BASE_TIME)), BASE_TIME);

  // 13-digit milliseconds
  assert.equal(expiryTimestamp(BASE_TIME), BASE_TIME);

  // 10-digit epoch seconds
  const seconds = Math.floor(BASE_TIME / 1000);
  assert.equal(expiryTimestamp(seconds), seconds * 1000);

  // Corrupted and edge case inputs
  assert.equal(expiryTimestamp(null), null);
  assert.equal(expiryTimestamp(undefined), null);
  assert.equal(expiryTimestamp(''), null);
  assert.equal(expiryTimestamp('not-a-date'), null);
  assert.equal(expiryTimestamp(-500), null);
  assert.equal(expiryTimestamp(NaN), null);
});

test('Issue #150: hasInvoiceExpired status precedence and boundary behavior', () => {
  // Explicit EXPIRED status always expires
  assert.equal(hasInvoiceExpired({ status: 'EXPIRED' }), true);

  // PAID status never expires, even with past expiry
  const paidInvoice = {
    status: 'PAID',
    expiresAt: new Date(BASE_TIME - 10000).toISOString(),
  };
  assert.equal(hasInvoiceExpired(paidInvoice, BASE_TIME), false);

  // CANCELLED status never expires
  assert.equal(hasInvoiceExpired({ status: 'CANCELLED', expiresAt: ISO_STR }, BASE_TIME), false);

  // PENDING invoice boundary checks
  const pendingInvoice = {
    status: 'PENDING',
    expiresAt: ISO_STR,
  };

  // Past boundary -> expired
  assert.equal(hasInvoiceExpired(pendingInvoice, BASE_TIME + 1), true);

  // Exact boundary -> expired (fail-closed)
  assert.equal(hasInvoiceExpired(pendingInvoice, BASE_TIME), true);

  // Future boundary -> not expired
  assert.equal(hasInvoiceExpired(pendingInvoice, BASE_TIME - 1), false);
});

test('Issue #150: effectiveInvoiceStatus accurately projects status', () => {
  assert.equal(effectiveInvoiceStatus(null), undefined);

  const pendingExpired = {
    status: 'PENDING',
    expiresAt: new Date(BASE_TIME - 5000).toISOString(),
  };
  assert.equal(effectiveInvoiceStatus(pendingExpired, BASE_TIME), 'EXPIRED');

  const pendingActive = {
    status: 'PENDING',
    expiresAt: new Date(BASE_TIME + 5000).toISOString(),
  };
  assert.equal(effectiveInvoiceStatus(pendingActive, BASE_TIME), 'PENDING');

  const paidInvoice = {
    status: 'PAID',
    expiresAt: new Date(BASE_TIME - 5000).toISOString(),
  };
  assert.equal(effectiveInvoiceStatus(paidInvoice, BASE_TIME), 'PAID');
});

test('Issue #150: applyExpiryStatus maintains immutability', () => {
  const pendingExpired = {
    id: 'inv-1',
    status: 'PENDING',
    expiresAt: new Date(BASE_TIME - 1000).toISOString(),
  };

  const updated = applyExpiryStatus(pendingExpired, BASE_TIME);
  assert.equal(updated.status, 'EXPIRED');
  // Original is not mutated
  assert.equal(pendingExpired.status, 'PENDING');
  assert.notEqual(updated, pendingExpired);

  const pendingActive = {
    id: 'inv-2',
    status: 'PENDING',
    expiresAt: new Date(BASE_TIME + 1000).toISOString(),
  };
  const unchanged = applyExpiryStatus(pendingActive, BASE_TIME);
  // Same reference if status did not change
  assert.equal(unchanged, pendingActive);
});

test('Issue #150: applyExpiryLifecycle handles collections safely', () => {
  assert.deepEqual(applyExpiryLifecycle(null), []);
  assert.deepEqual(applyExpiryLifecycle(undefined), []);
  assert.deepEqual(applyExpiryLifecycle('invalid'), []);

  const invoices = [
    { id: '1', status: 'PENDING', expiresAt: new Date(BASE_TIME - 1000).toISOString() },
    { id: '2', status: 'PENDING', expiresAt: new Date(BASE_TIME + 1000).toISOString() },
    { id: '3', status: 'PAID', expiresAt: new Date(BASE_TIME - 1000).toISOString() },
  ];

  const processed = applyExpiryLifecycle(invoices, BASE_TIME);
  assert.equal(processed.length, 3);
  assert.equal(processed[0].status, 'EXPIRED');
  assert.equal(processed[1].status, 'PENDING');
  assert.equal(processed[2].status, 'PAID');
});

test('Issue #150: isActionableInvoice checks payment eligibility', () => {
  assert.equal(isActionableInvoice(null), false);

  // Active pending invoice without txHash -> Actionable
  assert.equal(
    isActionableInvoice(
      { status: 'PENDING', expiresAt: new Date(BASE_TIME + 10000).toISOString() },
      BASE_TIME
    ),
    true
  );

  // Expired invoice -> Not actionable
  assert.equal(
    isActionableInvoice(
      { status: 'PENDING', expiresAt: new Date(BASE_TIME - 1000).toISOString() },
      BASE_TIME
    ),
    false
  );

  // Pending invoice with existing paymentTxHash -> Not actionable
  assert.equal(
    isActionableInvoice(
      {
        status: 'PENDING',
        expiresAt: new Date(BASE_TIME + 10000).toISOString(),
        paymentTxHash: 'abc12345',
      },
      BASE_TIME
    ),
    false
  );
});
