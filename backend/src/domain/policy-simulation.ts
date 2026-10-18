/**
 * Policy Simulation Preview Engine (Issue #267).
 *
 * Maintainers must be able to preview affected records, affected users,
 * expected side effects, and rollback constraints before committing
 * irreversible or high-impact policy changes.
 *
 * Invariants:
 *  - Strictly read-only: no writes or database mutations are performed.
 *  - Evaluates impact against live pending and active invoices.
 *  - Identifies grandfathering requirements and rollback safety risks.
 */

import {
  DEFAULT_POLICY,
  evaluateInvoiceRequest,
  type BusinessPolicy,
  type PolicyCode,
} from './policy';
import type { StoredInvoice } from '../storage/invoice-storage';

export type SimulationRiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AffectedRecordPreview {
  invoiceId: string;
  sellerPublicKey: string;
  amount: number;
  assetCode: string;
  status: StoredInvoice['status'];
  currentOutcome: 'ALLOWED' | PolicyCode;
  proposedOutcome: 'ALLOWED' | PolicyCode;
  reason: string;
}

export interface AffectedSellerSummary {
  sellerPublicKey: string;
  affectedCount: number;
  atRiskVolume: Record<string, number>;
}

export interface RollbackConstraint {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARNING' | 'INFO';
  description: string;
  reversible: boolean;
  recommendedMitigation: string;
}

export interface PolicySimulationReport {
  simulatedAt: string;
  currentPolicy: BusinessPolicy;
  proposedPolicy: BusinessPolicy;
  riskLevel: SimulationRiskLevel;
  totalRecordsEvaluated: number;
  totalAffectedRecords: number;
  totalAffectedSellers: number;
  affectedRecords: AffectedRecordPreview[];
  affectedSellers: AffectedSellerSummary[];
  expectedSideEffects: {
    pendingInvoicesAtRisk: number;
    volumeAtRiskByAsset: Record<string, number>;
    newlyDisallowedAssets: string[];
    summary: string;
  };
  rollbackConstraints: RollbackConstraint[];
  readOnlyVerified: boolean;
}

export interface ProposedPolicyInput {
  minAmount?: number;
  maxAmount?: number;
  minExpiryDays?: number;
  maxExpiryDays?: number;
  defaultExpiryDays?: number;
  allowedAssets?: string[];
}

export function buildProposedPolicy(
  current: BusinessPolicy,
  input: ProposedPolicyInput
): BusinessPolicy {
  return {
    invoice: {
      minAmount: input.minAmount ?? current.invoice.minAmount,
      maxAmount: input.maxAmount ?? current.invoice.maxAmount,
      minExpiryDays: input.minExpiryDays ?? current.invoice.minExpiryDays,
      maxExpiryDays: input.maxExpiryDays ?? current.invoice.maxExpiryDays,
      defaultExpiryDays: input.defaultExpiryDays ?? current.invoice.defaultExpiryDays,
      allowedAssets: input.allowedAssets !== undefined ? input.allowedAssets : [...current.invoice.allowedAssets],
    },
  };
}

/**
 * Simulates proposed policy changes against stored invoices.
 * Guaranteed read-only.
 */
export function simulatePolicyChange(
  invoices: StoredInvoice[],
  proposedInput: ProposedPolicyInput,
  currentPolicy: BusinessPolicy = DEFAULT_POLICY
): PolicySimulationReport {
  const proposedPolicy = buildProposedPolicy(currentPolicy, proposedInput);

  const affectedRecords: AffectedRecordPreview[] = [];
  const sellersMap = new Map<string, { count: number; volume: Record<string, number> }>();
  const volumeAtRisk: Record<string, number> = {};

  // Track newly disallowed assets
  const currentAssets = new Set(currentPolicy.invoice.allowedAssets.map((a) => a.toUpperCase()));
  const proposedAssets = new Set(proposedPolicy.invoice.allowedAssets.map((a) => a.toUpperCase()));
  const newlyDisallowedAssets: string[] = [];

  if (proposedPolicy.invoice.allowedAssets.length > 0) {
    if (currentPolicy.invoice.allowedAssets.length === 0) {
      // Was any asset, now restricted
      newlyDisallowedAssets.push('* (restricted from open to explicit list)');
    } else {
      for (const asset of currentAssets) {
        if (!proposedAssets.has(asset)) {
          newlyDisallowedAssets.push(asset);
        }
      }
    }
  }

  for (const inv of invoices) {
    // Only pending invoices are actively at risk of checkout/payment failure under new policy
    const currentEval = evaluateInvoiceRequest(
      { amount: inv.amount, assetCode: inv.assetCode },
      currentPolicy
    );
    const proposedEval = evaluateInvoiceRequest(
      { amount: inv.amount, assetCode: inv.assetCode },
      proposedPolicy
    );

    const currentOutcome = currentEval.allowed ? 'ALLOWED' : currentEval.code;
    const proposedOutcome = proposedEval.allowed ? 'ALLOWED' : proposedEval.code;

    // Divergence check: if it was valid before but would now be denied
    if (currentEval.allowed && !proposedEval.allowed) {
      const reason = !proposedEval.allowed ? proposedEval.message : '';
      affectedRecords.push({
        invoiceId: inv.id,
        sellerPublicKey: inv.sellerPublicKey,
        amount: inv.amount,
        assetCode: inv.assetCode,
        status: inv.status,
        currentOutcome,
        proposedOutcome,
        reason,
      });

      if (inv.status === 'PENDING') {
        const asset = inv.assetCode.toUpperCase();
        volumeAtRisk[asset] = (volumeAtRisk[asset] ?? 0) + inv.amount;

        const seller = sellersMap.get(inv.sellerPublicKey) ?? { count: 0, volume: {} };
        seller.count += 1;
        seller.volume[asset] = (seller.volume[asset] ?? 0) + inv.amount;
        sellersMap.set(inv.sellerPublicKey, seller);
      }
    }
  }

  const affectedSellers: AffectedSellerSummary[] = Array.from(sellersMap.entries()).map(
    ([sellerPublicKey, data]) => ({
      sellerPublicKey,
      affectedCount: data.count,
      atRiskVolume: data.volume,
    })
  );

  const pendingAtRisk = affectedRecords.filter((r) => r.status === 'PENDING').length;

  // Evaluate risk level
  let riskLevel: SimulationRiskLevel = 'NONE';
  if (pendingAtRisk === 0 && affectedRecords.length === 0) {
    riskLevel = 'NONE';
  } else if (pendingAtRisk <= 2 && affectedSellers.length <= 1) {
    riskLevel = 'LOW';
  } else if (pendingAtRisk <= 10) {
    riskLevel = 'MEDIUM';
  } else if (pendingAtRisk <= 50 || newlyDisallowedAssets.length > 0) {
    riskLevel = 'HIGH';
  } else {
    riskLevel = 'CRITICAL';
  }

  // Evaluate rollback constraints
  const rollbackConstraints: RollbackConstraint[] = [];

  if (pendingAtRisk > 0) {
    rollbackConstraints.push({
      id: 'PENDING_INVOICE_INVARIANCE',
      severity: pendingAtRisk > 10 ? 'CRITICAL' : 'WARNING',
      description: `${pendingAtRisk} currently pending invoice(s) will fail policy compliance. If payers submit payment, verification or processing could be rejected.`,
      reversible: false,
      recommendedMitigation:
        'Enforce policy transition using a grandfathering cut-off timestamp (created_at >= migration_time) so in-flight invoices remain valid until expiry.',
    });
  }

  if (newlyDisallowedAssets.length > 0) {
    rollbackConstraints.push({
      id: 'ASSET_ALLOWLIST_RESTRICTION',
      severity: 'HIGH',
      description: `Assets [${newlyDisallowedAssets.join(', ')}] are being removed from the allowable list while pending balances may exist.`,
      reversible: true,
      recommendedMitigation:
        'Verify zero unsettled invoices exist in deprecated assets or provide automated currency swap routing before disabling.',
    });
  }

  if (proposedPolicy.invoice.maxAmount < currentPolicy.invoice.maxAmount) {
    rollbackConstraints.push({
      id: 'MAX_AMOUNT_LOWERED',
      severity: 'WARNING',
      description: `Maximum invoice limit lowered from ${currentPolicy.invoice.maxAmount} to ${proposedPolicy.invoice.maxAmount}.`,
      reversible: true,
      recommendedMitigation:
        'Ensure notification is broadcast to high-value enterprise merchants prior to cutover.',
    });
  }

  const summary =
    pendingAtRisk === 0
      ? 'No active pending invoices will be disrupted by this policy change.'
      : `${pendingAtRisk} active pending invoice(s) across ${affectedSellers.length} seller(s) will become non-compliant.`;

  return {
    simulatedAt: new Date().toISOString(),
    currentPolicy,
    proposedPolicy,
    riskLevel,
    totalRecordsEvaluated: invoices.length,
    totalAffectedRecords: affectedRecords.length,
    totalAffectedSellers: affectedSellers.length,
    affectedRecords,
    affectedSellers,
    expectedSideEffects: {
      pendingInvoicesAtRisk: pendingAtRisk,
      volumeAtRiskByAsset: volumeAtRisk,
      newlyDisallowedAssets,
      summary,
    },
    rollbackConstraints,
    readOnlyVerified: true,
  };
}
