import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isValidStellarAmount,
  isValidStellarPublicKey,
} from '../src/services/stellar.service.ts';
import { isUsablePaymentRecord } from '../src/services/payment-monitor.service.ts';
import {
  STELLAR_MEMO_MAX_BYTES,
  generateInvoiceMemo,
  isValidMemo,
} from '../src/utils/memo.ts';

const PUBLIC_KEY = `G${'A'.repeat(55)}`;
const TX_HASH = 'a'.repeat(64);

describe('stellar service boundary', () => {
  it('accepts only valid public keys and positive Stellar amounts', () => {
    assert.equal(isValidStellarPublicKey(PUBLIC_KEY), true);
    assert.equal(isValidStellarPublicKey('not-a-key'), false);
    assert.equal(isValidStellarAmount('12.1234567'), true);
    assert.equal(isValidStellarAmount('12.12345678'), false);
    assert.equal(isValidStellarAmount('1abc'), false);
    assert.equal(isValidStellarAmount('0'), false);
  });
});

describe('payment monitor boundary', () => {
  const payment = {
    id: 'payment-1',
    txHash: TX_HASH,
    from: PUBLIC_KEY,
    to: PUBLIC_KEY,
    amount: '1.0000000',
    assetCode: 'XLM',
    ledger: 1,
    createdAt: new Date().toISOString(),
  };

  it('accepts a complete payment record', () => {
    assert.equal(isUsablePaymentRecord(payment), true);
  });

  it('rejects malformed records before invoice mutation', () => {
    assert.equal(isUsablePaymentRecord({ ...payment, txHash: 'bad' }), false);
    assert.equal(isUsablePaymentRecord({ ...payment, amount: '1.00000008' }), false);
    assert.equal(isUsablePaymentRecord({ ...payment, amount: 'not-a-number' }), false);
  });
});

describe('memo boundary', () => {
  it('generates memos accepted by Stellar and rejects oversized values', () => {
    const memo = generateInvoiceMemo();
    assert.equal(isValidMemo(memo), true);
    assert.ok(Buffer.byteLength(memo, 'utf8') <= STELLAR_MEMO_MAX_BYTES);
    assert.equal(isValidMemo(`INV-${'A'.repeat(30)}-A`), false);
    assert.equal(isValidMemo(null as unknown as string), false);
  });
});
