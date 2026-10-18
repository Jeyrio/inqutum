import { v4 as uuidv4 } from 'uuid';
import { calculateInvoiceStats } from './invoice-stats';
import type { InvoiceStats } from './invoice-stats';
import { isPendingInvoiceExpired } from '../domain/invoice-expiry';
import type { StoredInvoice } from './invoice-storage';
import { checkVersion } from '../concurrency/optimistic-lock';

type Invoice = StoredInvoice;

class MemoryStorage {
  private invoices: Map<string, Invoice> = new Map();
  private invoicesByMemo: Map<string, string> = new Map(); // memo -> invoice id
  private invoicesByExternalId: Map<string, string> = new Map(); // external_id -> invoice id (#53)
  // Which invoice each transaction hash settled; see domain/payment-attribution.ts.
  private readonly paymentClaims = new PaymentClaimIndex();
  private paymentEvents: MemoryPaymentEvent[] = [];
  // State-change events (created / cancelled / expired). Kept apart from
  // paymentEvents, which callers read as "payment activity only"; the audit
  // trail below presents the two as one ordered history.
  private lifecycleEvents: MemoryPaymentEvent[] = [];

  createInvoice(data: Partial<Invoice>): Invoice {
    const id = data.id || uuidv4();
    if (this.invoices.has(id)) {
      throw new Error(`Duplicate invoice ID collision: ${id}`);
    }
    if (data.memo && this.invoicesByMemo.has(data.memo)) {
      throw new Error(`Duplicate invoice memo collision: ${data.memo}`);
    }

    const invoice: Invoice = {
      id,
      sellerPublicKey: data.sellerPublicKey!,
      sellerName: data.sellerName,
      sellerEmail: data.sellerEmail,
      amount: data.amount!,
      assetCode: (data.assetCode || 'XLM').toUpperCase(),
      assetIssuer: data.assetIssuer,
      memo: data.memo!,
      // Caller import key (issue #53). Must be copied here, not only read by the
      // index below, or getInvoiceByExternalId cannot return the stored invoice.
      externalId: data.externalId,
      description: data.description,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: data.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      metadata: data.metadata,
      version: 1,
    };

    // The memo index is keyed by memo, so a second invoice carrying the same
    // memo would overwrite the first one's entry and leave it unreachable by
    // the payment monitor. Refuse instead, and let creation draw another memo.
    if (this.invoicesByMemo.has(invoice.memo)) {
      throw new MemoCollisionError(invoice.memo);
    }

    this.invoices.set(invoice.id, invoice);
    this.invoicesByMemo.set(invoice.memo, invoice.id);
    // Index the caller import key so a re-import matches this invoice instead
    // of creating a second one (issue #53).
    if (invoice.externalId) {
      this.invoicesByExternalId.set(invoice.externalId, invoice.id);
    }
    this.recordLifecycleEvent(invoice.id, 'INVOICE_CREATED', { to: 'PENDING' });

    if (process.env.NODE_ENV !== 'test') {
      console.log('✅ Invoice created in memory:', invoice.id);
    }
    return invoice;
  }

  // Get invoice by ID
  getInvoiceById(id: string): Invoice | undefined {
    this.markExpiredInvoices();
    return this.invoices.get(id);
  }

  // Get invoice by memo
  getInvoiceByMemo(memo: string): Invoice | undefined {
    this.markExpiredInvoices();
    const id = this.invoicesByMemo.get(memo);
    return id ? this.invoices.get(id) : undefined;
  }

  /** Read-only memo lookup, without the expiry sweep getInvoiceByMemo runs. */
  /**
   * Get invoice by import key (issue #53). Intentionally skips the expiry
   * sweep so import dry runs stay write-free, matching getInvoiceByExternalId
   * on the Postgres backend.
   */
  getInvoiceByExternalId(externalId: string): Invoice | undefined {
    const id = this.invoicesByExternalId.get(externalId);
    return id ? this.invoices.get(id) : undefined;
  }

  /**
   * Descriptive-field patch only (issue #53). Mirrors the Postgres backend:
   * amount, asset, seller, status and payment columns are not patchable.
   */
  updateInvoiceMutableFields(
    id: string,
    patch: {
      description?: string;
      customerName?: string;
      customerEmail?: string;
      sellerName?: string;
      sellerEmail?: string;
    }
  ): Invoice | undefined {
    const allowed: Array<keyof typeof patch> = [
      'description',
      'customerName',
      'customerEmail',
      'sellerName',
      'sellerEmail',
    ];
    const updates: Partial<Invoice> = {};
    for (const field of allowed) {
      if (patch[field] !== undefined) {
        (updates as Record<string, unknown>)[field] = patch[field];
      }
    }
    return this.updateInvoice(id, updates);
  }

  hasMemo(memo: string): boolean {
    return this.invoicesByMemo.has(memo);
  }

  /** Read-only claim lookup, for diagnostics and tests. */
  getPaymentClaim(txHash: string): PaymentClaim | undefined {
    return this.paymentClaims.peek(txHash);
  }

  // Update invoice
  updateInvoice(id: string, updates: Partial<Invoice>, expectedVersion?: number): Invoice | undefined {
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;

    checkVersion(expectedVersion, invoice.version ?? 1);

    const updated = { ...invoice, ...updates, version: (invoice.version ?? 1) + 1 };
    this.invoices.set(id, updated);

    console.log('✅ Invoice updated:', id);
    return updated;
  }

  // Cancel invoice
  cancelInvoice(id: string, sellerPublicKey?: string): Invoice | undefined {
    this.markExpiredInvoices();
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;
    if (sellerPublicKey && invoice.sellerPublicKey !== sellerPublicKey) {
      throw new Error('Unauthorized: only the seller can cancel this invoice');
    }
    const to = assertTransition(invoice.status, 'CANCEL');
    const updated = this.updateInvoice(id, { status: to, cancelledAt: new Date() });
    if (updated) {
      this.recordLifecycleEvent(id, 'INVOICE_CANCELLED', {
        from: invoice.status,
        to,
        actor: sellerPublicKey,
      });
    }
    return updated;
  }

  // Mark as paid
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: { payerName?: string; payerEmail?: string },
    expectedVersion?: number
  ): Invoice | undefined {
    this.markExpiredInvoices();
    const now = new Date();
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;
    // PENDING settles on time, CANCELLED settles late; every other state
    // (PAID, EXPIRED) is refused by the lifecycle, so a replay or a payment
    // that lost the race to expiry is rejected the same way in every store.
    const event: InvoiceEvent = invoice.status === 'CANCELLED' ? 'SETTLE_AFTER_CANCEL' : 'SETTLE';
    const to = assertTransition(invoice.status, event);
    if (invoice.status === 'PENDING' && new Date(invoice.expiresAt).getTime() <= now.getTime()) {
      throw new InvalidTransitionError('EXPIRED', to, event);
    }

    for (const existing of this.invoices.values()) {
      if (existing.id !== id && existing.paymentTxHash && existing.paymentTxHash === txHash) {
        throw new Error(`Duplicate payment_tx_hash collision: ${txHash}`);
      }
    }

    return this.updateInvoice(id, {
      status: 'PAID',
      paymentTxHash: txHash,
      payerPublicKey,
      payerName: payerInfo?.payerName,
      payerEmail: payerInfo?.payerEmail,
      paidAt: new Date(),
    }, expectedVersion);
  }

  // Get all invoices
  getAllInvoices(filter?: { status?: string }): Invoice[] {
    this.markExpiredInvoices();
    let invoices = Array.from(this.invoices.values());

    if (filter?.status) {
      invoices = invoices.filter(inv => inv.status === filter.status);
    }

    return invoices.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // Get stats
  getStats(sellerPublicKey: string): InvoiceStats {
    this.markExpiredInvoices();
    return calculateInvoiceStats(Array.from(this.invoices.values()), sellerPublicKey);
  }

  // Mark expired invoices
  /** Overdue PENDING invoices, without transitioning them. */
  findOverduePending(cutoff: Date): Invoice[] {
    return Array.from(this.invoices.values())
      .filter((invoice) => isPendingInvoiceExpired(invoice, cutoff))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  }

  markExpiredInvoices(now: Date = new Date()): number {
    let count = 0;

    this.invoices.forEach((invoice) => {
      if (isPendingInvoiceExpired(invoice, now)) {
        const from = invoice.status;
        invoice.status = assertTransition(from, 'EXPIRE');
        this.recordLifecycleEvent(invoice.id, 'INVOICE_EXPIRED', { from, to: invoice.status });
        count++;
      }
    });

    if (count > 0) {
      console.log(`⏰ Marked ${count} invoices as expired`);
    }

    return count;
  }

  /**
   * Records a payment lifecycle audit event in memory.
   */
  logPaymentEvent(invoiceId: string, eventType: string, eventData: any): void {
    this.paymentEvents.push({
      id: uuidv4(),
      invoiceId,
      eventType,
      eventData,
      createdAt: new Date(),
    });
  }

  /** Records a state change in the audit trail. */
  private recordLifecycleEvent(invoiceId: string, eventType: string, eventData: any): void {
    this.lifecycleEvents.push({
      id: uuidv4(),
      invoiceId,
      eventType,
      eventData,
      createdAt: new Date(),
    });
  }

  /**
   * Read-only copies of every invoice. Unlike getAllInvoices this does not run
   * the expiry sweep, so it never changes what a reconciliation reports on.
   */
  snapshotInvoices(): Invoice[] {
    return Array.from(this.invoices.values()).map((invoice) => ({ ...invoice }));
  }

  /** Every state-change and payment event, oldest first. */
  snapshotAuditEvents(): AuditEvent[] {
    return [...this.lifecycleEvents, ...this.paymentEvents]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((event) => ({ ...event, eventData: event.eventData ?? null }));
  }

  /** Stats without the expiry sweep getStats applies. */
  readStats(sellerPublicKey: string): InvoiceStats {
    return calculateInvoiceStats(this.snapshotInvoices(), sellerPublicKey);
  }

  /**
   * Full audit trail for one invoice: state changes and payment events in the
   * order they happened. Matches what `payment_events` holds for Postgres.
   */
  getAuditTrail(invoiceId: string): AuditEvent[] {
    return [...this.lifecycleEvents, ...this.paymentEvents]
      .filter((event) => event.invoiceId === invoiceId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((event) => ({ ...event, eventData: event.eventData ?? null }));
  }

  /**
   * Retrieves payment audit events, optionally filtered by invoice ID.
   */
  getPaymentEvents(invoiceId?: string): MemoryPaymentEvent[] {
    if (invoiceId) {
      return this.paymentEvents.filter((event) => event.invoiceId === invoiceId);
    }
    return [...this.paymentEvents];
  }

  // Clear all data (for testing)
  clear() {
    this.invoices.clear();
    this.invoicesByMemo.clear();
    this.invoicesByExternalId.clear();
    this.paymentClaims.clear();
    this.paymentEvents = [];
    this.lifecycleEvents = [];
    console.log('🗑️ Memory storage cleared');
  }

  // Get size
  size(): number {
    return this.invoices.size;
  }

  countInvoices(): number {
    return this.invoices.size;
  }

  /**
   * Purges old settled, cancelled, or expired demo invoices older than maxAgeHours.
   * Guarantees active, unexpired pending invoices are preserved.
   */
  purgeStaleInvoices(options: { maxAgeHours: number; statuses?: InvoiceStatus[] }): number {
    const maxAgeMs = options.maxAgeHours * 3600 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    const allowedStatuses = new Set<InvoiceStatus>(options.statuses || ['PAID', 'EXPIRED', 'CANCELLED']);
    let purgedCount = 0;

    for (const [id, invoice] of this.invoices.entries()) {
      const isPending = invoice.status === 'PENDING';
      const isExpired = invoice.expiresAt.getTime() <= Date.now();
      const isEligibleStatus = allowedStatuses.has(invoice.status) || (isPending && isExpired);

      if (invoice.createdAt.getTime() <= cutoff && isEligibleStatus) {
        this.invoices.delete(id);
        this.invoicesByMemo.delete(invoice.memo);
        purgedCount++;
      }
    }

    return purgedCount;
  }
}

export { MemoryStorage };
export default new MemoryStorage();
