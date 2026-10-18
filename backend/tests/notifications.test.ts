import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  MemoryNotificationStore,
  NotificationService,
  RECOVERABLE_REJECTIONS,
  type Notification,
} from '../src/notifications/notification-service.ts';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';

const SELLER_A = 'G' + 'A'.repeat(55);
const SELLER_B = 'G' + 'B'.repeat(55);
const TX = 'a'.repeat(64);

const invoice = (over: Partial<StoredInvoice> = {}): StoredInvoice => ({
  id: 'inv-1',
  sellerPublicKey: SELLER_A,
  amount: 10,
  assetCode: 'XLM',
  memo: 'INV-1',
  status: 'PENDING',
  customerName: 'Secret Customer',
  customerEmail: 'secret@customer.example',
  payerName: 'Secret Payer',
  payerEmail: 'secret@payer.example',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 1000),
  ...over,
});

describe('Notification service contract', () => {
  let clock: Date;
  let service: NotificationService;

  beforeEach(() => {
    clock = new Date('2026-01-01T00:00:00.000Z');
    service = new NotificationService(new MemoryNotificationStore(), () => clock);
  });

  it('emits lifecycle notifications to the seller only', () => {
    const paid = service.syncInvoiceNotifications(invoice({ id: 'p', status: 'PAID' }));
    const expired = service.syncInvoiceNotifications(invoice({ id: 'e', status: 'EXPIRED' }));
    const cancelled = service.syncInvoiceNotifications(invoice({ id: 'c', status: 'CANCELLED' }));

    assert.deepEqual([paid?.type, expired?.type, cancelled?.type], ['invoice.paid', 'invoice.expired', 'invoice.cancelled']);
    assert.deepEqual([paid?.severity, expired?.severity, cancelled?.severity], ['success', 'warning', 'info']);
    assert.equal(paid?.deepLink, '/invoice/p');
    assert.equal(service.list(SELLER_A).total, 3);
    assert.equal(service.list(SELLER_B).total, 0);
  });

  it('deduplicates replayed lifecycle and rejection events', () => {
    const first = service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
    clock = new Date(clock.getTime() + 5_000);
    const replay = service.syncInvoiceNotifications(invoice({ status: 'PAID' }));

    assert.equal(replay?.id, first?.id);
    assert.equal(replay?.createdAt, first?.createdAt);

    const rejected = service.notifyPaymentRejected(invoice({ id: 'r' }), 'AMOUNT_MISMATCH', TX);
    const rejectedReplay = service.notifyPaymentRejected(invoice({ id: 'r' }), 'AMOUNT_MISMATCH', TX);
    assert.equal(rejectedReplay?.id, rejected?.id);
    assert.equal(service.list(SELLER_A).total, 2);
  });

  it('keeps notifications free of customer and payer PII', () => {
    service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
    service.notifyPaymentRejected(invoice({ id: 'r' }), 'AMOUNT_MISMATCH', TX);

    const dump = JSON.stringify(service.list(SELLER_A).notifications);
    for (const secret of ['Secret Customer', 'secret@customer.example', 'Secret Payer', 'secret@payer.example']) {
      assert.equal(dump.includes(secret), false, `${secret} leaked`);
    }
  });

  it('does not leak notification existence across recipients', () => {
    const n = service.syncInvoiceNotifications(invoice({ status: 'PAID' }))!;

    assert.equal(service.markRead(SELLER_B, n.id), null);
    assert.equal(service.markRead(SELLER_B, 'no-such-id'), null);
    assert.equal(service.list(SELLER_A).unread, 1);
    assert.equal(service.list(SELLER_B).total, 0);
    assert.equal(service.markAllRead(SELLER_B), 0);
  });

  it('tracks unread state idempotently', () => {
    const a = service.syncInvoiceNotifications(invoice({ id: 'a', status: 'PAID' }))!;
    service.syncInvoiceNotifications(invoice({ id: 'b', status: 'EXPIRED' }));
    assert.equal(service.unreadCount(SELLER_A), 2);

    clock = new Date('2026-01-02T00:00:00.000Z');
    assert.equal(service.markRead(SELLER_A, a.id)?.readAt, '2026-01-02T00:00:00.000Z');
    clock = new Date('2026-01-03T00:00:00.000Z');
    assert.equal(service.markRead(SELLER_A, a.id)?.readAt, '2026-01-02T00:00:00.000Z');
    assert.equal(service.markAllRead(SELLER_A), 1);
    assert.equal(service.markAllRead(SELLER_A), 0);
  });

  it('provides actionable guidance for recoverable rejection codes only', () => {
    for (const code of RECOVERABLE_REJECTIONS) {
      const n = service.notifyPaymentRejected(invoice({ id: `i-${code}` }), code, TX);
      assert.equal(n?.severity, 'critical');
      assert.equal(n?.type, 'payment.rejected');
      assert.ok(n && n.message.length > 20, code);
      assert.equal(n?.data.code, code);
    }

    for (const code of ['INVALID_TX_HASH', 'INVOICE_EXPIRED', 'TRANSACTION_NOT_FOUND', 'INVALID_PAYER_EMAIL'] as const) {
      assert.equal(service.notifyPaymentRejected(invoice(), code, TX), null);
    }
  });

  it('rejects malformed records at the storage boundary', () => {
    const store = new MemoryNotificationStore();
    const valid: Notification = {
      id: 'n-1',
      recipient: SELLER_A,
      type: 'invoice.paid',
      severity: 'success',
      title: 'Invoice paid',
      message: 'Paid',
      deepLink: '/invoice/inv-1',
      dedupKey: 'inv-1:invoice.paid',
      entityId: 'inv-1',
      data: { invoiceId: 'inv-1' },
      createdAt: '2026-01-01T00:00:00.000Z',
      readAt: null,
    };

    assert.equal(store.insert(valid).created, true);
    assert.throws(() => store.insert({ ...valid, id: 'n-2', dedupKey: '' }), /dedupKey/);
    assert.throws(() => store.insert({ ...valid, id: 'n-3', type: 'bad.type' as Notification['type'] }), /unsupported notification type/);
    assert.throws(() => store.insert({ ...valid, id: 'n-4', createdAt: 'not-a-date' }), /createdAt/);
  });
});
