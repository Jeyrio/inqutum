/**
 * Durable notification preferences and mandatory-alert routing model (Issue #268).
 *
 * Requirements:
 *  - Recipients (Stellar public keys) can configure channel and category preferences.
 *  - Mandatory lifecycle & security alerts CANNOT be suppressed by user preferences.
 *  - Optional notifications (reminders, digests) respect user preferences.
 *  - All routing decisions (delivered, suppressed, mandatory override) are auditable.
 */

import { stellarPublicKeySchema } from '../utils/validation';

export type NotificationChannel = 'in_app' | 'email';

export type NotificationCategory =
  | 'invoice_lifecycle'
  | 'payment_recovery'
  | 'security_alert'
  | 'payment_reminder'
  | 'marketing_digest';

export type NotificationUrgency = 'mandatory' | 'optional';

export interface RecipientNotificationPreferences {
  recipient: string;
  channels: {
    in_app: boolean;
    email: boolean;
  };
  categories: {
    invoice_lifecycle: boolean;
    payment_recovery: boolean;
    security_alert: boolean;
    payment_reminder: boolean;
    marketing_digest: boolean;
  };
  updatedAt: string;
}

export interface RoutingAuditRecord {
  id: string;
  notificationId: string;
  recipient: string;
  type: string;
  urgency: NotificationUrgency;
  decision: 'DELIVERED' | 'SUPPRESSED';
  reason: 'MANDATORY_OVERRIDE' | 'PREFERENCE_ACCEPTED' | 'SUPPRESSED_BY_PREFERENCE';
  activeChannels: NotificationChannel[];
  evaluatedAt: string;
  metadata?: Record<string, unknown>;
}

export const MANDATORY_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'invoice.paid',
  'invoice.expired',
  'invoice.cancelled',
  'payment.rejected',
  'security.alert',
  'recovery.failure',
]);

export const OPTIONAL_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'invoice.reminder',
  'invoice.viewed',
  'marketing.digest',
  'account.tip',
]);

export function getNotificationUrgency(type: string): NotificationUrgency {
  if (MANDATORY_NOTIFICATION_TYPES.has(type)) {
    return 'mandatory';
  }
  return 'optional';
}

export function getNotificationCategory(type: string): NotificationCategory {
  switch (type) {
    case 'invoice.paid':
    case 'invoice.expired':
    case 'invoice.cancelled':
      return 'invoice_lifecycle';
    case 'payment.rejected':
    case 'recovery.failure':
      return 'payment_recovery';
    case 'security.alert':
      return 'security_alert';
    case 'invoice.reminder':
      return 'payment_reminder';
    case 'marketing.digest':
    case 'account.tip':
    default:
      return 'marketing_digest';
  }
}

export function createDefaultPreferences(recipient: string): RecipientNotificationPreferences {
  const parsed = stellarPublicKeySchema.safeParse(recipient);
  if (!parsed.success) {
    throw new Error('recipient must be a valid Stellar public key');
  }

  return {
    recipient: parsed.data,
    channels: {
      in_app: true,
      email: true,
    },
    categories: {
      invoice_lifecycle: true,
      payment_recovery: true,
      security_alert: true,
      payment_reminder: true,
      marketing_digest: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

export interface NotificationPreferenceStore {
  getPreferences(recipient: string): RecipientNotificationPreferences;
  savePreferences(
    recipient: string,
    patch: {
      channels?: Partial<RecipientNotificationPreferences['channels']>;
      categories?: Partial<RecipientNotificationPreferences['categories']>;
    }
  ): RecipientNotificationPreferences;
  recordAudit(record: RoutingAuditRecord): void;
  getAuditRecords(recipient: string): RoutingAuditRecord[];
  clear(): void;
}

export class MemoryNotificationPreferenceStore implements NotificationPreferenceStore {
  private preferences = new Map<string, RecipientNotificationPreferences>();
  private auditLog = new Map<string, RoutingAuditRecord[]>();

  getPreferences(recipient: string): RecipientNotificationPreferences {
    const existing = this.preferences.get(recipient);
    if (existing) return { ...existing, channels: { ...existing.channels }, categories: { ...existing.categories } };
    const defaults = createDefaultPreferences(recipient);
    this.preferences.set(recipient, defaults);
    return { ...defaults, channels: { ...defaults.channels }, categories: { ...defaults.categories } };
  }

  savePreferences(
    recipient: string,
    patch: {
      channels?: Partial<RecipientNotificationPreferences['channels']>;
      categories?: Partial<RecipientNotificationPreferences['categories']>;
    }
  ): RecipientNotificationPreferences {
    const current = this.getPreferences(recipient);
    const updated: RecipientNotificationPreferences = {
      recipient,
      channels: {
        ...current.channels,
        ...(patch.channels || {}),
      },
      categories: {
        ...current.categories,
        ...(patch.categories || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    this.preferences.set(recipient, updated);
    return { ...updated, channels: { ...updated.channels }, categories: { ...updated.categories } };
  }

  recordAudit(record: RoutingAuditRecord): void {
    const list = this.auditLog.get(record.recipient) ?? [];
    list.push(record);
    this.auditLog.set(record.recipient, list);
  }

  getAuditRecords(recipient: string): RoutingAuditRecord[] {
    return (this.auditLog.get(recipient) ?? []).map((r) => ({ ...r }));
  }

  clear(): void {
    this.preferences.clear();
    this.auditLog.clear();
  }
}

export interface RoutingEvaluationResult {
  deliver: boolean;
  urgency: NotificationUrgency;
  decision: 'DELIVERED' | 'SUPPRESSED';
  reason: 'MANDATORY_OVERRIDE' | 'PREFERENCE_ACCEPTED' | 'SUPPRESSED_BY_PREFERENCE';
  activeChannels: NotificationChannel[];
}

export function evaluateNotificationRouting(
  notification: { id: string; type: string; recipient: string },
  preferences: RecipientNotificationPreferences
): RoutingEvaluationResult {
  const urgency = getNotificationUrgency(notification.type);
  const category = getNotificationCategory(notification.type);

  // Mandatory notifications bypass category and channel opt-outs for in-app delivery
  if (urgency === 'mandatory') {
    const activeChannels: NotificationChannel[] = ['in_app'];
    if (preferences.channels.email) {
      activeChannels.push('email');
    }

    const wasUserOptedOut =
      !preferences.categories[category] || !preferences.channels.in_app;

    return {
      deliver: true,
      urgency,
      decision: 'DELIVERED',
      reason: wasUserOptedOut ? 'MANDATORY_OVERRIDE' : 'PREFERENCE_ACCEPTED',
      activeChannels,
    };
  }

  // Optional notifications respect category preference and channels
  const categoryAllowed = preferences.categories[category];
  if (!categoryAllowed) {
    return {
      deliver: false,
      urgency,
      decision: 'SUPPRESSED',
      reason: 'SUPPRESSED_BY_PREFERENCE',
      activeChannels: [],
    };
  }

  const activeChannels: NotificationChannel[] = [];
  if (preferences.channels.in_app) activeChannels.push('in_app');
  if (preferences.channels.email) activeChannels.push('email');

  if (activeChannels.length === 0) {
    return {
      deliver: false,
      urgency,
      decision: 'SUPPRESSED',
      reason: 'SUPPRESSED_BY_PREFERENCE',
      activeChannels: [],
    };
  }

  return {
    deliver: true,
    urgency,
    decision: 'DELIVERED',
    reason: 'PREFERENCE_ACCEPTED',
    activeChannels,
  };
}
