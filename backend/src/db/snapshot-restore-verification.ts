/**
 * Snapshot restore verification for critical data and derived indexes (Issue #263).
 *
 * Requirements:
 *  - Restores are tested against business, financial, and relational invariants.
 *  - Derived views (search indexes, aggregate statistics, financial projections) are rebuilt from snapshot truth.
 *  - Invariant violations or derived view mismatches fail loudly with deterministic, actionable repair steps.
 *  - Compatible with existing Postgres persistence and in-memory storage models.
 */

import type { StoredInvoice, InvoiceStatus } from '../storage/invoice-storage';
import {
  PermissionAwareSearchIndex,
  type IndexedInvoiceRecord,
} from '../services/search-index.service';

export type SnapshotInvariantKind =
  | 'CORRUPTED_IDENTIFIER'
  | 'STATUS_INCOHERENCE'
  | 'FINANCIAL_MISMATCH'
  | 'TEMPORAL_ANOMALY'
  | 'ORPHANED_RELATION'
  | 'DUPLICATE_MEMO'
  | 'DERIVED_INDEX_DRIFT';

export interface SnapshotTransaction {
  id: string;
  invoice_id?: string | null;
  tx_hash: string;
  amount?: number;
  asset_code?: string;
  memo?: string;
}

export interface SnapshotPaymentEvent {
  id: string;
  invoice_id?: string | null;
  event_type: string;
}

export interface SnapshotPackage {
  metadata?: {
    version?: number;
    exportedAt?: string;
    source?: string;
  };
  invoices: StoredInvoice[];
  transactions?: SnapshotTransaction[];
  payment_events?: SnapshotPaymentEvent[];
  /** Optional pre-existing index state to verify drift against */
  existingSearchIndexRecords?: IndexedInvoiceRecord[];
}

export interface SnapshotViolation {
  kind: SnapshotInvariantKind;
  entityId: string;
  message: string;
  details: Record<string, unknown>;
  remediation: string;
}

export interface RebuiltDerivedViews {
  searchIndex: PermissionAwareSearchIndex;
  totalIndexed: number;
  stats: {
    totalInvoices: number;
    pendingCount: number;
    paidCount: number;
    expiredCount: number;
    cancelledCount: number;
    revenueByAsset: Record<string, number>;
  };
}

export interface SnapshotVerificationReport {
  timestamp: string;
  ok: boolean;
  totalInvoicesEvaluated: number;
  totalTransactionsEvaluated: number;
  totalEventsEvaluated: number;
  totalViolations: number;
  violationsByKind: Record<SnapshotInvariantKind, number>;
  violations: SnapshotViolation[];
  rebuiltViews: RebuiltDerivedViews;
  operatorActionPlan: string[];
}

export class SnapshotRestoreVerificationError extends Error {
  public readonly report: SnapshotVerificationReport;

  constructor(report: SnapshotVerificationReport) {
    super(
      `Snapshot restore verification FAILED with ${report.totalViolations} violation(s). Derived views or invariants corrupted.`
    );
    this.name = 'SnapshotRestoreVerificationError';
    this.report = report;
  }
}

/**
 * Rebuilds derived aggregate statistics from restored invoice records.
 */
export function rebuildDerivedStats(invoices: StoredInvoice[]) {
  const stats = {
    totalInvoices: invoices.length,
    pendingCount: 0,
    paidCount: 0,
    expiredCount: 0,
    cancelledCount: 0,
    revenueByAsset: {} as Record<string, number>,
  };

  for (const inv of invoices) {
    switch (inv.status) {
      case 'PENDING':
        stats.pendingCount++;
        break;
      case 'PAID':
        stats.paidCount++;
        if (typeof inv.amount === 'number' && inv.amount > 0 && inv.assetCode) {
          stats.revenueByAsset[inv.assetCode] =
            (stats.revenueByAsset[inv.assetCode] || 0) + Number(inv.amount);
        }
        break;
      case 'EXPIRED':
        stats.expiredCount++;
        break;
      case 'CANCELLED':
        stats.cancelledCount++;
        break;
    }
  }

  return stats;
}

/**
 * Rebuilds derived search index from restored invoice records.
 */
export function rebuildDerivedSearchIndex(invoices: StoredInvoice[]): PermissionAwareSearchIndex {
  const index = new PermissionAwareSearchIndex();
  for (const inv of invoices) {
    index.indexInvoice(inv, 'INTERNAL');
  }
  return index;
}

/**
 * Executes comprehensive verification against a restored snapshot package.
 */
export function verifySnapshotRestore(snapshot: SnapshotPackage): SnapshotVerificationReport {
  const timestamp = new Date().toISOString();
  const violations: SnapshotViolation[] = [];
  const violationsByKind: Record<SnapshotInvariantKind, number> = {
    CORRUPTED_IDENTIFIER: 0,
    STATUS_INCOHERENCE: 0,
    FINANCIAL_MISMATCH: 0,
    TEMPORAL_ANOMALY: 0,
    ORPHANED_RELATION: 0,
    DUPLICATE_MEMO: 0,
    DERIVED_INDEX_DRIFT: 0,
  };

  const recordViolation = (violation: SnapshotViolation) => {
    violations.push(violation);
    violationsByKind[violation.kind] = (violationsByKind[violation.kind] || 0) + 1;
  };

  const invoiceMap = new Map<string, StoredInvoice>();
  const memoMap = new Map<string, string>(); // memo -> invoiceId

  // 1. Evaluate Invoices Invariants
  for (const inv of snapshot.invoices || []) {
    // Corrupted Identifier
    if (!inv.id || typeof inv.id !== 'string' || inv.id.trim() === '') {
      recordViolation({
        kind: 'CORRUPTED_IDENTIFIER',
        entityId: inv.id || 'unknown',
        message: 'Invoice record is missing a valid primary identifier.',
        details: { record: inv },
        remediation: 'Generate a standard UUIDv4 identifier and update primary key before ingestion.',
      });
      continue;
    }

    if (invoiceMap.has(inv.id)) {
      recordViolation({
        kind: 'CORRUPTED_IDENTIFIER',
        entityId: inv.id,
        message: `Duplicate invoice identifier detected: ${inv.id}`,
        details: { invoiceId: inv.id },
        remediation: 'De-duplicate records keeping the most recent revision by updatedAt.',
      });
    } else {
      invoiceMap.set(inv.id, inv);
    }

    // Duplicate Memo constraint
    if (inv.memo) {
      if (memoMap.has(inv.memo)) {
        recordViolation({
          kind: 'DUPLICATE_MEMO',
          entityId: inv.id,
          message: `Settlement memo conflict: memo "${inv.memo}" is shared with invoice ${memoMap.get(inv.memo)}.`,
          details: { memo: inv.memo, conflictingInvoiceId: memoMap.get(inv.memo) },
          remediation: 'Renumber memo on pending invoice or reconcile settlement reference against Horizon.',
        });
      } else {
        memoMap.set(inv.memo, inv.id);
      }
    }

    // Status Incoherence
    const validStatuses: InvoiceStatus[] = ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'];
    if (!validStatuses.includes(inv.status)) {
      recordViolation({
        kind: 'STATUS_INCOHERENCE',
        entityId: inv.id,
        message: `Unrecognized invoice status: "${inv.status}".`,
        details: { status: inv.status },
        remediation: 'Map status to PENDING, PAID, EXPIRED, or CANCELLED based on on-chain proof.',
      });
    }

    if (inv.status === 'PAID') {
      if (!inv.paidAt) {
        recordViolation({
          kind: 'STATUS_INCOHERENCE',
          entityId: inv.id,
          message: `Invoice marked PAID without paidAt settlement timestamp.`,
          details: { invoiceId: inv.id, status: inv.status },
          remediation: 'Reconcile transaction timestamp against linked on-chain payment and backfill paidAt.',
        });
      }
      if (!inv.paymentTxHash) {
        recordViolation({
          kind: 'STATUS_INCOHERENCE',
          entityId: inv.id,
          message: `Invoice marked PAID without paymentTxHash audit reference.`,
          details: { invoiceId: inv.id },
          remediation: 'Backfill 64-char hex paymentTxHash from transaction table or re-verify on Horizon.',
        });
      }
    } else {
      if (inv.paidAt) {
        recordViolation({
          kind: 'STATUS_INCOHERENCE',
          entityId: inv.id,
          message: `Invoice status is ${inv.status} but carries settlement timestamp paidAt.`,
          details: { status: inv.status, paidAt: inv.paidAt },
          remediation: 'Either complete transition to PAID or clear invalid paidAt timestamp.',
        });
      }
    }

    // Financial Invariants
    if (typeof inv.amount !== 'number' || inv.amount <= 0 || !Number.isFinite(inv.amount)) {
      recordViolation({
        kind: 'FINANCIAL_MISMATCH',
        entityId: inv.id,
        message: `Invalid or non-positive invoice amount: ${inv.amount}`,
        details: { amount: inv.amount },
        remediation: 'Correct amount from signed purchase order or seller invoice contract.',
      });
    }

    if (!inv.assetCode || typeof inv.assetCode !== 'string') {
      recordViolation({
        kind: 'FINANCIAL_MISMATCH',
        entityId: inv.id,
        message: 'Invoice is missing asset code.',
        details: { assetCode: inv.assetCode },
        remediation: 'Set assetCode to native XLM or approved Stellar issued asset.',
      });
    }

    // Temporal Invariants
    if (inv.createdAt && inv.expiresAt) {
      const created = new Date(inv.createdAt).getTime();
      const expires = new Date(inv.expiresAt).getTime();
      if (expires <= created) {
        recordViolation({
          kind: 'TEMPORAL_ANOMALY',
          entityId: inv.id,
          message: `Invoice expiration (${inv.expiresAt}) is not after creation (${inv.createdAt}).`,
          details: { createdAt: inv.createdAt, expiresAt: inv.expiresAt },
          remediation: 'Reset expiresAt to standard policy (createdAt + 7 days).',
        });
      }
    }
  }

  // 2. Evaluate Relational Invariants (Transactions & Events)
  const transactions = snapshot.transactions || [];
  for (const tx of transactions) {
    if (tx.invoice_id && !invoiceMap.has(tx.invoice_id)) {
      recordViolation({
        kind: 'ORPHANED_RELATION',
        entityId: tx.id,
        message: `Transaction references missing invoice: ${tx.invoice_id}`,
        details: { transactionId: tx.id, invoiceId: tx.invoice_id, txHash: tx.tx_hash },
        remediation: 'Restore missing invoice record or link transaction by memo match.',
      });
    }

    if (tx.invoice_id && invoiceMap.has(tx.invoice_id)) {
      const targetInvoice = invoiceMap.get(tx.invoice_id)!;
      if (typeof tx.amount === 'number' && targetInvoice.amount !== tx.amount) {
        recordViolation({
          kind: 'FINANCIAL_MISMATCH',
          entityId: tx.invoice_id,
          message: `Invoice amount (${targetInvoice.amount}) disagrees with transaction settlement (${tx.amount}).`,
          details: { invoiceAmount: targetInvoice.amount, txAmount: tx.amount, txHash: tx.tx_hash },
          remediation: 'Audit on-chain transaction value; adjust invoice amount or flag under/over-payment.',
        });
      }
    }
  }

  for (const ev of snapshot.payment_events || []) {
    if (ev.invoice_id && !invoiceMap.has(ev.invoice_id)) {
      recordViolation({
        kind: 'ORPHANED_RELATION',
        entityId: ev.id,
        message: `Payment event references missing invoice: ${ev.invoice_id}`,
        details: { eventId: ev.id, invoiceId: ev.invoice_id, eventType: ev.event_type },
        remediation: 'Re-associate event with correct invoice or purge orphaned event log.',
      });
    }
  }

  // 3. Rebuild Derived Views
  const rebuiltSearchIndex = rebuildDerivedSearchIndex(snapshot.invoices || []);
  const rebuiltStats = rebuildDerivedStats(snapshot.invoices || []);

  // 4. Verify Derived View / Index Parity against Snapshot State (if provided)
  if (snapshot.existingSearchIndexRecords && snapshot.existingSearchIndexRecords.length > 0) {
    const existingIndexMap = new Map<string, IndexedInvoiceRecord>();
    for (const rec of snapshot.existingSearchIndexRecords) {
      existingIndexMap.set(rec.id, rec);
    }

    // Check for missing items in existing index
    for (const [id, inv] of invoiceMap.entries()) {
      const indexed = existingIndexMap.get(id);
      if (!indexed) {
        recordViolation({
          kind: 'DERIVED_INDEX_DRIFT',
          entityId: id,
          message: `Invoice ${id} is present in snapshot truth but absent from derived search index.`,
          details: { invoiceId: id, status: inv.status },
          remediation: 'Execute search index rebuild: defaultSearchIndex.indexInvoice(invoice).',
        });
      } else if (indexed.status !== inv.status) {
        recordViolation({
          kind: 'DERIVED_INDEX_DRIFT',
          entityId: id,
          message: `Search index status drift on ${id}: index shows [${indexed.status}], storage truth is [${inv.status}].`,
          details: { indexStatus: indexed.status, storageStatus: inv.status },
          remediation: 'Synchronize index projection with storage truth using repairStaleIndex().',
        });
      }
    }

    // Check for orphaned index records
    for (const [id] of existingIndexMap.entries()) {
      if (!invoiceMap.has(id)) {
        recordViolation({
          kind: 'DERIVED_INDEX_DRIFT',
          entityId: id,
          message: `Search index contains orphaned entry ${id} not found in restored snapshot data.`,
          details: { indexId: id },
          remediation: 'Purge orphaned entry from search index using defaultSearchIndex.purge(id).',
        });
      }
    }
  }

  // 5. Construct Operator Action Plan
  const actionPlan: string[] = [];
  if (violations.length === 0) {
    actionPlan.push('All critical data invariants hold. Derived search index and financial stats rebuilt successfully.');
    actionPlan.push('Restore package verified safe for production traffic.');
  } else {
    actionPlan.push(`CRITICAL: Detected ${violations.length} invariant violation(s). Restore MUST NOT be marked ready.`);
    const uniqueKinds = Array.from(new Set(violations.map((v) => v.kind)));
    for (const kind of uniqueKinds) {
      const count = violationsByKind[kind];
      actionPlan.push(`- [${kind}] ${count} violation(s). Follow remediation instructions per record.`);
    }
    actionPlan.push('Run "npm run db:validate-restore" or "npm run ops:repair-projections" after applying fixes.');
  }

  const report: SnapshotVerificationReport = {
    timestamp,
    ok: violations.length === 0,
    totalInvoicesEvaluated: (snapshot.invoices || []).length,
    totalTransactionsEvaluated: transactions.length,
    totalEventsEvaluated: (snapshot.payment_events || []).length,
    totalViolations: violations.length,
    violationsByKind,
    violations,
    rebuiltViews: {
      searchIndex: rebuiltSearchIndex,
      totalIndexed: rebuiltSearchIndex.size(),
      stats: rebuiltStats,
    },
    operatorActionPlan: actionPlan,
  };

  return report;
}

/**
 * Formats the snapshot verification report into a loud human-readable operator string.
 */
export function formatSnapshotVerificationReport(report: SnapshotVerificationReport): string {
  const lines: string[] = [];
  lines.push('================================================================');
  lines.push('           INQUTUM SNAPSHOT RESTORE VERIFICATION REPORT         ');
  lines.push('================================================================');
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Evaluated: ${report.totalInvoicesEvaluated} invoices, ${report.totalTransactionsEvaluated} transactions, ${report.totalEventsEvaluated} events`);
  lines.push(`Overall Status: ${report.ok ? '✅ PASS (RESTORE VERIFIED)' : '❌ FAIL (INVARIANTS VIOLATED)'}`);
  lines.push('');

  lines.push('--- REBUILT DERIVED VIEWS ---');
  lines.push(`Rebuilt Search Index Records: ${report.rebuiltViews.totalIndexed}`);
  lines.push(`Rebuilt Invoice Stats: Total=${report.rebuiltViews.stats.totalInvoices}, Pending=${report.rebuiltViews.stats.pendingCount}, Paid=${report.rebuiltViews.stats.paidCount}, Expired=${report.rebuiltViews.stats.expiredCount}, Cancelled=${report.rebuiltViews.stats.cancelledCount}`);
  lines.push(`Rebuilt Revenue by Asset: ${JSON.stringify(report.rebuiltViews.stats.revenueByAsset)}`);
  lines.push('');

  if (report.violations.length > 0) {
    lines.push('--- INVARIANT VIOLATIONS ---');
    for (const v of report.violations) {
      lines.push(`[FAIL] ${v.kind} (Entity: ${v.entityId})`);
      lines.push(`       Message: ${v.message}`);
      lines.push(`       Remediation: ${v.remediation}`);
      lines.push(`       Details: ${JSON.stringify(v.details)}`);
      lines.push('');
    }
  }

  lines.push('--- OPERATOR ACTION PLAN ---');
  for (const step of report.operatorActionPlan) {
    lines.push(step);
  }
  lines.push('================================================================');
  return lines.join('\n');
}
