import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  simulatePolicyChange,
  buildProposedPolicy,
} from '../src/domain/policy-simulation.ts';
import { DEFAULT_POLICY, type BusinessPolicy } from '../src/domain/policy.ts';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';

const SELLER_1 = 'G' + '1'.repeat(55);
const SELLER_2 = 'G' + '2'.repeat(55);

function makeInvoice(id: string, over: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id,
    sellerPublicKey: SELLER_1,
    amount: 100,
    assetCode: 'XLM',
    memo: `INV-${id}`,
    status: 'PENDING',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    ...over,
  };
}

describe('Policy simulation preview contract (Issue #267)', () => {
  it('previews zero affected records and risk NONE when proposed policy creates no divergence', () => {
    const invoices = [
      makeInvoice('inv-1', { amount: 100, assetCode: 'XLM', status: 'PENDING' }),
      makeInvoice('inv-2', { amount: 500, assetCode: 'XLM', status: 'PAID' }),
    ];

    const current: BusinessPolicy = {
      ...DEFAULT_POLICY,
      invoice: { ...DEFAULT_POLICY.invoice, minAmount: 1, maxAmount: 1000 },
    };

    // Proposed policy expands range (minAmount: 0.5, maxAmount: 2000)
    const simulation = simulatePolicyChange(invoices, { minAmount: 0.5, maxAmount: 2000 }, current);

    assert.equal(simulation.riskLevel, 'NONE');
    assert.equal(simulation.totalAffectedRecords, 0);
    assert.equal(simulation.totalAffectedSellers, 0);
    assert.equal(simulation.expectedSideEffects.pendingInvoicesAtRisk, 0);
    assert.equal(simulation.readOnlyVerified, true);
  });

  it('identifies affected records and sellers when lowering maxAmount below pending invoice amounts', () => {
    const invoices = [
      makeInvoice('inv-low', { amount: 50, sellerPublicKey: SELLER_1, status: 'PENDING' }),
      makeInvoice('inv-high-1', { amount: 600, sellerPublicKey: SELLER_1, status: 'PENDING' }),
      makeInvoice('inv-high-2', { amount: 800, sellerPublicKey: SELLER_2, status: 'PENDING' }),
      makeInvoice('inv-paid', { amount: 900, sellerPublicKey: SELLER_2, status: 'PAID' }),
    ];

    const current: BusinessPolicy = {
      ...DEFAULT_POLICY,
      invoice: { ...DEFAULT_POLICY.invoice, maxAmount: 1000 },
    };

    // Propose lowering maxAmount to 500
    const simulation = simulatePolicyChange(invoices, { maxAmount: 500 }, current);

    assert.equal(simulation.totalRecordsEvaluated, 4);
    // inv-high-1, inv-high-2, inv-paid are all > 500, but only the 2 PENDING ones are active risk
    assert.equal(simulation.totalAffectedRecords, 3);
    assert.equal(simulation.expectedSideEffects.pendingInvoicesAtRisk, 2);
    assert.equal(simulation.expectedSideEffects.volumeAtRiskByAsset.XLM, 1400); // 600 + 800

    assert.equal(simulation.totalAffectedSellers, 2);
    const seller1 = simulation.affectedSellers.find((s) => s.sellerPublicKey === SELLER_1);
    const seller2 = simulation.affectedSellers.find((s) => s.sellerPublicKey === SELLER_2);
    assert.equal(seller1?.affectedCount, 1);
    assert.equal(seller1?.atRiskVolume.XLM, 600);
    assert.equal(seller2?.affectedCount, 1);
    assert.equal(seller2?.atRiskVolume.XLM, 800);

    // Rollback constraints must warn about the lowered max amount
    assert.ok(simulation.rollbackConstraints.some((c) => c.id === 'MAX_AMOUNT_LOWERED'));
  });

  it('detects asset allowlist restrictions and quantifies volume at risk per asset', () => {
    const invoices = [
      makeInvoice('inv-xlm', { amount: 100, assetCode: 'XLM', status: 'PENDING' }),
      makeInvoice('inv-usdc-1', { amount: 250, assetCode: 'USDC', status: 'PENDING' }),
      makeInvoice('inv-usdc-2', { amount: 750, assetCode: 'USDC', status: 'PENDING' }),
    ];

    const current: BusinessPolicy = {
      ...DEFAULT_POLICY,
      invoice: { ...DEFAULT_POLICY.invoice, allowedAssets: ['XLM', 'USDC'] },
    };

    // Proposed change: remove USDC and restrict only to XLM
    const simulation = simulatePolicyChange(invoices, { allowedAssets: ['XLM'] }, current);

    assert.equal(simulation.expectedSideEffects.pendingInvoicesAtRisk, 2);
    assert.equal(simulation.expectedSideEffects.volumeAtRiskByAsset.USDC, 1000);
    assert.deepEqual(simulation.expectedSideEffects.newlyDisallowedAssets, ['USDC']);

    // Must recommend grandfathering mitigation
    const assetConstraint = simulation.rollbackConstraints.find((c) => c.id === 'ASSET_ALLOWLIST_RESTRICTION');
    assert.ok(assetConstraint);
    assert.match(assetConstraint!.recommendedMitigation, /unsettled invoices/i);
  });

  it('preserves read-only invariants and does not mutate input policy or invoice objects', () => {
    const origInvoice = makeInvoice('inv-immutable', { amount: 500, assetCode: 'XLM' });
    const frozenInvoice = Object.freeze({ ...origInvoice });
    const current: BusinessPolicy = {
      ...DEFAULT_POLICY,
      invoice: { ...DEFAULT_POLICY.invoice, minAmount: 1, maxAmount: 1000 },
    };

    const simulation = simulatePolicyChange([frozenInvoice], { maxAmount: 100 }, current);

    assert.equal(simulation.totalAffectedRecords, 1);
    // Source data remains untouched
    assert.equal(frozenInvoice.amount, 500);
    assert.equal(current.invoice.maxAmount, 1000);
  });
});
