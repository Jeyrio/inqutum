/**
 * Participant notification preferences with mandatory alert overrides (#193).
 *
 * Drives the real notification router over HTTP so the credential, ownership
 * and validation boundaries are exercised as a client meets them, then checks
 * what routing does with the stored result: optional alerts follow the
 * preference, mandatory alerts are delivered anyway and say so in the audit.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createNotificationRouter } from '../src/routes/notification.routes.ts';
import {
  MemoryNotificationStore,
  NotificationService,
  type PreferenceChange,
} from '../src/notifications/notification-service.ts';
import {
  MANDATORY_NOTIFICATION_CATEGORIES,
  MemoryNotificationPreferenceStore,
  OPTIONAL_NOTIFICATION_CATEGORIES,
  createDefaultPreferences,
  evaluateNotificationRouting,
  isMandatoryCategory,
} from '../src/notifications/notification-preference.ts';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';
import { maintainerAuth, serviceAuth, walletAuth } from './fixtures/auth.fixture.ts';

for (const method of ['log', 'warn', 'error'] as const) {
  console[method] = () => undefined;
}

const owner = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const TX = 'f'.repeat(64);

const invoice = (over: Partial<StoredInvoice> = {}): StoredInvoice => ({
  id: 'inv-193',
  sellerPublicKey: owner,
  amount: 25,
  assetCode: 'XLM',
  memo: 'INV-193',
  status: 'PENDING',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  ...over,
});

describe('notification preferences API (#193)', () => {
  let baseUrl: string;
  let server: http.Server;
  let service: NotificationService;
  let changes: PreferenceChange[];

  before(async () => {
    const app = express();
    app.use(express.json());
    // The router reads its service per test through this indirection.
    app.use('/api', (req, res, next) => createNotificationRouter({ service })(req, res, next));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    changes = [];
    service = new NotificationService(
      new MemoryNotificationStore(),
      () => new Date('2026-10-20T12:00:00.000Z'),
      new MemoryNotificationPreferenceStore(),
      (change) => changes.push(change)
    );
  });

  async function put(body: unknown, headers: Record<string, string> = walletAuth(owner)) {
    const response = await fetch(`${baseUrl}/notifications/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  async function get(recipient: string) {
    const response = await fetch(`${baseUrl}/notifications/preferences?recipient=${recipient}`);
    return { status: response.status, body: (await response.json()) as any };
  }

  describe('category classification', () => {
    it('classifies every category as exactly one of mandatory or optional', () => {
      const all = Object.keys(createDefaultPreferences(owner).categories).sort();
      assert.deepEqual([...MANDATORY_NOTIFICATION_CATEGORIES, ...OPTIONAL_NOTIFICATION_CATEGORIES].sort(), all);
      for (const category of MANDATORY_NOTIFICATION_CATEGORIES) assert.equal(isMandatoryCategory(category), true);
      for (const category of OPTIONAL_NOTIFICATION_CATEGORIES) assert.equal(isMandatoryCategory(category), false);
    });

    it('exposes the mandatory categories alongside the stored preferences', async () => {
      const result = await get(owner);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data.mandatoryCategories, [...MANDATORY_NOTIFICATION_CATEGORIES]);
      assert.equal(result.body.data.recipient, owner);
      assert.equal(result.body.data.categories.marketing_digest, false);
    });
  });

  describe('optional notifications respect preferences', () => {
    it('opt-out: a recipient who disables reminders receives none, and the suppression is audited', async () => {
      const result = await put({ recipient: owner, categories: { payment_reminder: false } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.categories.payment_reminder, false);

      assert.equal(service.notifyInvoiceReminder(invoice()), null);
      assert.equal(service.list(owner).total, 0);
      const [record] = service.getRoutingAudit(owner);
      assert.equal(record.decision, 'SUPPRESSED');
      assert.equal(record.reason, 'SUPPRESSED_BY_PREFERENCE');
    });

    it('opt-in: re-enabling reminders delivers the next one', async () => {
      await put({ recipient: owner, categories: { payment_reminder: false } });
      const result = await put({ recipient: owner, categories: { payment_reminder: true } });
      assert.equal(result.status, 200);

      const reminder = service.notifyInvoiceReminder(invoice());
      assert.ok(reminder);
      assert.equal(service.list(owner).total, 1);
      assert.equal(service.getRoutingAudit(owner)[0].reason, 'PREFERENCE_ACCEPTED');
    });

    it('opt-in: the default-off marketing digest is delivered only after the recipient enables it', async () => {
      const digest = { id: 'n-1', type: 'marketing.digest', recipient: owner };
      assert.equal(evaluateNotificationRouting(digest, service.getPreferences(owner)).deliver, false);

      await put({ recipient: owner, categories: { marketing_digest: true } });
      const routed = evaluateNotificationRouting(digest, service.getPreferences(owner));
      assert.equal(routed.deliver, true);
      assert.equal(routed.reason, 'PREFERENCE_ACCEPTED');
    });
  });

  describe('mandatory alerts override opt-outs', () => {
    it('delivers lifecycle, recovery and security alerts after the recipient switches everything off', async () => {
      const result = await put({
        recipient: owner,
        channels: { in_app: false, email: false },
        categories: { invoice_lifecycle: false, payment_recovery: false, security_alert: false },
      });
      assert.equal(result.status, 200);

      const paid = service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
      const rejected = service.notifyPaymentRejected(invoice({ id: 'inv-193-r' }), 'AMOUNT_MISMATCH', TX);
      const security = service.notifySecurityAlert(owner, 'New session', 'A new wallet session was opened.');

      for (const alert of [paid, rejected, security]) {
        assert.ok(alert, 'a mandatory alert must not be suppressed');
        assert.equal(alert.data.mandatoryOverride, 'true');
      }
      const audit = service.getRoutingAudit(owner);
      assert.equal(audit.length, 3);
      for (const record of audit) {
        assert.equal(record.urgency, 'mandatory');
        assert.equal(record.decision, 'DELIVERED');
        assert.equal(record.reason, 'MANDATORY_OVERRIDE');
        assert.deepEqual(record.activeChannels, ['in_app'], 'in-app is the floor when every channel is off');
      }
    });

    it('records which mandatory categories the edit tried to switch off', async () => {
      await put({ recipient: owner, categories: { security_alert: false, payment_reminder: false } });
      assert.equal(changes.length, 1);
      assert.deepEqual(changes[0].overriddenMandatoryCategories, ['security_alert']);
      assert.equal(changes[0].before.categories.security_alert, true);
      assert.equal(changes[0].after.categories.security_alert, false);
    });

    it('routes and audits a replayed mandatory event once, not on every re-sync', () => {
      const paidInvoice = invoice({ status: 'PAID' });
      const first = service.syncInvoiceNotifications(paidInvoice);
      const second = service.syncInvoiceNotifications(paidInvoice);
      assert.equal(second?.id, first?.id);
      assert.equal(service.list(owner).total, 1);
      assert.equal(service.getRoutingAudit(owner).length, 1);
      assert.equal(service.getRoutingAudit(owner)[0].notificationId, first?.id);
    });
  });

  describe('unauthorized preference edits', () => {
    const untouched = () => {
      assert.equal(service.getPreferences(owner).categories.payment_reminder, true, 'preferences must be unchanged');
      assert.equal(changes.length, 0, 'a refused edit must not be recorded as a change');
    };
    const patch = { recipient: owner, categories: { payment_reminder: false } };

    it('refuses an anonymous edit with 401', async () => {
      const result = await put(patch, {});
      assert.equal(result.status, 401);
      assert.equal(result.body.code, 'UNAUTHENTICATED');
      untouched();
    });

    it('refuses an expired wallet session with 401', async () => {
      const result = await put(patch, walletAuth(owner, { nowMs: Date.now() - 7_200_000, ttlSeconds: 60 }));
      assert.equal(result.status, 401);
      untouched();
    });

    it('refuses another wallet editing the recipient with 403', async () => {
      const result = await put(patch, walletAuth(stranger));
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'FORBIDDEN');
      untouched();
    });

    it('refuses a service token, which has no business muting a participant, with 403', async () => {
      const result = await put(patch, serviceAuth());
      assert.equal(result.status, 403);
      untouched();
    });

    it('lets a maintainer edit on the recipient\'s behalf, attributed to the maintainer', async () => {
      const result = await put(patch, maintainerAuth());
      assert.equal(result.status, 200);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].changedBy.type, 'maintainer');
      assert.match(changes[0].changedBy.id, /^maintainer:/);
    });

    it('attributes an owner edit to the owner\'s wallet', async () => {
      await put(patch);
      assert.deepEqual(changes[0].changedBy, { type: 'seller', id: owner });
    });
  });

  describe('preference validation', () => {
    const invalid: Array<[string, unknown]> = [
      ['an unknown category', { categories: { reminders: false } }],
      ['an unknown channel', { channels: { sms: true } }],
      ['a string instead of a boolean', { categories: { payment_reminder: 'false' } }],
      ['an unknown top-level field', { categories: { payment_reminder: false }, mute: true }],
      ['an empty patch', {}],
      ['empty channel and category objects', { channels: {}, categories: {} }],
    ];

    for (const [label, body] of invalid) {
      it(`rejects ${label} with 400 and stores nothing`, async () => {
        const result = await put({ recipient: owner, ...(body as object) });
        assert.equal(result.status, 400, JSON.stringify(result.body));
        assert.equal(result.body.code, 'INVALID_NOTIFICATION_PREFERENCES');
        assert.equal(service.getPreferences(owner).categories.payment_reminder, true);
        assert.equal(changes.length, 0);
      });
    }

    it('names the offending key rather than claiming the patch was empty', async () => {
      const result = await put({ recipient: owner, categories: { reminders: false } });
      assert.match(result.body.error, /categories: Unrecognized key\(s\) in object: 'reminders'/);
      assert.doesNotMatch(result.body.error, /at least one/);
      const empty = await put({ recipient: owner });
      assert.match(empty.body.error, /at least one channel or category preference is required/);
    });

    it('rejects a missing or malformed recipient with 400', async () => {
      const result = await put({ recipient: 'not-a-key', categories: { payment_reminder: false } });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'RECIPIENT_REQUIRED');
    });

    it('validates patches at the service boundary too, not only over HTTP', () => {
      assert.throws(() => service.savePreferences(owner, { categories: { reminders: false } } as any));
      assert.equal(changes.length, 0);
    });
  });
});
