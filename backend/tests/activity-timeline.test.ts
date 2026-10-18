import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidTimelineCursorError,
  buildActivityTimeline,
  visibilityOf,
} from '../src/domain/activity-timeline.ts';
import type { TimelineEvent, TimelineInvoice } from '../src/domain/activity-timeline.ts';

const SELLER = 'G' + 'A'.repeat(55);
const OTHER = 'G' + 'B'.repeat(55);
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const owner = { role: 'end_user' as const, wallet: SELLER };

const invoices: TimelineInvoice[] = [
  { id: 'inv-1', sellerPublicKey: SELLER },
  { id: 'inv-2', sellerPublicKey: OTHER },
  { id: 'inv-gone', sellerPublicKey: SELLER, deleted: true },
  { id: 'inv-locked', sellerPublicKey: SELLER, restricted: true },
];

const event = (id: string, invoiceId: string, eventType: string, minutes: number, eventData: Record<string, unknown> | null = null): TimelineEvent => ({
  id,
  invoiceId,
  eventType,
  eventData,
  createdAt: at(minutes),
});

describe('activity timeline visibility', () => {
  it('shows the owner their public events only', () => {
    const page = buildActivityTimeline(
      owner,
      [
        event('e1', 'inv-1', 'INVOICE_CREATED', 0, { amount: '10', assetCode: 'XLM', ip: '10.0.0.1' }),
        event('e2', 'inv-1', 'PAYMENT_REJECTED', 1, { reason: 'memo' }),
        event('e3', 'inv-1', 'SOMETHING_NEW', 2),
        event('e4', 'inv-2', 'INVOICE_CREATED', 3),
      ],
      invoices
    );
    assert.deepEqual(page.entries.map((e) => e.id), ['e1']);
    assert.deepEqual(page.entries[0].data, { amount: '10', assetCode: 'XLM' });
    assert.equal(page.entries[0].link, '/invoice/inv-1');
  });

  it('treats unknown event types as maintainer only', () => {
    assert.equal(visibilityOf('SOMETHING_NEW'), 'maintainer');
    assert.equal(visibilityOf('PAYMENT_CONFIRMED'), 'public');
  });

  it('hides deleted and restricted records', () => {
    const page = buildActivityTimeline(
      owner,
      [event('a', 'inv-gone', 'INVOICE_CREATED', 0), event('b', 'inv-locked', 'INVOICE_CREATED', 1), event('c', 'missing', 'INVOICE_CREATED', 2)],
      invoices
    );
    assert.equal(page.entries.length, 0);
  });

  it('shows nothing to a caller without a wallet', () => {
    const page = buildActivityTimeline({ role: 'anonymous' }, [event('e1', 'inv-1', 'INVOICE_CREATED', 0)], invoices);
    assert.equal(page.entries.length, 0);
  });
});

describe('activity timeline ordering and paging', () => {
  const events = [
    event('b', 'inv-1', 'INVOICE_CREATED', 0),
    event('a', 'inv-1', 'PAYMENT_CONFIRMED', 5, { txHash: 'f'.repeat(64) }),
    event('c', 'inv-1', 'INVOICE_CANCELLED', 5),
    event('d', 'inv-1', 'INVOICE_EXPIRED', 10),
  ];

  it('orders newest first with the id as a tie breaker', () => {
    const page = buildActivityTimeline(owner, [...events].reverse(), invoices);
    assert.deepEqual(page.entries.map((e) => e.id), ['d', 'a', 'c', 'b']);
  });

  it('pages through every entry exactly once', () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = buildActivityTimeline(owner, events, invoices, { limit: 1, cursor });
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ['d', 'a', 'c', 'b']);
  });

  it('returns no cursor on the last page', () => {
    assert.equal(buildActivityTimeline(owner, events, invoices, { limit: 10 }).nextCursor, null);
  });

  it('rejects a malformed cursor', () => {
    assert.throws(() => buildActivityTimeline(owner, events, invoices, { cursor: 'nope' }), InvalidTimelineCursorError);
  });
});
