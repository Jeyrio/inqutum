import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_POLICY,
  evaluateInvoiceRequest,
  loadPolicy,
} from '../src/domain/policy.ts';
import { createInvoiceSchema } from '../src/utils/validation.ts';

const code = (decision: ReturnType<typeof evaluateInvoiceRequest>) => (decision.allowed ? 'ALLOWED' : decision.code);

describe('invoice policy', () => {
  it('allows a normal invoice under the default policy', () => {
    assert.equal(code(evaluateInvoiceRequest({ amount: 25, assetCode: 'XLM', expiresInDays: 7 })), 'ALLOWED');
  });

  it('checks amount boundaries inclusively', () => {
    const { minAmount, maxAmount } = DEFAULT_POLICY.invoice;
    assert.equal(code(evaluateInvoiceRequest({ amount: minAmount })), 'ALLOWED');
    assert.equal(code(evaluateInvoiceRequest({ amount: maxAmount })), 'ALLOWED');
    assert.equal(code(evaluateInvoiceRequest({ amount: 0 })), 'AMOUNT_TOO_LOW');
    assert.equal(code(evaluateInvoiceRequest({ amount: Number.NaN })), 'AMOUNT_TOO_LOW');
    assert.equal(code(evaluateInvoiceRequest({ amount: maxAmount + 1 })), 'AMOUNT_TOO_HIGH');
  });

  it('checks expiry boundaries', () => {
    const { minExpiryDays, maxExpiryDays } = DEFAULT_POLICY.invoice;
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, expiresInDays: minExpiryDays })), 'ALLOWED');
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, expiresInDays: maxExpiryDays })), 'ALLOWED');
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, expiresInDays: minExpiryDays - 1 })), 'EXPIRY_OUT_OF_RANGE');
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, expiresInDays: maxExpiryDays + 1 })), 'EXPIRY_OUT_OF_RANGE');
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, expiresInDays: 1.5 })), 'EXPIRY_OUT_OF_RANGE');
  });

  it('restricts assets only when an allow list is set', () => {
    const policy = { ...DEFAULT_POLICY, invoice: { ...DEFAULT_POLICY.invoice, allowedAssets: ['XLM', 'USDC'] } };
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, assetCode: 'usdc' }, policy)), 'ALLOWED');
    const denied = evaluateInvoiceRequest({ amount: 1, assetCode: 'EURC' }, policy);
    assert.equal(code(denied), 'ASSET_NOT_ALLOWED');
    assert.ok(!denied.allowed && denied.message.includes('XLM, USDC'));
    assert.equal(code(evaluateInvoiceRequest({ amount: 1, assetCode: 'EURC' })), 'ALLOWED');
  });

  it('returns user safe messages', () => {
    const denied = evaluateInvoiceRequest({ amount: -1 });
    assert.ok(!denied.allowed);
    assert.match(denied.message, /^Amount must be at least/);
  });

  it('keeps the create schema in line with the policy maximum', () => {
    const base = { sellerPublicKey: 'G' + 'A'.repeat(55) };
    assert.equal(createInvoiceSchema.safeParse({ ...base, amount: DEFAULT_POLICY.invoice.maxAmount }).success, true);
    assert.equal(createInvoiceSchema.safeParse({ ...base, amount: DEFAULT_POLICY.invoice.maxAmount + 1 }).success, false);
  });
});

describe('loadPolicy', () => {
  it('applies valid overrides', () => {
    const policy = loadPolicy({
      POLICY_MIN_INVOICE_AMOUNT: '1',
      POLICY_MAX_INVOICE_AMOUNT: '500',
      POLICY_ALLOWED_ASSETS: 'xlm, usdc',
    });
    assert.equal(policy.invoice.minAmount, 1);
    assert.equal(policy.invoice.maxAmount, 500);
    assert.deepEqual(policy.invoice.allowedAssets, ['XLM', 'USDC']);
  });

  it('falls back to defaults on invalid values', () => {
    const policy = loadPolicy({ POLICY_MAX_INVOICE_AMOUNT: 'lots', POLICY_MIN_INVOICE_AMOUNT: '-3' });
    assert.equal(policy.invoice.maxAmount, DEFAULT_POLICY.invoice.maxAmount);
    assert.equal(policy.invoice.minAmount, DEFAULT_POLICY.invoice.minAmount);
  });

  it('does not share state with the default policy', () => {
    const policy = loadPolicy({});
    policy.invoice.maxAmount = 1;
    assert.equal(DEFAULT_POLICY.invoice.maxAmount, 1_000_000_000);
  });
});
