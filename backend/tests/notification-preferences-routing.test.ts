import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  NotificationService,
  MemoryNotificationStore,
} from '../src/notifications/notification-service.ts';
import {
  MemoryNotificationPreferenceStore,
  evaluateNotificationRouting,
  getNotificationUrgency,
  createDefaultPreferences,
} from '../src/notifications/notification-preference.ts';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';

const SELLER_A = 'G' + 'A'.repeat(55);
const SELLER_B = 'G' + 'B'.repeat(55);
const TX = 'e'.repeat(64);

const invoice = (over: Partial<StoredInvoice> = {}): StoredInvoice => ({
  id: 'inv-pref-1',
  sellerPublicKey: SELLER_A,
  amount: 50,
  assetCode: 'XLM',
  memo: 'INV-PREF-1',
  status: 'PENDING',
  customerName: 'Alice Buyer',
  customerEmail: 'alice@example.com',
  payerName: 'Alice Payer',
  payerEmail: 'alice@payer.example',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86400000),
  ...over,
});

describe('Notification preferences and mandatory-alert routing contract (Issue #268)', () => {
  let clock: Date;
  let service: NotificationService;
  let prefStore: MemoryNotificationPreferenceStore;

  beforeEach(() => {
    clock = new Date('2026-03-01T12:00:00.000Z');
    prefStore = new MemoryNotificationPreferenceStore();
    service = new NotificationService(new MemoryNotificationStore(), () => clock, prefStore);
  });

  it('provides sensible default preferences for any valid Stellar recipient', () => {
    const defaults = service.getPreferences(SELLER_A);
    assert.equal(defaults.recipient, SELLER_A);
    assert.equal(defaults.channels.in_app, true);
    assert.equal(defaults.channels.email, true);
    assert.equal(defaults.categories.invoice_lifecycle, true);
    assert.equal(defaults.categories.payment_recovery, true);
    assert.equal(defaults.categories.security_alert, true);
    assert.equal(defaults.categories.payment_reminder, true);
    assert.equal(defaults.categories.marketing_digest, false);
  });

  it('rejects invalid Stellar public keys when constructing default preferences', () => {
    assert.throws(() => createDefaultPreferences('invalid-key'), /recipient must be a valid Stellar public key/);
  });

  it('allows durable updates to channel and category preferences', () => {
    service.savePreferences(SELLER_A, {
      channels: { email: false },
      categories: { payment_reminder: false },
    });

    const updated = service.getPreferences(SELLER_A);
    assert.equal(updated.channels.email, false);
    assert.equal(updated.channels.in_app, true);
    assert.equal(updated.categories.payment_reminder, false);
    assert.equal(updated.categories.invoice_lifecycle, true);
  });

  it('delivers optional notifications when preferences allow them', () => {
    const reminder = service.notifyInvoiceReminder(invoice());
    assert.ok(reminder);
    assert.equal(reminder?.type, 'invoice.reminder');
    assert.equal(service.list(SELLER_A).total, 1);

    const audit = service.getRoutingAudit(SELLER_A);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].decision, 'DELIVERED');
    assert.equal(audit[0].reason, 'PREFERENCE_ACCEPTED');
  });

  it('suppresses optional notifications when the recipient opts out', () => {
    // Disable payment reminders
    service.savePreferences(SELLER_A, {
      categories: { payment_reminder: false },
    });

    const reminder = service.notifyInvoiceReminder(invoice());
    assert.equal(reminder, null, 'suppressed notification must return null');
    assert.equal(service.list(SELLER_A).total, 0, 'suppressed notification must not appear in user feed');

    const audit = service.getRoutingAudit(SELLER_A);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].type, 'invoice.reminder');
    assert.equal(audit[0].decision, 'SUPPRESSED');
    assert.equal(audit[0].reason, 'SUPPRESSED_BY_PREFERENCE');
    assert.equal(audit[0].urgency, 'optional');
  });

  it('suppresses optional notifications when all delivery channels are disabled', () => {
    service.savePreferences(SELLER_A, {
      channels: { in_app: false, email: false },
    });

    const reminder = service.notifyInvoiceReminder(invoice());
    assert.equal(reminder, null);
    assert.equal(service.list(SELLER_A).total, 0);

    const audit = service.getRoutingAudit(SELLER_A);
    assert.equal(audit[0].decision, 'SUPPRESSED');
    assert.equal(audit[0].reason, 'SUPPRESSED_BY_PREFERENCE');
  });

  it('guarantees mandatory lifecycle alerts are deliverable even if recipient opted out of everything', () => {
    // Recipient attempts to disable all channels and categories
    service.savePreferences(SELLER_A, {
      channels: { in_app: false, email: false },
      categories: {
        invoice_lifecycle: false,
        payment_recovery: false,
        security_alert: false,
        payment_reminder: false,
        marketing_digest: false,
      },
    });

    // Mandatory lifecycle event: invoice.paid
    const paid = service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
    assert.ok(paid, 'mandatory alert must be delivered');
    assert.equal(paid?.type, 'invoice.paid');
    assert.equal(paid?.data.mandatoryOverride, 'true', 'mandatory override flag must be recorded');

    // Mandatory recovery alert: payment.rejected
    const rejected = service.notifyPaymentRejected(invoice({ id: 'inv-rej' }), 'AMOUNT_MISMATCH', TX);
    assert.ok(rejected, 'mandatory recovery alert must be delivered');
    assert.equal(rejected?.type, 'payment.rejected');
    assert.equal(rejected?.data.mandatoryOverride, 'true');

    // Both mandatory notifications must exist in in-app store for operator and seller auditability
    assert.equal(service.list(SELLER_A).total, 2);

    // Audit trail must clearly document MANDATORY_OVERRIDE
    const audit = service.getRoutingAudit(SELLER_A);
    assert.equal(audit.length, 2);
    assert.equal(audit[0].decision, 'DELIVERED');
    assert.equal(audit[0].reason, 'MANDATORY_OVERRIDE');
    assert.equal(audit[0].urgency, 'mandatory');
    assert.equal(audit[1].decision, 'DELIVERED');
    assert.equal(audit[1].reason, 'MANDATORY_OVERRIDE');
    assert.equal(audit[1].urgency, 'mandatory');
  });

  it('guarantees security alerts are delivered and audited under mandatory classification', () => {
    service.savePreferences(SELLER_A, {
      channels: { in_app: false },
      categories: { security_alert: false },
    });

    const alert = service.notifySecurityAlert(
      SELLER_A,
      'Suspicious Access Detected',
      'An unauthorized login attempt was blocked.',
      { ip: '198.51.100.1' }
    );

    assert.ok(alert);
    assert.equal(alert?.type, 'security.alert');
    assert.equal(alert?.severity, 'critical');

    const audit = service.getRoutingAudit(SELLER_A);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'MANDATORY_OVERRIDE');
  });

  it('isolates preferences and routing audit between different recipients', () => {
    service.savePreferences(SELLER_A, { channels: { email: false } });
    service.savePreferences(SELLER_B, { channels: { email: true } });

    assert.equal(service.getPreferences(SELLER_A).channels.email, false);
    assert.equal(service.getPreferences(SELLER_B).channels.email, true);

    service.syncInvoiceNotifications(invoice({ sellerPublicKey: SELLER_A, status: 'PAID' }));
    assert.equal(service.getRoutingAudit(SELLER_A).length, 1);
    assert.equal(service.getRoutingAudit(SELLER_B).length, 0);
  });
});
