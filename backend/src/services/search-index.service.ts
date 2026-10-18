import type { StoredInvoice, InvoiceStatus } from '../storage/invoice-storage';

export type VisibilityLevel = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'REVOKED';

export interface IndexedInvoiceRecord {
  id: string;
  sellerPublicKey: string;
  customerEmail?: string;
  amount: number;
  assetCode: string;
  description?: string;
  memo: string;
  status: InvoiceStatus;
  visibility: VisibilityLevel;
  indexedAt: Date;
  updatedAt: Date;
  isDeleted: boolean;
}

export type SearchRole = 'ADMIN' | 'SELLER' | 'VIEWER' | 'ANONYMOUS';

export interface SearchActor {
  actorId?: string;
  role: SearchRole;
  walletAddress?: string;
}

export interface StaleIndexRepairResult {
  indexedMissing: number;
  purgedStale: number;
  updatedOutdated: number;
}

export class PermissionAwareSearchIndex {
  private index: Map<string, IndexedInvoiceRecord> = new Map();

  /**
   * Index or update an invoice with an explicit visibility constraint.
   */
  public indexInvoice(
    invoice: StoredInvoice,
    visibility: VisibilityLevel = 'INTERNAL'
  ): IndexedInvoiceRecord {
    const existing = this.index.get(invoice.id);
    const now = new Date();

    const record: IndexedInvoiceRecord = {
      id: invoice.id,
      sellerPublicKey: invoice.sellerPublicKey,
      customerEmail: invoice.customerEmail,
      amount: invoice.amount,
      assetCode: invoice.assetCode,
      description: invoice.description,
      memo: invoice.memo,
      status: invoice.status,
      visibility: existing ? existing.visibility : visibility,
      indexedAt: existing ? existing.indexedAt : now,
      updatedAt: now,
      isDeleted: false,
    };

    this.index.set(invoice.id, record);
    return record;
  }

  /**
   * Mutation hook: update record visibility.
   */
  public setVisibility(invoiceId: string, visibility: VisibilityLevel): boolean {
    const record = this.index.get(invoiceId);
    if (!record) return false;

    record.visibility = visibility;
    record.updatedAt = new Date();
    return true;
  }

  /**
   * Mutation hook: mark an index record deleted or removed.
   */
  public removeIndexRecord(invoiceId: string): boolean {
    const record = this.index.get(invoiceId);
    if (!record) return false;

    record.isDeleted = true;
    record.updatedAt = new Date();
    return true;
  }

  /**
   * Hard purge from memory index (used by repair jobs).
   */
  public purge(invoiceId: string): boolean {
    return this.index.delete(invoiceId);
  }

  /** Copies of every record, including deleted and revoked ones. O(n). */
  public exportRecords(): IndexedInvoiceRecord[] {
    return [...this.index.values()].map((record) => ({ ...record }));
  }

  /**
   * Replaces the whole index in one synchronous step, so no reader observes a
   * half-swapped projection (#290). O(n).
   */
  public replaceAll(records: readonly IndexedInvoiceRecord[]): void {
    this.index = new Map(records.map((record) => [record.id, { ...record }]));
  }

  /**
   * Retrieve total number of active non-deleted records in index.
   */
  public size(): number {
    let count = 0;
    for (const r of this.index.values()) {
      if (!r.isDeleted) count++;
    }
    return count;
  }

  /**
   * Execute a search query with strict role-based and visibility-based boundaries.
   */
  public search(query: string, actor: SearchActor): IndexedInvoiceRecord[] {
    const normalizedQuery = query.trim().toLowerCase();
    const results: IndexedInvoiceRecord[] = [];

    for (const record of this.index.values()) {
      if (record.isDeleted || record.visibility === 'REVOKED') {
        continue;
      }

      // Check permission visibility
      if (!this.canActorAccessRecord(actor, record)) {
        continue;
      }

      // Query filter matching description, memo, assetCode, customerEmail, or id
      if (normalizedQuery) {
        const matches =
          record.id.toLowerCase().includes(normalizedQuery) ||
          record.memo.toLowerCase().includes(normalizedQuery) ||
          record.assetCode.toLowerCase().includes(normalizedQuery) ||
          (record.description && record.description.toLowerCase().includes(normalizedQuery)) ||
          (record.customerEmail && record.customerEmail.toLowerCase().includes(normalizedQuery));

        if (!matches) continue;
      }

      results.push({ ...record });
    }

    return results;
  }

  /**
   * Evaluates if the given actor is permitted to discover and view the record.
   */
  public canActorAccessRecord(actor: SearchActor, record: IndexedInvoiceRecord): boolean {
    if (record.visibility === 'REVOKED' || record.isDeleted) {
      return false;
    }

    if (actor.role === 'ADMIN') {
      return true;
    }

    if (record.visibility === 'PUBLIC') {
      return true;
    }

    if (actor.role === 'SELLER') {
      if (actor.walletAddress && record.sellerPublicKey === actor.walletAddress) {
        return true;
      }
      return record.visibility === 'INTERNAL';
    }

    if (actor.role === 'VIEWER') {
      return record.visibility === 'INTERNAL';
    }

    // ANONYMOUS users can only see PUBLIC records
    return false;
  }

  /**
   * Automated stale-index repair job.
   * Compares the indexed records against storage truth to prune orphaned entries,
   * index missing records, and synchronize mutated statuses.
   */
  public repairStaleIndex(actualInvoices: StoredInvoice[]): StaleIndexRepairResult {
    let indexedMissing = 0;
    let purgedStale = 0;
    let updatedOutdated = 0;

    const actualMap = new Map<string, StoredInvoice>();
    for (const inv of actualInvoices) {
      actualMap.set(inv.id, inv);
    }

    // 1. Detect and purge stale/orphaned index entries
    for (const [id, record] of Array.from(this.index.entries())) {
      const source = actualMap.get(id);
      if (!source) {
        this.index.delete(id);
        purgedStale++;
      } else {
        if (record.status !== source.status) {
          record.status = source.status;
          record.updatedAt = new Date();
          updatedOutdated++;
        }
      }
    }

    // 2. Index missing storage invoices
    for (const [id, inv] of actualMap.entries()) {
      if (!this.index.has(id)) {
        this.indexInvoice(inv, 'INTERNAL');
        indexedMissing++;
      }
    }

    return { indexedMissing, purgedStale, updatedOutdated };
  }
}

export const defaultSearchIndex = new PermissionAwareSearchIndex();
