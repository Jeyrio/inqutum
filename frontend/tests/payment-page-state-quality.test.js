const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAY_STATES,
  TERMINAL_STATES,
  shouldShowPaymentControls,
  getPayPageView,
  stateForStatus,
  initialPaymentState,
  paymentReducer,
  shouldPoll,
} = require('../lib/payment-page-state');

const NOW = 1756555200000; // Reference timestamp

test('Issue #151: shouldShowPaymentControls fails closed on invalid or missing inputs', () => {
  assert.equal(shouldShowPaymentControls(null), false);
  assert.equal(shouldShowPaymentControls(undefined), false);
  assert.equal(shouldShowPaymentControls(''), false);
  assert.equal(shouldShowPaymentControls({}), false);
  assert.equal(shouldShowPaymentControls(12345), false);
});

test('Issue #151: shouldShowPaymentControls fails closed on expired invoices', () => {
  // Explicit EXPIRED status
  assert.equal(shouldShowPaymentControls({ status: 'EXPIRED' }), false);

  // Expired by timestamp
  const pastInvoice = {
    status: 'PENDING',
    expiresAt: new Date(NOW - 1000).toISOString(),
  };
  assert.equal(shouldShowPaymentControls(pastInvoice, null, NOW), false);

  // Exactly at boundary
  const boundaryInvoice = {
    status: 'PENDING',
    expiresAt: new Date(NOW).toISOString(),
  };
  assert.equal(shouldShowPaymentControls(boundaryInvoice, null, NOW), false);
});

test('Issue #151: shouldShowPaymentControls fails closed on non-PENDING status', () => {
  assert.equal(shouldShowPaymentControls({ status: 'PAID' }), false);
  assert.equal(shouldShowPaymentControls({ status: 'CANCELLED' }), false);
  assert.equal(shouldShowPaymentControls({ status: 'FAILED' }), false);
  assert.equal(shouldShowPaymentControls({ status: 'REFUNDED' }), false);
});

test('Issue #151: shouldShowPaymentControls fails closed when transaction hash is present', () => {
  const pendingInvoiceWithHash = {
    status: 'PENDING',
    expiresAt: new Date(NOW + 60000).toISOString(),
    paymentTxHash: 'abc123def456',
  };
  assert.equal(shouldShowPaymentControls(pendingInvoiceWithHash, null, NOW), false);

  const pendingInvoice = {
    status: 'PENDING',
    expiresAt: new Date(NOW + 60000).toISOString(),
  };
  // Passed as argument
  assert.equal(shouldShowPaymentControls(pendingInvoice, 'hash789', NOW), false);
  assert.equal(shouldShowPaymentControls(pendingInvoice, '   ', NOW), true); // whitespace only is not a valid hash
});

test('Issue #151: shouldShowPaymentControls returns true only for valid actionable pending invoices', () => {
  const pendingInvoice = {
    status: 'PENDING',
    expiresAt: new Date(NOW + 60000).toISOString(),
  };
  assert.equal(shouldShowPaymentControls(pendingInvoice, null, NOW), true);
});

test('Issue #151: getPayPageView presentation contract', () => {
  assert.deepEqual(getPayPageView(null), {
    expired: false,
    paid: false,
    showPaymentControls: false,
    showProof: false,
    showMonitor: false,
  });

  const paidInvoice = {
    status: 'PAID',
    paymentTxHash: 'a'.repeat(64),
  };
  const paidView = getPayPageView(paidInvoice);
  assert.equal(paidView.paid, true);
  assert.equal(paidView.showProof, true);
  assert.equal(paidView.showPaymentControls, false);
  assert.equal(paidView.showMonitor, false);
  assert.equal(paidView.expired, false);

  const expiredInvoice = {
    status: 'PENDING',
    expiresAt: new Date(NOW - 1000).toISOString(),
  };
  const expiredView = getPayPageView(expiredInvoice, NOW);
  assert.equal(expiredView.expired, true);
  assert.equal(expiredView.showPaymentControls, false);
  assert.equal(expiredView.showMonitor, false);
});

test('Issue #151: paymentReducer handles degraded dependency failures and retries', () => {
  let state = initialPaymentState(null);
  assert.equal(state.status, PAY_STATES.IDLE);

  // Pay started
  state = paymentReducer(state, { type: 'PAY_STARTED' });
  assert.equal(state.status, PAY_STATES.PAYING);

  // Pay failed -> Error state with user message
  state = paymentReducer(state, { type: 'PAY_FAILED', error: 'Wallet timeout' });
  assert.equal(state.status, PAY_STATES.ERROR);
  assert.equal(state.error, 'Wallet timeout');

  // Reset -> Can retry back to IDLE
  state = paymentReducer(state, { type: 'RESET' });
  assert.equal(state.status, PAY_STATES.IDLE);
  assert.equal(state.error, null);

  // Terminal state protection
  state = { status: PAY_STATES.PAID, invoice: { status: 'PAID' }, txHash: '123', error: null };
  const attemptedReset = paymentReducer(state, { type: 'RESET' });
  assert.equal(attemptedReset.status, PAY_STATES.PAID);
});
