const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeStellarNetworkError,
  isHorizonUnreachable,
} = require('../lib/stellar-network-error.js');

test('wallet connect contract - success case', () => {
  const balances = [{ assetCode: 'XLM', balance: '100.5' }];
  const xlmBalance = balances.find(b => b.assetCode === 'XLM');
  assert.ok(xlmBalance);
  assert.equal(parseFloat(xlmBalance.balance).toFixed(2), '100.50');
});

test('wallet connect contract - balance parsing', () => {
  const cases = [
    { input: '0', expected: '0.00' },
    { input: '100.5', expected: '100.50' },
    { input: '999.999', expected: '1000.00' },
    { input: '0.0001', expected: '0.00' },
  ];

  for (const { input, expected } of cases) {
    const result = parseFloat(input).toFixed(2);
    assert.equal(result, expected, `balance ${input} should format to ${expected}`);
  }
});

test('wallet connect contract - error classification for account not found', () => {
  const error = { message: 'Not Found', response: { status: 404 } };
  const description = describeStellarNetworkError(error);
  assert.ok(description.includes('funding'), 'should mention funding for 404');
});

test('wallet connect contract - error classification for network issues', () => {
  const error = { code: 'ECONNABORTED' };
  const description = describeStellarNetworkError(error);
  assert.ok(description.includes('temporarily'), 'should indicate temporary network issue');
});

test('wallet connect contract - error classification for generic error', () => {
  const error = { message: 'Unknown error' };
  const description = describeStellarNetworkError(error);
  assert.equal(description, 'Unknown error');
});

test('wallet connect contract - degraded dependency handling', () => {
  const networkErrors = [
    { code: 'ERR_NETWORK' },
    { code: 'ECONNABORTED' },
    { code: 'ETIMEDOUT' },
    { response: null, code: 'ENOTFOUND' },
  ];

  for (const error of networkErrors) {
    const description = describeStellarNetworkError(error);
    assert.ok(description.length > 0, 'should provide error description for network error');
  }
});

test('wallet connect contract - retry condition detection', () => {
  const retryableError = { code: 'ETIMEDOUT' };
  const nonRetryableError = { message: 'Invalid account' };

  // Retry only when Horizon was not reached; the same rule the copy above uses.
  const isRetryable = isHorizonUnreachable;

  assert.ok(isRetryable(retryableError), 'timeout should be retryable');
  assert.ok(!isRetryable(nonRetryableError), 'validation error should not be retryable');
});
