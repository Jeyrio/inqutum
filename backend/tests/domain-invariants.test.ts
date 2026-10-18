import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';

const SELLER = 'G' + 'S'.repeat(55);
const PAYER = 'G' + 'P'.repeat(55);

const invoice = (over: Partial<StoredInvoice> = {}): StoredInvoice => ({
  id: 'inv-1',
  sellerPublicKey: SELLER,
  amount: 100,
  assetCode: 'XLM',
  memo: 'INV-1',
  status: 'PENDING',
  customerName: 'Customer',
  customerEmail: 'customer@example.com',
  payerName: 'Payer',
  payerEmail: 'payer@example.com',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

function validateInvoiceInvariant(record: StoredInvoice): string[] {
  const errors: string[] = [];
  if (!record.id.trim()) errors.push('id required');
  if (!/^G[A-Z0-9]{55}$/.test(record.sellerPublicKey)) errors.push('seller public key required');
  if (!Number.isFinite(record.amount) || record.amount <= 0) errors.push('amount must be positive');
  if (!record.assetCode.trim()) errors.push('asset code required');
  if (!record.memo.trim()) errors.push('memo required');
  if (!['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'].includes(record.status)) errors.push('status invalid');
  if (record.expiresAt.getTime() <= record.createdAt.getTime()) errors.push('expiry must be after creation');
  if (record.status === 'PAID' && !record.payerEmail?.trim() && !record.payerName?.trim()) errors.push('paid invoice needs payer context');
  if (record.status === 'PENDING' && record.expiresAt.getTime() <= Date.parse('2026-01-01T00:00:00.000Z')) errors.push('pending invoice cannot be expired already');
  return errors;
}

function canTransition(from: StoredInvoice['status'], to: StoredInvoice['status']): boolean {
  const allowed: Record<StoredInvoice['status'], StoredInvoice['status'][]> = {
    PENDING: ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'],
    PAID: ['PAID'],
    EXPIRED: ['EXPIRED'],
    CANCELLED: ['CANCELLED'],
  };
  return allowed[from].includes(to);
}

describe('Domain model invariants', () => {
  it('accepts a coherent invoice record', () => {
    assert.deepEqual(validateInvoiceInvariant(invoice()), []);
  });

  it('rejects impossible scalar fields', () => {
    assert.match(validateInvoiceInvariant(invoice({ id: '' })).join(','), /id required/);
    assert.match(validateInvoiceInvariant(invoice({ sellerPublicKey: PAYER.slice(0, -1) })).join(','), /seller public key/);
    assert.match(validateInvoiceInvariant(invoice({ amount: 0 })).join(','), /amount/);
    assert.match(validateInvoiceInvariant(invoice({ assetCode: '' })).join(','), /asset code/);
    assert.match(validateInvoiceInvariant(invoice({ memo: '' })).join(','), /memo/);
  });

  it('rejects impossible temporal and status combinations', () => {
    assert.match(validateInvoiceInvariant(invoice({ expiresAt: new Date('2025-12-31T00:00:00.000Z') })).join(','), /expiry/);
    assert.match(validateInvoiceInvariant(invoice({ status: 'UNKNOWN' as StoredInvoice['status'] })).join(','), /status invalid/);
  });

  it('keeps terminal invoice states terminal', () => {
    for (const terminal of ['PAID', 'EXPIRED', 'CANCELLED'] as const) {
      assert.equal(canTransition(terminal, 'PENDING'), false);
      assert.equal(canTransition(terminal, terminal), true);
    }
  });

  it('allows pending invoices to settle, expire, or cancel exactly once', () => {
    assert.equal(canTransition('PENDING', 'PAID'), true);
    assert.equal(canTransition('PENDING', 'EXPIRED'), true);
    assert.equal(canTransition('PENDING', 'CANCELLED'), true);
    assert.equal(canTransition('EXPIRED', 'PAID'), false);
    assert.equal(canTransition('CANCELLED', 'PAID'), false);
  });
});
