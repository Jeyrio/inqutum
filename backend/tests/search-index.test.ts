import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionAwareSearchIndex } from '../src/services/search-index.service';
import type { StoredInvoice } from '../src/storage/invoice-storage';

function createMockInvoice(id: string, overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id,
    sellerPublicKey: 'GBDEV7PX5J7GBLH3J7KSLQOEXAMPLENOTAREALKEY7777777777777777',
    amount: 100,
    assetCode: 'XLM',
    memo: `MEMO-${id}`,
    description: `Test Invoice ${id}`,
    customerEmail: `customer-${id}@example.com`,
    status: 'PENDING',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    ...overrides,
  };
}

describe('Permission-Aware Search Index & Stale Repair (Issue #87)', () => {
  it('prevents anonymous actors from discovering confidential or internal invoices', () => {
    const index = new PermissionAwareSearchIndex();

    const publicInv = createMockInvoice('inv-pub', { description: 'Public payment receipt' });
    const internalInv = createMockInvoice('inv-int', { description: 'Internal merchant receipt' });
    const confidentialInv = createMockInvoice('inv-conf', { description: 'Confidential corporate audit' });

    index.indexInvoice(publicInv, 'PUBLIC');
    index.indexInvoice(internalInv, 'INTERNAL');
    index.indexInvoice(confidentialInv, 'CONFIDENTIAL');

    // Anonymous query
    const anonResults = index.search('receipt', { role: 'ANONYMOUS' });
    assert.strictEqual(anonResults.length, 1);
    assert.strictEqual(anonResults[0].id, 'inv-pub');

    // Admin query sees all
    const adminResults = index.search('', { role: 'ADMIN' });
    assert.strictEqual(adminResults.length, 3);
  });

  it('allows sellers to view their own confidential invoices but not other sellers confidential invoices', () => {
    const index = new PermissionAwareSearchIndex();

    const sellerKeyA = 'GBDEV7PX5J7GBLH3J7KSLQOEXAMPLENOTAREALKEY777777777777777A';
    const sellerKeyB = 'GBDEV7PX5J7GBLH3J7KSLQOEXAMPLENOTAREALKEY777777777777777B';

    const invA = createMockInvoice('inv-a', { sellerPublicKey: sellerKeyA });
    const invB = createMockInvoice('inv-b', { sellerPublicKey: sellerKeyB });

    index.indexInvoice(invA, 'CONFIDENTIAL');
    index.indexInvoice(invB, 'CONFIDENTIAL');

    const sellerAResults = index.search('', {
      role: 'SELLER',
      walletAddress: sellerKeyA,
    });

    assert.strictEqual(sellerAResults.length, 1);
    assert.strictEqual(sellerAResults[0].id, 'inv-a');
  });

  it('excludes revoked or deleted records from search results immediately', () => {
    const index = new PermissionAwareSearchIndex();
    const inv = createMockInvoice('inv-revoked', { description: 'Revoked invoice' });
    index.indexInvoice(inv, 'PUBLIC');

    let results = index.search('revoked', { role: 'ANONYMOUS' });
    assert.strictEqual(results.length, 1);

    // Revoke
    index.setVisibility('inv-revoked', 'REVOKED');
    results = index.search('revoked', { role: 'ADMIN' });
    assert.strictEqual(results.length, 0);

    // Reinstate and delete
    index.setVisibility('inv-revoked', 'PUBLIC');
    index.removeIndexRecord('inv-revoked');
    results = index.search('revoked', { role: 'ADMIN' });
    assert.strictEqual(results.length, 0);
  });

  it('repairs stale, orphaned, and missing index records against storage state', () => {
    const index = new PermissionAwareSearchIndex();

    const validInv1 = createMockInvoice('valid-1', { status: 'PENDING' });
    const validInv2 = createMockInvoice('valid-2', { status: 'PAID' });
    const missingInStorage = createMockInvoice('orphaned-1');

    index.indexInvoice(validInv1, 'INTERNAL');
    index.indexInvoice(missingInStorage, 'INTERNAL');

    // Current storage has validInv1 and validInv2, but missingInStorage was deleted from DB
    const actualInvoicesInStorage = [
      { ...validInv1, status: 'PAID' as const }, // status updated in DB
      validInv2, // newly created in DB
    ];

    const repairSummary = index.repairStaleIndex(actualInvoicesInStorage);

    assert.strictEqual(repairSummary.purgedStale, 1); // orphaned-1 purged
    assert.strictEqual(repairSummary.indexedMissing, 1); // valid-2 added
    assert.strictEqual(repairSummary.updatedOutdated, 1); // valid-1 status synced to PAID

    const searchResults = index.search('', { role: 'ADMIN' });
    assert.strictEqual(searchResults.length, 2);
    const foundIds = searchResults.map((r) => r.id);
    assert.ok(foundIds.includes('valid-1'));
    assert.ok(foundIds.includes('valid-2'));
    assert.ok(!foundIds.includes('orphaned-1'));
  });
});
