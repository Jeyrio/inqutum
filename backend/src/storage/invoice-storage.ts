import { CreateInvoiceInput } from '../utils/validation';
import type {
  LatePaymentWarningCode,
  SettlementContext,
} from '../domain/invoice-settlement';
import type { InvoiceStats } from './invoice-stats';
import type {
  AuditEvent as AuditLogEvent,
  AuditFilter,
  AuditQueryResult,
} from '../audit/audit-service';
import type {
  ReconciliationInvoice,
  ReconciliationSettlement,
} from '../domain/reconciliation';

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

/**
 * One row of an invoice's own history: a state change or payment event that
 * affected the user or their funds. Backed by `payment_events` in Postgres and
 * an in-process list in the memory store. Distinct from the hash-chained
 * operator audit log in `audit/audit-service.ts`.
 */
export interface AuditEvent {
  id: string;
  invoiceId: string;
  eventType: string;
  eventData: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * How a payment settles an invoice. Both are optional and independent:
 * `settledAt` is the Horizon ledger close time (required to settle a CANCELLED
 * invoice late, and recorded on every settlement); `expectedVersion` is the
 * optimistic-lock token from a prior read.
 */
export interface MarkAsPaidOptions {
  settledAt?: Date;
  expectedVersion?: number;
}

/** `sellerPublicKey` restricts the cancel to that seller; `expectedVersion` is the lock token. */
export interface CancelInvoiceOptions {
  sellerPublicKey?: string;
  expectedVersion?: number;
}

/** Callers predating the options object pass a bare version number. */
export type MarkAsPaidOptionsInput = MarkAsPaidOptions | number;
/** Callers pass a seller key (ownership) or a version number (lock), or both as an object. */
export type CancelInvoiceOptionsInput = CancelInvoiceOptions | string | number;

export function normalizeMarkAsPaidOptions(input?: MarkAsPaidOptionsInput): MarkAsPaidOptions {
  if (typeof input === 'number') return { expectedVersion: input };
  return input ?? {};
}

export function normalizeCancelOptions(input?: CancelInvoiceOptionsInput): CancelInvoiceOptions {
  if (typeof input === 'number') return { expectedVersion: input };
  if (typeof input === 'string') return input ? { sellerPublicKey: input } : {};
  return input ?? {};
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
   * Read-only lookup by import key (issue #53).
   *
   * Unlike getInvoiceById this MUST NOT apply the lazy expiry transition:
   * import dry runs resolve every row through this method and are required to
   * perform no persistent writes.
   */
  getInvoiceByExternalId(externalId: string): Promise<StoredInvoice | null>;
  /**
   * Patch only the descriptive fields of an existing invoice (issue #53).
   * Financial and lifecycle columns are deliberately not patchable. Returns
   * null when the invoice does not exist.
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
  ): Promise<StoredInvoice | null>;
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
  /** PENDING -> CANCELLED. Records `cancelledAt` and an INVOICE_CANCELLED event. */
  cancelInvoice(id: string, options?: CancelInvoiceOptionsInput): Promise<StoredInvoice>;
  /**
   * PENDING -> PAID on time, or CANCELLED -> PAID late (SETTLE_AFTER_CANCEL)
   * when a ledger `settledAt` is known. Records the settlement fields and a
   * PAYMENT_CONFIRMED event; honours `expectedVersion` when given.
   */
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: PayerInfo,
    options?: MarkAsPaidOptionsInput
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

  /** Returns total count of invoices currently stored. */
  countInvoices?(): Promise<number>;
  /** Purges expired or historical settled demo invoices older than maxAgeHours. */
  purgeStaleInvoices?(options: { maxAgeHours: number; statuses?: InvoiceStatus[] }): Promise<number>;
  /** The invoice's own history (`payment_events`), oldest first. */
  getAuditTrail(invoiceId: string): Promise<AuditEvent[]>;

  // --- Read-only access for reconciliation (docs/RECONCILIATION.md) ---
  //
  // Every other read here applies the expiry sweep first, which *writes*. These
  // never write: a reconciliation that changed the data it is checking could
  // not report stale records, and could not be run against production safely.

  /** Every invoice exactly as stored, with amounts kept exact. */
  listInvoicesForReconciliation(): Promise<ReconciliationInvoice[]>;
  /** Every invoice history event, oldest first. */
  listAuditEvents(): Promise<AuditEvent[]>;
  /** Same figures as getInvoiceStats, without the expiry sweep. */
  readInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]>;
  /** Settlement references held apart from the invoice rows, or null if this backend keeps none. */
  listSettlements(): Promise<ReconciliationSettlement[] | null>;

  // Operator audit log (audit/audit-service.ts)
  recordAuditEvent?(event: Omit<AuditLogEvent, 'id' | 'timestamp'> & { timestamp?: string }): Promise<AuditLogEvent>;
  getAuditEvents?(filter?: AuditFilter): Promise<AuditQueryResult>;
  getAuditEventsByInvoice?(invoiceId: string): Promise<AuditLogEvent[]>;
}
