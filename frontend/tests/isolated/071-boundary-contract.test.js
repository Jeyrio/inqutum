const test = require('node:test');
const assert = require('node:assert/strict');

function createBoundaryState(initialProps = {}) {
  return {
    hasError: false,
    error: null,
    fallbackMessage: initialProps.fallbackMessage || 'Something went wrong',
    name: initialProps.name || 'Component',
  };
}

function handleBoundaryError(state, error) {
  return {
    ...state,
    hasError: true,
    error: error || new Error('An unexpected error occurred.'),
  };
}

function handleBoundaryRetry(state, onRetry) {
  if (onRetry) onRetry();
  return {
    ...state,
    hasError: false,
    error: null,
  };
}

test('boundary contract initializes with clean state', () => {
  const state = createBoundaryState({ name: 'PayVerifyPanel' });
  assert.equal(state.hasError, false);
  assert.equal(state.error, null);
  assert.equal(state.name, 'PayVerifyPanel');
});

test('boundary contract captures error state accurately', () => {
  const state = createBoundaryState({ name: 'PaymentReceipt' });
  const err = new Error('Degraded dependency');
  const errorState = handleBoundaryError(state, err);
  assert.equal(errorState.hasError, true);
  assert.equal(errorState.error.message, 'Degraded dependency');
});

test('boundary contract recovers on retry', () => {
  let retried = false;
  const state = createBoundaryState({ name: 'UserProfile' });
  const errorState = handleBoundaryError(state, new Error('Network error'));
  const recoveredState = handleBoundaryRetry(errorState, () => {
    retried = true;
  });

  assert.equal(recoveredState.hasError, false);
  assert.equal(recoveredState.error, null);
  assert.equal(retried, true);
});

test('boundary contract provides fallback message for degraded component state', () => {
  const state = createBoundaryState({
    name: 'PaymentStatus',
    fallbackMessage: 'Payment status unavailable',
  });
  assert.equal(state.fallbackMessage, 'Payment status unavailable');
});
