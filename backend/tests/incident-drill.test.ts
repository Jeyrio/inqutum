import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeUserImpactReport, maskPublicKey } from '../../scripts/incident-drill';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';

const SELLER_A = 'G' + 'A'.repeat(55);
const SELLER_B = 'G' + 'B'.repeat(55);

const invoice = (over: Partial<StoredInvoice>): StoredInvoice =>
  ({
    id: 'drill-inv',
    sellerPublicKey: SELLER_A,
    amount: 10,
    assetCode: 'XLM',
    memo: 'DRILL',
    status: 'PENDING',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    ...over,
  }) as StoredInvoice;

describe('Incident drill: user-impact reporting (Issue #240)', () => {
  it('masks a public key to its first 5 and last 4 characters', () => {
    assert.equal(maskPublicKey(SELLER_A), 'GAAAA...AAAA');
  });

  it('leaves short values unmasked rather than producing a nonsensical mask', () => {
    assert.equal(maskPublicKey('short'), 'short');
  });

  it('counts affected invoices and distinct affected sellers', () => {
    const now = new Date('2026-01-03T00:00:00.000Z');
    const report = computeUserImpactReport(
      [
        invoice({ id: 'i1', sellerPublicKey: SELLER_A, status: 'PAID' }),
        invoice({ id: 'i2', sellerPublicKey: SELLER_A, status: 'PENDING' }),
        invoice({ id: 'i3', sellerPublicKey: SELLER_B, status: 'EXPIRED' }),
      ],
      now
    );

    assert.equal(report.invoicesAffected, 3);
    assert.equal(report.sellersAffected, 2);
    assert.equal(report.affectedSellers.length, 2);
    assert.ok(report.affectedSellers.every((k) => k.includes('...')));
  });

  it('counts expired and overdue-still-pending invoices as delayed/failed payments', () => {
    const now = new Date('2026-01-03T00:00:00.000Z');
    const report = computeUserImpactReport(
      [
        invoice({ id: 'i1', status: 'EXPIRED' }),
        invoice({ id: 'i2', status: 'PENDING', expiresAt: new Date('2026-01-02T00:00:00.000Z') }), // overdue
        invoice({ id: 'i3', status: 'PENDING', expiresAt: new Date('2026-01-10T00:00:00.000Z') }), // not yet due
        invoice({ id: 'i4', status: 'PAID' }),
        invoice({ id: 'i5', status: 'CANCELLED' }),
      ],
      now
    );

    assert.equal(report.paymentsDelayedOrFailed, 2);
  });

  it('reports zero impact for an empty affected set', () => {
    const report = computeUserImpactReport([], new Date('2026-01-01T00:00:00.000Z'));
    assert.deepEqual(report, {
      generatedAt: '2026-01-01T00:00:00.000Z',
      invoicesAffected: 0,
      sellersAffected: 0,
      paymentsDelayedOrFailed: 0,
      affectedSellers: [],
    });
  });
});
