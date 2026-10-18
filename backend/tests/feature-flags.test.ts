import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { FEATURE_FLAGS, featureFlagSnapshot, isFeatureEnabled } from '../src/config/feature-flags.ts';
import { amountsMatch, verifyHorizonPayment } from '../src/services/payment-verification.ts';
import { healthPayload } from '../src/health.ts';

const ENV = FEATURE_FLAGS.paymentAmountTolerance.env;
const SELLER = 'GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// One stroop over the 100 XLM invoice: only the flagged path accepts it.
const offByOneStroop = () =>
  verifyHorizonPayment({
    txHash: 'a1b2c3d4'.repeat(8),
    expected: { memo: 'INV-1', amount: 100, destination: SELLER, assetCode: 'XLM' },
    transaction: { memo: 'INV-1', memo_type: 'text' },
    operations: [{ type: 'payment', from: 'GPAYER', to: SELLER, amount: '100.0000001', asset_type: 'native' }],
  });

describe('feature flags', () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it('every flag defaults to off, the safer behaviour', () => {
    for (const [flag, definition] of Object.entries(FEATURE_FLAGS)) {
      assert.equal(definition.safeDefault, false, flag);
    }
    assert.deepEqual(featureFlagSnapshot({}), { paymentAmountTolerance: false });
  });

  it('parses explicit on/off values and falls back to the safe default otherwise', () => {
    for (const value of ['true', 'TRUE', '1', ' on ']) {
      assert.equal(isFeatureEnabled('paymentAmountTolerance', { [ENV]: value }), true, value);
    }
    for (const value of [undefined, '', 'false', '0', 'off', 'yes', 'enabled']) {
      assert.equal(isFeatureEnabled('paymentAmountTolerance', { [ENV]: value }), false, String(value));
    }
  });

  it('disabled: payment verification requires an exact stroop match', () => {
    assert.equal(amountsMatch('100.0000001', 100), false);
    const result = offByOneStroop();
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'AMOUNT_MISMATCH');
  });

  it('enabled: a one-stroop difference settles, two stroops still fail', () => {
    process.env[ENV] = 'true';
    assert.equal(amountsMatch('100.0000001', 100), true);
    assert.equal(amountsMatch('99.9999999', 100), true);
    assert.equal(amountsMatch('100.0000002', 100), false);
    assert.equal(offByOneStroop().ok, true);
  });

  it('rolling back takes effect on the next check without a rebuild', () => {
    process.env[ENV] = 'true';
    assert.equal(offByOneStroop().ok, true);
    process.env[ENV] = 'false';
    assert.equal(offByOneStroop().ok, false);
  });

  it('health reports the effective flag state for rollout verification', () => {
    process.env[ENV] = 'on';
    assert.deepEqual(healthPayload('in-memory').features, { paymentAmountTolerance: true });
  });
});
