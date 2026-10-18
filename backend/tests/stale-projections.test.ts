import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StaleProjectionService } from '../src/ops/stale-projections.service.ts';
import { PermissionAwareSearchIndex } from '../src/services/search-index.service.ts';
import type { StoredInvoice, InvoiceStorage } from '../src/storage/invoice-storage.ts';

const SELLER = 'G' + 'C'.repeat(55);

function makeInvoice(id: string, overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id,
    sellerPublicKey: SELLER,
    amount: 100,
    assetCode: 'XLM',
    memo: `MEMO-${id}`,
    status: 'PENDING',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    ...overrides,
  };
}

function createMockStorage(invoices: StoredInvoice[]): InvoiceStorage {
  const map = new Map<string, StoredInvoice>();
  for (const inv of invoices) {
    map.set(inv.id, { ...inv });
  }

  return {
    mode: 'postgres',
    async getAllInvoices() {
      return Array.from(map.values()).map((i) => ({ ...i }));
    },
    async getInvoiceById(id: string) {
      const found = map.get(id);
      return found ? { ...found } : null;
    },
    async createInvoice(data: any) {
      const inv = makeInvoice(data.id || 'mock', data);
      map.set(inv.id, inv);
      return inv;
    },
    async updateInvoice(id: string, patch: any) {
      const existing = map.get(id);
      if (!existing) throw new Error('Not found');
      const updated = { ...existing, ...patch };
      map.set(id, updated);
      return updated;
    },
    async markAsPaid(id: string, txHash: string, payerKey: string) {
      const existing = map.get(id);
      if (!existing) throw new Error('Not found');
      const updated = { ...existing, status: 'PAID' as const, paymentTxHash: txHash, payerPublicKey: payerKey };
      map.set(id, updated);
      return updated;
    },
    async deleteInvoice(id: string) {
      map.delete(id);
    },
    async getInvoicesBySeller() {
      return [];
    },
    async getInvoices() {
      return { invoices: Array.from(map.values()), total: map.size, limit: 50, offset: 0 };
    },
  } as unknown as InvoiceStorage;
}

describe('Stale projection detection and repair contract (Issue #269)', () => {
  it('reports healthy status when projections perfectly match storage truth', async () => {
    const inv1 = makeInvoice('inv-1', { status: 'PENDING' });
    const inv2 = makeInvoice('inv-2', { status: 'PAID' });
    const storage = createMockStorage([inv1, inv2]);

    const searchIndex = new PermissionAwareSearchIndex();
    searchIndex.indexInvoice(inv1);
    searchIndex.indexInvoice(inv2);

    const service = new StaleProjectionService();
    const report = await service.detect(storage, searchIndex);

    assert.equal(report.healthy, true);
    assert.equal(report.totalAnomalies, 0);
    assert.equal(report.recommendations.length, 0);
  });

  it('detects status drift, missing projections, and orphaned records with operator evidence', async () => {
    const inv1 = makeInvoice('inv-drift', { status: 'PAID' }); // Storage has PAID
    const inv2 = makeInvoice('inv-missing', { status: 'PENDING' }); // Storage has it, index doesn't
    const storage = createMockStorage([inv1, inv2]);

    const searchIndex = new PermissionAwareSearchIndex();
    // Index has inv-drift as PENDING (status drift)
    searchIndex.indexInvoice({ ...inv1, status: 'PENDING' });
    // Index has orphaned record not present in storage
    searchIndex.indexInvoice(makeInvoice('inv-orphan', { status: 'PENDING' }));

    const service = new StaleProjectionService();
    const report = await service.detect(storage, searchIndex);

    assert.equal(report.healthy, false);
    assert.equal(report.totalAnomalies, 3);
    assert.equal(report.anomaliesByType.STATUS_DRIFT, 1);
    assert.equal(report.anomaliesByType.MISSING_PROJECTION, 1);
    assert.equal(report.anomaliesByType.ORPHANED_PROJECTION, 1);

    // Verify recommendations
    assert.equal(report.recommendations.length, 1);
    const rec = report.recommendations[0];
    assert.equal(rec.target, 'search_index');
    assert.equal(rec.recommendedAction, 'IMMEDIATE_REPAIR');
    assert.ok(rec.justification.includes('3 projection desynchronizations'));

    // Check operator evidence
    const driftItem = report.anomalies.find((a) => a.anomalyType === 'STATUS_DRIFT');
    assert.ok(driftItem);
    assert.equal(driftItem?.severity, 'CRITICAL', 'PAID invoice marked PENDING in index must be CRITICAL');
    assert.match(driftItem!.evidence, /storage is \[PAID\] but projection is \[PENDING\]/);
  });

  it('executes immediate automated repair and produces complete operator evidence log', async () => {
    const inv1 = makeInvoice('inv-drift', { status: 'PAID' });
    const inv2 = makeInvoice('inv-missing', { status: 'PENDING' });
    const storage = createMockStorage([inv1, inv2]);

    const searchIndex = new PermissionAwareSearchIndex();
    searchIndex.indexInvoice({ ...inv1, status: 'PENDING' });
    searchIndex.indexInvoice(makeInvoice('inv-orphan', { status: 'PENDING' }));

    const service = new StaleProjectionService();
    const evidence = await service.repair(storage, searchIndex, { mode: 'immediate' });

    assert.equal(evidence.mode, 'immediate');
    assert.equal(evidence.purgedOrphans, 1);
    assert.equal(evidence.indexedMissing, 1);
    assert.equal(evidence.syncedDrift, 1);
    assert.equal(evidence.totalRepaired, 3);
    assert.equal(evidence.remainingAnomalies, 0);

    // Verify operator log contains evidence entries
    assert.ok(evidence.operatorEvidenceLog.some((l) => l.includes('Purged 1 orphaned projection')));
    assert.ok(evidence.operatorEvidenceLog.some((l) => l.includes('Indexed 1 missing record')));
    assert.ok(evidence.operatorEvidenceLog.some((l) => l.includes('Updated 1 outdated status')));

    // Verify index is now completely synchronized
    const searchResults = searchIndex.search('', { role: 'ADMIN' });
    assert.equal(searchResults.length, 2);
    const ids = searchResults.map((r) => r.id);
    assert.ok(ids.includes('inv-drift'));
    assert.ok(ids.includes('inv-missing'));
    assert.ok(!ids.includes('inv-orphan'));

    const drifted = searchResults.find((r) => r.id === 'inv-drift');
    assert.equal(drifted?.status, 'PAID');
  });

  it('supports queued repair execution without blocking', async () => {
    const storage = createMockStorage([makeInvoice('inv-1')]);
    const searchIndex = new PermissionAwareSearchIndex();

    const service = new StaleProjectionService();
    const evidence = await service.repair(storage, searchIndex, { mode: 'queued' });

    assert.equal(evidence.mode, 'queued');
    assert.ok(evidence.operatorEvidenceLog.some((l) => l.includes('Queued background reconciliation job')));
  });
});
