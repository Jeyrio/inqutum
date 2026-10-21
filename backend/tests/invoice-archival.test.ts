/**
 * Lifecycle-aware archival and restoration (#197): archive, restore, denied
 * archive, and historical records that stay linked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ArchiveError,
  InvoiceArchiveService,
  evaluateArchiveEligibility,
  type ArchiveLinkProvider,
  type LinkedRecordSummary,
} from '../src/domain/invoice-archival';
import type { StoredInvoice } from '../src/storage/invoice-storage';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function invoice(over: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id: 'inv-1',
    sellerPublicKey: 'G'.padEnd(56, 'A'),
    amount: 100,
    assetCode: 'XLM',
    memo: 'M1',
    status: 'PAID',
    createdAt: daysAgo(90),
    paidAt: daysAgo(60),
    settledAt: daysAgo(60),
    expiresAt: daysAgo(80),
    version: 3,
    ...over,
  };
}

function setup(inv: StoredInvoice, links: LinkedRecordSummary = { openDisputes: 0, references: [] }) {
  const db = new Map<string, StoredInvoice>([[inv.id, inv]]);
  const transitions: string[] = [];
  const provider: ArchiveLinkProvider = { summarize: () => links };
  const service = new InvoiceArchiveService({
    storage: { getInvoiceById: async (id) => db.get(id) ?? null },
    links: provider,
    now: () => NOW,
    onTransition: (r, t) => transitions.push(`${t}:${r.invoiceId}`),
  });
  return { service, db, transitions };
}

const REASON = 'Closed out at quarter end review';

async function denied(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ArchiveError && e.code === code);
}

describe('archive eligibility', () => {
  const links = { openDisputes: 0, references: [] };

  it('accepts terminal invoices past the minimum age', () => {
    for (const status of ['PAID', 'EXPIRED', 'CANCELLED'] as const) {
      const v = evaluateArchiveEligibility({
        invoice: invoice({ status, cancelledAt: daysAgo(45), expiresAt: daysAgo(45), settledAt: daysAgo(45) }),
        now: NOW,
        links,
      });
      assert.equal(v.eligible, true, status);
    }
  });

  it('reports every failing rule', () => {
    const v = evaluateArchiveEligibility({
      invoice: invoice({ status: 'PENDING', settledAt: undefined, paidAt: undefined }),
      now: NOW,
      links: { openDisputes: 2, references: [] },
      alreadyArchived: true,
    });
    assert.deepEqual(v.denials.map((d) => d.code).sort(), ['ALREADY_ARCHIVED', 'NOT_TERMINAL', 'OPEN_DISPUTE']);
  });

  it('denies terminal invoices that are too recent or lack a terminal timestamp', () => {
    assert.equal(evaluateArchiveEligibility({ invoice: invoice({ settledAt: daysAgo(5) }), now: NOW, links }).denials[0].code, 'TOO_RECENT');
    assert.equal(
      evaluateArchiveEligibility({ invoice: invoice({ status: 'CANCELLED', cancelledAt: undefined }), now: NOW, links }).denials[0].code,
      'TOO_RECENT'
    );
  });
});

describe('InvoiceArchiveService', () => {
  it('archives an eligible invoice without rewriting its status', async () => {
    const { service, db, transitions } = setup(invoice());
    const record = await service.archive('inv-1', { actor: 'maint-1', reason: REASON });
    assert.equal(record.state, 'ARCHIVED');
    assert.equal(record.archivedStatus, 'PAID');
    assert.equal(service.isArchived('inv-1'), true);
    assert.equal(db.get('inv-1')!.status, 'PAID');
    assert.deepEqual(transitions, ['ARCHIVED:inv-1']);
  });

  it('denies archive for ineligible invoices with the reason codes', async () => {
    const pending = setup(invoice({ status: 'PENDING', settledAt: undefined, paidAt: undefined }));
    await denied(pending.service.archive('inv-1', { actor: 'm', reason: REASON }), 'NOT_TERMINAL');
    assert.equal(pending.service.isArchived('inv-1'), false);

    const recent = setup(invoice({ settledAt: daysAgo(2) }));
    await denied(recent.service.archive('inv-1', { actor: 'm', reason: REASON }), 'TOO_RECENT');

    const disputed = setup(invoice(), { openDisputes: 1, references: [] });
    await assert.rejects(disputed.service.archive('inv-1', { actor: 'm', reason: REASON }), (e: unknown) => {
      return e instanceof ArchiveError && e.code === 'OPEN_DISPUTE' && e.denials.length === 1;
    });
    await denied(disputed.service.archive('missing', { actor: 'm', reason: REASON }), 'INVOICE_NOT_FOUND');
  });

  it('requires an actor and an explanatory reason', async () => {
    const { service } = setup(invoice());
    await denied(service.archive('inv-1', { actor: ' ', reason: REASON }), 'ACTOR_REQUIRED');
    await denied(service.archive('inv-1', { actor: 'm', reason: 'short' }), 'REASON_REQUIRED');
  });

  it('refuses a second archive', async () => {
    const { service } = setup(invoice());
    await service.archive('inv-1', { actor: 'm', reason: REASON });
    await denied(service.archive('inv-1', { actor: 'm', reason: REASON }), 'ALREADY_ARCHIVED');
  });

  it('restores to the state it was archived from and keeps the history', async () => {
    for (const status of ['PAID', 'CANCELLED', 'EXPIRED'] as const) {
      const { service, transitions } = setup(
        invoice({ status, cancelledAt: daysAgo(60), expiresAt: daysAgo(60), settledAt: daysAgo(60) })
      );
      await service.archive('inv-1', { actor: 'a', reason: REASON });
      const restored = await service.restore('inv-1', { actor: 'b', reason: 'Customer asked for the receipt again' });
      assert.equal(restored.state, 'ACTIVE');
      assert.equal(restored.archivedStatus, status);
      assert.equal((await service.historicalView('inv-1')).invoice.status, status);
      assert.equal(service.state('inv-1'), 'ACTIVE');
      assert.deepEqual(restored.history.map((h) => `${h.from}>${h.to}`), ['ACTIVE>ARCHIVED', 'ARCHIVED>ACTIVE']);
      assert.deepEqual(transitions, ['ARCHIVED:inv-1', 'RESTORED:inv-1']);
    }
  });

  it('can archive again after a restore and extends the same history', async () => {
    const { service } = setup(invoice());
    await service.archive('inv-1', { actor: 'a', reason: REASON });
    await service.restore('inv-1', { actor: 'a', reason: REASON });
    const again = await service.archive('inv-1', { actor: 'a', reason: REASON });
    assert.equal(again.history.length, 3);
    assert.equal(again.restoredAt, null);
  });

  it('refuses to restore what is not archived or what changed underneath', async () => {
    const { service, db } = setup(invoice());
    await denied(service.restore('inv-1', { actor: 'a', reason: REASON }), 'NOT_ARCHIVED');
    await service.archive('inv-1', { actor: 'a', reason: REASON });
    db.set('inv-1', invoice({ version: 4 }));
    await denied(service.restore('inv-1', { actor: 'a', reason: REASON }), 'STATE_CHANGED_SINCE_ARCHIVE');
    db.set('inv-1', invoice({ status: 'CANCELLED', cancelledAt: daysAgo(1) }));
    await denied(service.restore('inv-1', { actor: 'a', reason: REASON }), 'STATE_CHANGED_SINCE_ARCHIVE');
  });

  it('keeps linked historical records resolvable while archived', async () => {
    const references = [
      { kind: 'receipt', id: 'rcpt-9' },
      { kind: 'dispute', id: 'dsp-4' },
      { kind: 'audit', id: 'evt-77' },
    ];
    const { service } = setup(invoice(), { openDisputes: 0, references });
    const record = await service.archive('inv-1', { actor: 'a', reason: REASON });
    assert.deepEqual(record.references, references);

    const view = await service.historicalView('inv-1');
    assert.equal(view.lifecycleState, 'ARCHIVED');
    assert.equal(view.invoice.id, 'inv-1');
    assert.equal(view.invoice.settledAt?.getTime(), daysAgo(60).getTime());
    assert.deepEqual(view.archive?.references, references);

    // returned records are copies: callers cannot rewrite the registry
    record.references.length = 0;
    assert.equal((await service.historicalView('inv-1')).archive?.references.length, 3);
    assert.equal(service.list({ state: 'ARCHIVED' }).length, 1);
    assert.equal(service.list({ state: 'ACTIVE' }).length, 0);
  });

  it('survives a throwing audit sink', async () => {
    const db = new Map([['inv-1', invoice()]]);
    const service = new InvoiceArchiveService({
      storage: { getInvoiceById: async (id) => db.get(id) ?? null },
      now: () => NOW,
      onTransition: () => {
        throw new Error('sink down');
      },
    });
    assert.equal((await service.archive('inv-1', { actor: 'a', reason: REASON })).state, 'ARCHIVED');
  });
});
