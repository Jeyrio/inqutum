/**
 * Incident Drill: User-Impact Reporting (Issue #240).
 *
 * The incident drill runbook (docs/RUNBOOK.md) and release-readiness-gate.ts
 * already executably verify recovery, rollback, and data-validation steps.
 * This closes the one remaining acceptance-criterion gap: a check that
 * computes the "Impact" section of the runbook's post-incident review
 * template (invoices affected, sellers affected, payments delayed/failed)
 * from a set of affected invoices, rather than leaving that count to be
 * done by hand during a real incident.
 *
 * Usage:
 *   npx tsx scripts/incident-drill.ts            # Run against a sample fixture
 *   npx tsx scripts/incident-drill.ts --json     # Machine-readable output
 */

import type { StoredInvoice } from '../backend/src/storage/invoice-storage';

export interface UserImpactReport {
  generatedAt: string;
  invoicesAffected: number;
  sellersAffected: number;
  paymentsDelayedOrFailed: number;
  /** Seller public keys, masked (first 4 + last 4 chars only). */
  affectedSellers: string[];
}

/** Masks a Stellar public key for inclusion in an incident report: GABCD...WXYZ. */
export function maskPublicKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

/**
 * Computes the user-impact figures for the runbook's post-incident review
 * template from a set of invoices known or suspected to be affected by an
 * incident. "Payments delayed or failed" counts PENDING invoices past their
 * expiry (stuck) plus any invoice whose status is neither PAID nor a normal
 * pending wait — i.e. invoices that did not settle cleanly.
 */
export function computeUserImpactReport(
  affectedInvoices: StoredInvoice[],
  now: Date = new Date()
): UserImpactReport {
  const sellers = new Set(affectedInvoices.map((inv) => inv.sellerPublicKey));

  const paymentsDelayedOrFailed = affectedInvoices.filter((inv) => {
    if (inv.status === 'EXPIRED') return true;
    if (inv.status === 'PENDING' && new Date(inv.expiresAt).getTime() <= now.getTime()) return true;
    return false;
  }).length;

  return {
    generatedAt: now.toISOString(),
    invoicesAffected: affectedInvoices.length,
    sellersAffected: sellers.size,
    paymentsDelayedOrFailed,
    affectedSellers: [...sellers].map(maskPublicKey),
  };
}

// CLI Execution handler
if (require.main === module || (process.argv[1] && process.argv[1].includes('incident-drill'))) {
  const isJson = process.argv.includes('--json');

  // Sample fixture standing in for a real affected-invoice query during a drill.
  const sample: StoredInvoice[] = [
    {
      id: 'drill-1',
      sellerPublicKey: 'G' + 'A'.repeat(55),
      amount: 10,
      assetCode: 'XLM',
      memo: 'DRILL-1',
      status: 'EXPIRED',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    } as StoredInvoice,
    {
      id: 'drill-2',
      sellerPublicKey: 'G' + 'B'.repeat(55),
      amount: 20,
      assetCode: 'XLM',
      memo: 'DRILL-2',
      status: 'PAID',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    } as StoredInvoice,
  ];

  const report = computeUserImpactReport(sample, new Date('2026-01-03T00:00:00.000Z'));

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Incident Drill: User-Impact Report (sample fixture) ===');
    console.log(`Invoices affected: ${report.invoicesAffected}`);
    console.log(`Sellers affected: ${report.sellersAffected}`);
    console.log(`Payments delayed/failed: ${report.paymentsDelayedOrFailed}`);
    console.log(`Affected sellers (masked): ${report.affectedSellers.join(', ')}`);
  }
}
