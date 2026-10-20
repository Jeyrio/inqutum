/**
 * Notifications for critical invoice lifecycle and recovery events (issue #56).
 *
 * Design:
 *  - Recipients are wallet public keys, the same identity every invoice route
 *    already scopes by. A notification is only ever readable by its recipient.
 *  - Notifications carry only non-sensitive facts (invoice id, amount, asset,
 *    memo, status). Customer/payer names and emails are never copied in.
 *  - Every notification has a deterministic dedup key. Emitting the same
 *    logical event again (request retry, repeated reads, worker replay) is a
 *    no-op, so a critical event notifies exactly once.
 *  - Emission is derived from invoice state (`syncInvoiceNotifications`), so it
 *    also catches transitions that happen inside storage, such as expiry.
 */

import { v4 as uuidv4 } from 'uuid';
import type { StoredInvoice } from '../storage/invoice-storage';
import type { VerificationCode } from '../services/payment-verification';
import { recordAuditEvent } from '../audit/record-event';
import type { AuditActor } from '../audit/audit-service';
import {
  evaluateNotificationRouting,
  MemoryNotificationPreferenceStore,
  notificationPreferencePatchSchema,
  overriddenMandatoryCategories,
  type NotificationCategory,
  type NotificationPreferencePatch,
  type NotificationPreferenceStore,
  type RecipientNotificationPreferences,
  type RoutingAuditRecord,
} from './notification-preference';

export type NotificationType =
  | 'invoice.paid'
  | 'invoice.expired'
  | 'invoice.cancelled'
  | 'payment.rejected'
  | 'security.alert'
  | 'invoice.reminder'
  | 'marketing.digest';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface Notification {
  id: string;
  recipient: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  /** App-relative path to the workflow that needs attention. */
  deepLink: string;
  dedupKey: string;
  entityId: string;
  data: Record<string, string | number>;
  createdAt: string;
  readAt: string | null;
}

/** One accepted preference edit, as handed to the audit sink. */
export interface PreferenceChange {
  recipient: string;
  changedBy: AuditActor;
  before: RecipientNotificationPreferences;
  after: RecipientNotificationPreferences;
  /** Mandatory categories now switched off; their alerts are still delivered. */
  overriddenMandatoryCategories: NotificationCategory[];
  correlationId?: string;
}

export type PreferenceChangeSink = (change: PreferenceChange) => void;

/** Default sink: the process-wide hash-chained audit trail. */
export const auditPreferenceChange: PreferenceChangeSink = (change) => {
  recordAuditEvent({
    action: 'NOTIFICATION_PREFERENCES_UPDATED',
    actor: change.changedBy,
    scope: { entityType: 'notification_preferences', entityId: change.recipient },
    beforeState: { channels: change.before.channels, categories: change.before.categories },
    afterState: { channels: change.after.channels, categories: change.after.categories },
    metadata: { overriddenMandatoryCategories: change.overriddenMandatoryCategories },
    correlationId: change.correlationId,
  });
};

export interface NotificationQuery {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationPage {
  notifications: Notification[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
}

/** Verification failures the seller can act on (recovery path), not payer typos. */
export const RECOVERABLE_REJECTIONS: ReadonlySet<VerificationCode> = new Set<VerificationCode>([
  'AMOUNT_MISMATCH',
  'ASSET_MISMATCH',
  'MEMO_MISMATCH',
  'DESTINATION_MISMATCH',
  'NETWORK_MISMATCH',
  'NO_PAYMENT_OPERATION',
]);

const REJECTION_ADVICE: Partial<Record<VerificationCode, string>> = {
  AMOUNT_MISMATCH: 'A payment was submitted with the wrong amount. Ask the payer to send the remaining or corrected amount, or cancel and reissue the invoice.',
  ASSET_MISMATCH: 'A payment was submitted in a different asset than invoiced. Ask the payer to pay in the invoiced asset.',
  MEMO_MISMATCH: 'A payment referenced this invoice but the memo did not match. Ask the payer to resend with the invoice memo.',
  DESTINATION_MISMATCH: 'A payment referenced this invoice but was sent to a different account.',
  NETWORK_MISMATCH: 'A payment was submitted on a different Stellar network than this invoice uses.',
  NO_PAYMENT_OPERATION: 'A transaction referenced this invoice but contained no payment operation.',
};

const MAX_PAGE = 100;
const NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'invoice.paid',
  'invoice.expired',
  'invoice.cancelled',
  'payment.rejected',
  'security.alert',
  'invoice.reminder',
  'marketing.digest',
]);
const NOTIFICATION_SEVERITIES: ReadonlySet<NotificationSeverity> = new Set([
  'info',
  'success',
  'warning',
  'critical',
]);

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`notification ${field} must be a non-empty string`);
  }
}

function validateNotification(n: Notification): void {
  requireNonEmptyString(n.id, 'id');
  requireNonEmptyString(n.recipient, 'recipient');
  requireNonEmptyString(n.title, 'title');
  requireNonEmptyString(n.message, 'message');
  requireNonEmptyString(n.deepLink, 'deepLink');
  requireNonEmptyString(n.dedupKey, 'dedupKey');
  requireNonEmptyString(n.entityId, 'entityId');

  if (!NOTIFICATION_TYPES.has(n.type)) {
    throw new Error(`unsupported notification type: ${n.type}`);
  }
  if (!NOTIFICATION_SEVERITIES.has(n.severity)) {
    throw new Error(`unsupported notification severity: ${n.severity}`);
  }
  if (!n.data || typeof n.data !== 'object' || Array.isArray(n.data)) {
    throw new Error('notification data must be an object');
  }
  if (Number.isNaN(Date.parse(n.createdAt))) {
    throw new Error('notification createdAt must be an ISO timestamp');
  }
  if (n.readAt !== null && Number.isNaN(Date.parse(n.readAt))) {
    throw new Error('notification readAt must be null or an ISO timestamp');
  }
}

export class MemoryNotificationStore {
  private byId = new Map<string, Notification>();
  private byDedup = new Map<string, string>();
  private byRecipient = new Map<string, string[]>();

  /** Returns the existing notification (created=false) if the dedup key was already used. */
  insert(n: Notification): { notification: Notification; created: boolean } {
    validateNotification(n);

    const existingId = this.byDedup.get(n.dedupKey);
    if (existingId) return { notification: this.byId.get(existingId)!, created: false };
    this.byId.set(n.id, n);
    this.byDedup.set(n.dedupKey, n.id);
    const ids = this.byRecipient.get(n.recipient) ?? [];
    ids.push(n.id);
    this.byRecipient.set(n.recipient, ids);
    return { notification: n, created: true };
  }

  listForRecipient(recipient: string): Notification[] {
    return (this.byRecipient.get(recipient) ?? []).map((id) => this.byId.get(id)!).reverse();
  }

  findByDedupKey(dedupKey: string): Notification | undefined {
    const id = this.byDedup.get(dedupKey);
    return id ? this.byId.get(id) : undefined;
  }

  getForRecipient(recipient: string, id: string): Notification | undefined {
    const n = this.byId.get(id);
    return n && n.recipient === recipient ? n : undefined;
  }

  clear(): void {
    this.byId.clear();
    this.byDedup.clear();
    this.byRecipient.clear();
  }
}

export class NotificationService {
  constructor(
    private readonly store = new MemoryNotificationStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly preferenceStore: NotificationPreferenceStore = new MemoryNotificationPreferenceStore(),
    private readonly onPreferenceChange: PreferenceChangeSink = auditPreferenceChange
  ) {}

  private emit(
    input: Pick<Notification, 'recipient' | 'type' | 'severity' | 'title' | 'message' | 'entityId' | 'data'> & { dedupKey: string }
  ): { notification: Notification | null; created: boolean; suppressed?: boolean; routingReason?: string } {
    // A replayed event (every invoice read re-syncs) was already routed and
    // audited once. Evaluating it again would add a routing record pointing at
    // a notification id that is never stored.
    const existing = this.store.findByDedupKey(input.dedupKey);
    if (existing) return { notification: existing, created: false, suppressed: false };

    const id = uuidv4();
    const prefs = this.preferenceStore.getPreferences(input.recipient);
    const evaluation = evaluateNotificationRouting(
      { id, type: input.type, recipient: input.recipient },
      prefs
    );

    // Record auditable routing decision
    this.preferenceStore.recordAudit({
      id: uuidv4(),
      notificationId: id,
      recipient: input.recipient,
      type: input.type,
      urgency: evaluation.urgency,
      decision: evaluation.decision,
      reason: evaluation.reason,
      activeChannels: evaluation.activeChannels,
      evaluatedAt: this.now().toISOString(),
      metadata: { ...input.data },
    });

    // If suppressed by user preferences, do not insert into notification feed
    if (!evaluation.deliver) {
      return {
        notification: null,
        created: false,
        suppressed: true,
        routingReason: evaluation.reason,
      };
    }

    const notificationData = {
      ...input.data,
      ...(evaluation.reason === 'MANDATORY_OVERRIDE' ? { mandatoryOverride: 'true' } : {}),
    };

    const inserted = this.store.insert({
      id,
      ...input,
      data: notificationData,
      deepLink: `/invoice/${encodeURIComponent(input.entityId)}`,
      createdAt: this.now().toISOString(),
      readAt: null,
    });

    return {
      notification: inserted.notification,
      created: inserted.created,
      suppressed: false,
      routingReason: evaluation.reason,
    };
  }

  /**
   * Emits the notification implied by the invoice's current status, if any.
   * Safe to call on every read or retry: each event is created at most once.
   */
  syncInvoiceNotifications(invoice: StoredInvoice): Notification | null {
    const facts = {
      invoiceId: invoice.id,
      amount: invoice.amount,
      assetCode: invoice.assetCode,
      memo: invoice.memo,
    };
    const label = `${invoice.amount} ${invoice.assetCode}`;
    const base = { recipient: invoice.sellerPublicKey, entityId: invoice.id, data: facts };

    switch (invoice.status) {
      case 'PAID':
        return this.emit({ ...base, type: 'invoice.paid', severity: 'success', dedupKey: `${invoice.id}:invoice.paid`, title: 'Invoice paid', message: `Payment of ${label} was verified for invoice ${invoice.memo}.` }).notification;
      case 'EXPIRED':
        return this.emit({ ...base, type: 'invoice.expired', severity: 'warning', dedupKey: `${invoice.id}:invoice.expired`, title: 'Invoice expired', message: `Invoice ${invoice.memo} (${label}) expired unpaid. Create a new invoice to collect payment.` }).notification;
      case 'CANCELLED':
        return this.emit({ ...base, type: 'invoice.cancelled', severity: 'info', dedupKey: `${invoice.id}:invoice.cancelled`, title: 'Invoice cancelled', message: `Invoice ${invoice.memo} (${label}) was cancelled.` }).notification;
      default:
        return null;
    }
  }

  /** Recovery notification for a payment attempt the seller may need to resolve. */
  notifyPaymentRejected(invoice: StoredInvoice, code: VerificationCode, txHash: string): Notification | null {
    if (!RECOVERABLE_REJECTIONS.has(code)) return null;
    return this.emit({
      recipient: invoice.sellerPublicKey,
      entityId: invoice.id,
      type: 'payment.rejected',
      severity: 'critical',
      dedupKey: `${invoice.id}:payment.rejected:${txHash}:${code}`,
      title: 'Payment needs attention',
      message: REJECTION_ADVICE[code] ?? 'A payment attempt for this invoice was rejected.',
      data: { invoiceId: invoice.id, memo: invoice.memo, code, txHash },
    }).notification;
  }

  /** Optional notification: Payment reminder for an open invoice */
  notifyInvoiceReminder(invoice: StoredInvoice): Notification | null {
    const facts = {
      invoiceId: invoice.id,
      amount: invoice.amount,
      assetCode: invoice.assetCode,
      memo: invoice.memo,
    };
    return this.emit({
      recipient: invoice.sellerPublicKey,
      entityId: invoice.id,
      type: 'invoice.reminder',
      severity: 'info',
      dedupKey: `${invoice.id}:invoice.reminder:${new Date().toISOString().slice(0, 10)}`,
      title: 'Invoice payment reminder',
      message: `Friendly reminder: Invoice ${invoice.memo} for ${invoice.amount} ${invoice.assetCode} is pending payment.`,
      data: facts,
    }).notification;
  }

  /** Mandatory security alert notification */
  notifySecurityAlert(
    recipient: string,
    title: string,
    message: string,
    data: Record<string, string | number> = {}
  ): Notification | null {
    return this.emit({
      recipient,
      entityId: recipient,
      type: 'security.alert',
      severity: 'critical',
      dedupKey: `${recipient}:security.alert:${Date.now()}`,
      title,
      message,
      data,
    }).notification;
  }

  getPreferences(recipient: string): RecipientNotificationPreferences {
    return this.preferenceStore.getPreferences(recipient);
  }

  /**
   * Applies a validated preference patch. Throws a ZodError for an invalid
   * patch, so callers outside the HTTP route cannot store unknown keys either.
   * Every accepted edit is reported to the preference-change sink, attributed
   * to `changedBy` (the recipient's own wallet when no actor is given).
   */
  savePreferences(
    recipient: string,
    patch: NotificationPreferencePatch,
    context: { changedBy?: AuditActor; correlationId?: string } = {}
  ): RecipientNotificationPreferences {
    const validated = notificationPreferencePatchSchema.parse(patch);
    const before = this.preferenceStore.getPreferences(recipient);
    const after = this.preferenceStore.savePreferences(recipient, validated);
    this.onPreferenceChange({
      recipient,
      changedBy: context.changedBy ?? { type: 'seller', id: recipient },
      before,
      after,
      overriddenMandatoryCategories: overriddenMandatoryCategories(after),
      correlationId: context.correlationId,
    });
    return after;
  }

  getRoutingAudit(recipient: string): RoutingAuditRecord[] {
    return this.preferenceStore.getAuditRecords(recipient);
  }

  list(recipient: string, query: NotificationQuery = {}): NotificationPage {
    const all = this.store.listForRecipient(recipient);
    const filtered = query.unreadOnly ? all.filter((n) => !n.readAt) : all;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(query.offset ?? 0, 0);
    return {
      notifications: filtered.slice(offset, offset + limit),
      total: filtered.length,
      unread: all.filter((n) => !n.readAt).length,
      limit,
      offset,
    };
  }

  unreadCount(recipient: string): number {
    return this.store.listForRecipient(recipient).filter((n) => !n.readAt).length;
  }

  /** Returns null for unknown ids AND for other recipients' ids, so existence never leaks. */
  markRead(recipient: string, id: string): Notification | null {
    const n = this.store.getForRecipient(recipient, id);
    if (!n) return null;
    if (!n.readAt) n.readAt = this.now().toISOString();
    return n;
  }

  markAllRead(recipient: string): number {
    let changed = 0;
    for (const n of this.store.listForRecipient(recipient)) {
      if (!n.readAt) {
        n.readAt = this.now().toISOString();
        changed += 1;
      }
    }
    return changed;
  }

  clear(): void {
    this.store.clear();
    this.preferenceStore.clear();
  }
}

export const notificationService = new NotificationService();
