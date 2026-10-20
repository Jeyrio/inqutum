/**
 * Durable notification preferences and mandatory-alert routing model (Issue #268).
 *
 * Requirements:
 *  - Recipients (Stellar public keys) can configure channel and category preferences.
 *  - Mandatory lifecycle & security alerts CANNOT be suppressed by user preferences.
 *  - Optional notifications (reminders, digests) respect user preferences.
 *  - All routing decisions (delivered, suppressed, mandatory override) are auditable.
 *
 * Participant preference controls (Issue #193):
 *  - Categories are explicitly classified as mandatory or optional below.
 *  - Preference patches are validated strictly, so a typo or a non-boolean can
 *    never be stored and then read back as a successful opt-out.
 */

import { z } from 'zod';
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

/**
 * Categories whose alerts are always delivered. A recipient may still store
 * `false` for them (older clients do), but routing ignores it and records a
 * `MANDATORY_OVERRIDE`, so the opt-out is visible in the audit trail rather
 * than silently honoured or silently rejected.
 */
export const MANDATORY_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'invoice_lifecycle',
  'payment_recovery',
  'security_alert',
];

/** Categories whose alerts are delivered only when the recipient allows them. */
export const OPTIONAL_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'payment_reminder',
  'marketing_digest',
];

export function isMandatoryCategory(category: NotificationCategory): boolean {
  return MANDATORY_NOTIFICATION_CATEGORIES.includes(category);
}

/**
 * The only mutable preference fields. Objects are strict on purpose: an
 * unknown key (`emial`, `reminders`) or a string `"false"` is a 400, not a
 * no-op that looks like it worked.
 */
export const notificationPreferencePatchSchema = z
  .object({
    channels: z
      .object({
        in_app: z.boolean().optional(),
        email: z.boolean().optional(),
      })
      .strict()
      .optional(),
    categories: z
      .object({
        invoice_lifecycle: z.boolean().optional(),
        payment_recovery: z.boolean().optional(),
        security_alert: z.boolean().optional(),
        payment_reminder: z.boolean().optional(),
        marketing_digest: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch.channels ?? {}).length + Object.keys(patch.categories ?? {}).length > 0,
    'at least one channel or category preference is required'
  );

export type NotificationPreferencePatch = z.infer<typeof notificationPreferencePatchSchema>;

/** Mandatory categories the recipient has switched off; routing overrides each of them. */
export function overriddenMandatoryCategories(
  preferences: RecipientNotificationPreferences
): NotificationCategory[] {
  return MANDATORY_NOTIFICATION_CATEGORIES.filter((category) => !preferences.categories[category]);
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
    patch: NotificationPreferencePatch
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
    patch: NotificationPreferencePatch
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
