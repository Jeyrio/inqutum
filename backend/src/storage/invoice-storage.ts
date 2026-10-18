import { CreateInvoiceInput } from '../utils/validation';
import type {
  LatePaymentWarningCode,
  SettlementContext,
} from '../domain/invoice-settlement';
import type { InvoiceStats } from './invoice-stats';
import type { AuditEvent, AuditFilter, AuditQueryResult } from '../audit/audit-service';

// Shared shape and shared storage contract. Both MemoryInvoiceStorage and
// PostgresInvoiceStorage implement these methods with the same semantics,
// and every invoice they return is the StoredInvoice type below. Behaviour
// parity (expiry guard on normal markAsPaid, cancel-aware late settlement,
// single-transition PENDING->CANCELLED, lazy
// markExpiredInvoices on all reads, strict seller_public_key scoping on list
// and stats, and audit trail capture) is pinned by the shared test suite in invoice-handlers.test.ts.
import type { InvoiceCursor } from './invoice-cursor';

export type InvoiceStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'];

// Invoice shape shared by both storage backends.
export interface StoredInvoice {
  id: string;
  userId?: string;
  sellerPublicKey: string;
  sellerName?: string;
  sellerEmail?: string;
  amount: number;
  /** Asset code for the invoice (e.g., 'XLM' or 'USDC'). */
  assetCode: string;
  /** Issuer public key for credit assets (omitted for native XLM). */
  assetIssuer?: string;
  memo: string;
  /** Caller-supplied import key (issue #53). Unique where present. */
  externalId?: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
  status: InvoiceStatus;
  paymentTxHash?: string;
  payerPublicKey?: string;
  payerName?: string;
  payerEmail?: string;
  createdAt: Date;
  paidAt?: Date;
  cancelledAt?: Date;
  settledAt?: Date;
  settlementContext?: SettlementContext;
  priorStatus?: InvoiceStatus;
  latePaymentWarningCode?: LatePaymentWarningCode;
  expiresAt: Date;
  metadata?: any;
  /** Schema version stamp. Absent on records created before versioning. */
  _schemaVersion?: string;
  /** Optimistic concurrency token. Incremented on every state change. */
  version?: number;
}

export interface PayerInfo {
  payerName?: string;
  payerEmail?: string;
}

export interface OverduePendingInvoices {
  total: number;
  /** Oldest expiry first. */
  invoices: Array<Pick<StoredInvoice, 'id' | 'sellerPublicKey' | 'expiresAt'>>;
}

/**
 * Storage adapter the shared invoice handlers run against.
 *
 * Both implementations are wallet-scoped: the seller public key always comes
 * from the invoice input or the caller's query, never from a static env key.
 */
export interface InvoiceStorage {
  /** Reported by /api/health so a running server tells you which backend it uses. */
  readonly mode: string;

  createInvoice(input: CreateInvoiceInput): Promise<StoredInvoice>;
  getInvoiceById(id: string): Promise<StoredInvoice | null>;
  /**
   * Newest first by (createdAt, id). Pass `after` for keyset pagination;
   * `offset` is kept for older clients and is unstable under inserts.
   */
  getInvoicesBySeller(
    sellerPublicKey: string,
    status?: string,
    limit?: number,
    offset?: number,
    after?: InvoiceCursor
  ): Promise<StoredInvoice[]>;
  cancelInvoice(id: string, expectedVersion?: number): Promise<StoredInvoice>;
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: PayerInfo,
    expectedVersion?: number
  ): Promise<StoredInvoice>;
  getInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]>;
  /** Explicit maintenance hook; reads also apply this transition lazily. */
  markExpiredInvoices(now?: Date): Promise<number>;
  /**
   * Read-only drift check for the ops report: PENDING invoices whose expiry is
   * at or before `cutoff`. Must not apply the lazy expiry transition.
   */
  findOverduePendingInvoices(cutoff: Date, limit: number): Promise<OverduePendingInvoices>;
  /** Retrieve all stored invoices for operations, diagnostics, and policy simulations */
  getAllInvoices?(filter?: { status?: string }): Promise<StoredInvoice[]>;

  // Audit trail methods
  recordAuditEvent?(event: Omit<AuditEvent, 'id' | 'timestamp'> & { timestamp?: string }): Promise<AuditEvent>;
  getAuditEvents?(filter?: AuditFilter): Promise<AuditQueryResult>;
  getAuditEventsByInvoice?(invoiceId: string): Promise<AuditEvent[]>;
}
