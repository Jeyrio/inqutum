import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  verifySnapshotRestore,
  rebuildDerivedSearchIndex,
  rebuildDerivedStats,
  formatSnapshotVerificationReport,
  type SnapshotPackage,
} from '../src/db/snapshot-restore-verification';
import type { StoredInvoice } from '../src/storage/invoice-storage';

describe('Snapshot restore verification for critical data and derived indexes (Issue #263)', () => {
  const validInvoice1: StoredInvoice = {
    id: 'inv-valid-1',
    sellerPublicKey: 'GSELLER111111111111111111111111111111111111111111111111111',
    amount: 100,
    assetCode: 'USDC',
    memo: 'MEMO-001',
    status: 'PAID',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:15:00Z'),
    paidAt: new Date('2026-10-01T10:15:00Z'),
    expiresAt: new Date('2026-10-08T10:00:00Z'),
    paymentTxHash: '11'.repeat(32),
    version: 2,
  };

  const validInvoice2: StoredInvoice = {
    id: 'inv-valid-2',
    sellerPublicKey: 'GSELLER111111111111111111111111111111111111111111111111111',
    amount: 50,
    assetCode: 'XLM',
    memo: 'MEMO-002',
    status: 'PENDING',
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date('2026-10-01T12:00:00Z'),
    expiresAt: new Date('2026-10-08T12:00:00Z'),
    version: 1,
  };

  it('passes verification and rebuilds derived views for coherent snapshot package', () => {
    const pkg: SnapshotPackage = {
      invoices: [validInvoice1, validInvoice2],
      transactions: [
        {
          id: 'tx-1',
          invoice_id: validInvoice1.id,
          tx_hash: validInvoice1.paymentTxHash!,
          amount: 100,
          asset_code: 'USDC',
        },
      ],
      payment_events: [
        {
          id: 'evt-1',
          invoice_id: validInvoice1.id,
          event_type: 'SETTLEMENT_CONFIRMED',
        },
      ],
    };

    const report = verifySnapshotRestore(pkg);

    assert.equal(report.ok, true);
    assert.equal(report.totalViolations, 0);
    assert.equal(report.violations.length, 0);

    // Assert derived views rebuilt
    assert.equal(report.rebuiltViews.totalIndexed, 2);
    assert.equal(report.rebuiltViews.stats.totalInvoices, 2);
    assert.equal(report.rebuiltViews.stats.paidCount, 1);
    assert.equal(report.rebuiltViews.stats.pendingCount, 1);
    assert.equal(report.rebuiltViews.stats.revenueByAsset['USDC'], 100);
    assert.equal(report.rebuiltViews.stats.revenueByAsset['XLM'], undefined);

    const formatted = formatSnapshotVerificationReport(report);
    assert.match(formatted, /PASS \(RESTORE VERIFIED\)/);
  });

  it('fails loudly on status incoherence (PAID invoice missing paidAt or paymentTxHash)', () => {
    const brokenPaidInvoice: StoredInvoice = {
      ...validInvoice1,
      id: 'inv-broken-paid',
      memo: 'MEMO-BROKEN',
      paidAt: undefined, // Missing timestamp
      paymentTxHash: undefined, // Missing tx hash
    };

    const report = verifySnapshotRestore({
      invoices: [brokenPaidInvoice],
    });

    assert.equal(report.ok, false);
    assert.ok(report.violationsByKind.STATUS_INCOHERENCE >= 2);
    const messages = report.violations.map((v) => v.message).join(' ');
    assert.match(messages, /paidAt settlement timestamp/);
    assert.match(messages, /paymentTxHash audit reference/);
    assert.ok(report.operatorActionPlan.length > 0);
  });

  it('fails loudly on financial mismatch between invoice amount and transaction settlement', () => {
    const report = verifySnapshotRestore({
      invoices: [validInvoice1],
      transactions: [
        {
          id: 'tx-mismatch',
          invoice_id: validInvoice1.id,
          tx_hash: validInvoice1.paymentTxHash!,
          amount: 80, // Invoice is 100, transaction is 80
        },
      ],
    });

    assert.equal(report.ok, false);
    assert.equal(report.violationsByKind.FINANCIAL_MISMATCH, 1);
    assert.match(report.violations[0].message, /agrees with transaction settlement/);
    assert.match(report.violations[0].remediation, /Audit on-chain transaction value/);
  });

  it('detects orphaned relations in transactions and payment events', () => {
    const report = verifySnapshotRestore({
      invoices: [validInvoice2],
      transactions: [
        {
          id: 'tx-orphaned',
          invoice_id: 'non-existent-invoice-id',
          tx_hash: '99'.repeat(32),
        },
      ],
      payment_events: [
        {
          id: 'evt-orphaned',
          invoice_id: 'another-missing-invoice',
          event_type: 'PAYMENT_RECEIVED',
        },
      ],
    });

    assert.equal(report.ok, false);
    assert.equal(report.violationsByKind.ORPHANED_RELATION, 2);
  });

  it('detects settlement memo collision across invoices', () => {
    const duplicateMemoInvoice: StoredInvoice = {
      ...validInvoice2,
      id: 'inv-dup-memo',
      memo: validInvoice1.memo, // Shared memo!
    };

    const report = verifySnapshotRestore({
      invoices: [validInvoice1, duplicateMemoInvoice],
    });

    assert.equal(report.ok, false);
    assert.equal(report.violationsByKind.DUPLICATE_MEMO, 1);
    assert.match(report.violations[0].message, /Settlement memo conflict/);
  });

  it('detects derived index drift when snapshot projection does not match restored truth', () => {
    const staleIndexRecord = {
      id: validInvoice1.id,
      sellerPublicKey: validInvoice1.sellerPublicKey,
      amount: validInvoice1.amount,
      assetCode: validInvoice1.assetCode,
      memo: validInvoice1.memo,
      status: 'PENDING' as const, // DRIFT: storage is PAID, index is PENDING
      visibility: 'INTERNAL' as const,
      indexedAt: new Date(),
      updatedAt: new Date(),
      isDeleted: false,
    };

    const report = verifySnapshotRestore({
      invoices: [validInvoice1],
      existingSearchIndexRecords: [staleIndexRecord],
    });

    assert.equal(report.ok, false);
    assert.equal(report.violationsByKind.DERIVED_INDEX_DRIFT, 1);
    assert.match(report.violations[0].message, /Search index status drift/);
    assert.match(report.violations[0].remediation, /repairStaleIndex/);
  });
});
