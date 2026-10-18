/**
 * Versioned event replay for rebuilding projections (#290).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { MemoryAuditStore, type AuditEvent } from '../src/audit/audit-service';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { StoredInvoice } from '../src/storage/invoice-storage';
import { PermissionAwareSearchIndex } from '../src/services/search-index.service';
import {
  LATEST_SEARCH_INDEX_PROJECTOR,
  NothingToRollBackError,
  ProjectionReplayService,
  ReplayInProgressError,
  UnknownProjectorVersionError,
  verifyEventChain,
} from '../src/ops/projection-replay';
import { createOpsRouter } from '../src/routes/ops.routes';

const SELLER = `G${'A'.repeat(55)}`;

describe('Projection replay — search index', () => {
  let storage: MemoryInvoiceStorage;
  let audit: MemoryAuditStore;
  let live: PermissionAwareSearchIndex;
  let service: ProjectionReplayService;

  const record = (action: AuditEvent['action'], invoice: StoredInvoice) =>
    audit.recordEvent({
      action,
      actor: { type: 'seller', id: invoice.sellerPublicKey },
      scope: { entityType: 'invoice', entityId: invoice.id },
      afterState: invoice,
    });

  const create = async (amount: number) => {
    const invoice = await storage.createInvoice({ amount, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    record('INVOICE_CREATED', invoice);
    return invoice;
  };

  beforeEach(() => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
    audit = new MemoryAuditStore();
    live = new PermissionAwareSearchIndex();
    service = new ProjectionReplayService({ storage, index: live, events: () => audit.listChronological() });
  });

  it('normal path: a dry run reports the rebuild and leaves the live index alone', async () => {
    const a = await create(10);
    await create(20);
    record('INVOICE_CANCELLED', await storage.cancelInvoice(a.id));

    const report = await service.replay();
    assert.equal(report.outcome, 'dry_run');
    assert.deepEqual(report.reasons, []);
    assert.equal(report.projectorVersion, LATEST_SEARCH_INDEX_PROJECTOR);
    assert.deepEqual(report.events, {
      total: 3,
      applied: 3,
      skipped: 0,
      rejected: 0,
      firstEventId: report.events.firstEventId,
      lastEventId: report.events.lastEventId,
    });
    assert.deepEqual(report.diff, { added: 2, removed: 0, changed: 0 });
    assert.equal(live.exportRecords().length, 0);
  });

  it('apply swaps the rebuilt projection in, and rollback restores the previous one', async () => {
    const a = await create(10);
    record('INVOICE_CANCELLED', await storage.cancelInvoice(a.id));
    live.indexInvoice({ ...a, id: 'orphan' } as StoredInvoice);

    const report = await service.replay({ dryRun: false });
    assert.equal(report.outcome, 'applied');
    assert.deepEqual(report.diff, { added: 1, removed: 1, changed: 0 });
    assert.deepEqual(live.exportRecords().map((r) => [r.id, r.status]), [[a.id, 'CANCELLED']]);

    assert.deepEqual(service.rollback(), { restored: 1 });
    assert.deepEqual(live.exportRecords().map((r) => r.id), ['orphan']);
    assert.throws(() => service.rollback(), NothingToRollBackError);
  });

  it('keeps operator-set visibility and overlays lazy expiry from storage', async () => {
    const a = await create(10);
    live.indexInvoice(a, 'PUBLIC');
    await storage.markExpiredInvoices(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

    const report = await service.replay({ dryRun: false });
    assert.equal(report.outcome, 'applied');
    assert.equal(report.derivedExpiries, 1);
    const [rebuilt] = live.exportRecords();
    assert.equal(rebuilt!.visibility, 'PUBLIC');
    assert.equal(rebuilt!.status, 'EXPIRED');
  });

  it('skips actions the projector version does not handle', async () => {
    await create(10);
    audit.recordEvent({ action: 'MAINTAINER_ACTION', actor: { type: 'maintainer', id: 'ops' }, scope: { entityType: 'system', entityId: 'x' } });
    const report = await service.replay();
    assert.equal(report.events.skipped, 1);
    assert.deepEqual(report.reasons, []);
  });

  describe('failure path: refuses to swap an untrustworthy rebuild', () => {
    it('a tampered event breaks the hash chain', async () => {
      await create(10);
      await create(20);
      audit.listChronological()[0]!.afterState!.amount = 999; // events are shared references
      const report = await service.replay({ dryRun: false });
      assert.equal(report.outcome, 'refused');
      assert.equal(report.integrity.brokenAt, audit.listChronological()[0]!.id);
      assert.equal(live.exportRecords().length, 0);
    });

    it('evicted history is reported as truncation', async () => {
      audit = new MemoryAuditStore(1);
      service = new ProjectionReplayService({ storage, index: live, events: () => audit.listChronological() });
      await create(10);
      await create(20);
      const report = await service.replay({ dryRun: false });
      assert.equal(report.outcome, 'refused');
      assert.equal(report.integrity.truncated, true);
      assert.equal(report.integrity.valid, true);
    });

    it('an event whose payload cannot be projected is rejected', async () => {
      const a = await create(10);
      audit.recordEvent({ action: 'PAYMENT_VERIFIED', actor: { type: 'payer', id: 'x' }, scope: { entityType: 'invoice', entityId: a.id }, afterState: { status: 'PAID' } });
      const report = await service.replay({ dryRun: false });
      assert.equal(report.outcome, 'refused');
      assert.equal(report.events.rejected, 1);
    });

    it('a rebuild that disagrees with storage (an invoice with no events) is not applied', async () => {
      await create(10);
      await storage.createInvoice({ amount: 5, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7 } as any);
      const report = await service.replay({ dryRun: false });
      assert.equal(report.outcome, 'refused');
      assert.equal(report.verification.byType.MISSING_PROJECTION, 1);
    });
  });

  it('versioning: an unknown projector version is refused', async () => {
    await assert.rejects(service.replay({ projectorVersion: 99 }), UnknownProjectorVersionError);
  });

  it('retry path: a second replay while one runs is refused, and the next one succeeds', async () => {
    await create(10);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = Object.assign(Object.create(storage), {
      getAllInvoices: async () => {
        await gate;
        return storage.getAllInvoices();
      },
    });
    service = new ProjectionReplayService({ storage: slow, index: live, events: () => audit.listChronological() });
    const first = service.replay();
    await assert.rejects(service.replay(), ReplayInProgressError);
    release();
    await first;
    assert.equal((await service.replay({ dryRun: false })).outcome, 'applied');
  });

  it('verifyEventChain accepts an empty log', () => {
    assert.deepEqual(verifyEventChain([]), { valid: true, truncated: false, brokenAt: null });
  });
});

describe('Projection replay — admin routes', () => {
  const TOKEN = 'replay-admin-token-123';

  async function serve() {
    memoryStorage.clear();
    const storage = new MemoryInvoiceStorage();
    const audit = new MemoryAuditStore();
    const invoice = await storage.createInvoice({ amount: 10, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    audit.recordEvent({ action: 'INVOICE_CREATED', actor: { type: 'seller', id: SELLER }, scope: { entityType: 'invoice', entityId: invoice.id }, afterState: invoice });
    const replay = new ProjectionReplayService({ storage, index: new PermissionAwareSearchIndex(), events: () => audit.listChronological() });
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage, adminToken: TOKEN, replay, approvals: null }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/projections/search-index`;
    const post = (path: string, body: unknown, token: string | null = TOKEN) =>
      fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    return { server, post };
  }

  it('authorization path: requires the admin bearer token', async () => {
    const { server, post } = await serve();
    try {
      assert.equal((await post('replay', {}, null)).status, 401);
      assert.equal((await post('replay', {}, 'wrong-token')).status, 401);
      assert.equal((await post('rollback', {}, null)).status, 401);
    } finally {
      server.close();
    }
  });

  it('dry run by default, apply on request, then rollback once', async () => {
    const { server, post } = await serve();
    try {
      const dry = await (await post('replay', {})).json();
      assert.equal(dry.data.outcome, 'dry_run');
      const applied = await (await post('replay', { dryRun: false })).json();
      assert.equal(applied.data.outcome, 'applied');
      assert.equal((await post('rollback', {})).status, 200);
      const again = await post('rollback', {});
      assert.equal(again.status, 409);
      assert.equal((await again.json()).code, 'NOTHING_TO_ROLL_BACK');
      assert.equal((await post('replay', { projectorVersion: 'one' })).status, 400);
      assert.equal((await post('replay', { projectorVersion: 7 })).status, 400);
    } finally {
      server.close();
    }
  });
});
