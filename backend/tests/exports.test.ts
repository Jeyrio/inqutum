import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  EXPORT_FIELDS,
  EXPORT_SCHEMA_ID,
  EXPORT_SCHEMA_VERSION,
  ExportForbiddenError,
  ExportConfigurationError,
  ExportCancelledError,
  ExportService,
  csvCell,
  toExportRecord,
} from '../src/exports/export-service.ts';
import { createExportRouter } from '../src/routes/export.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';
import type { InvoiceStorage } from '../src/storage/invoice-storage.ts';

const SELLER_A = 'G' + 'A'.repeat(55);
const SELLER_B = 'G' + 'B'.repeat(55);

describe('Data export workflow (Issue #52)', () => {
  let storage: MemoryInvoiceStorage;
  let clock: Date;

  const seed = async (seller: string, n: number, over: Record<string, unknown> = {}) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await storage.createInvoice({ amount: 1 + i, assetCode: 'XLM', sellerPublicKey: seller, expiresInDays: 7, ...over } as any));
    }
    return out;
  };
  const service = (opts = {}) => new ExportService(storage, { now: () => clock, ...opts });

  beforeEach(() => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
    clock = new Date('2026-01-01T00:00:00.000Z');
  });

  describe('schema and metadata', () => {
    it('includes schema id/version, generation metadata, scope, filters and field list', async () => {
      await seed(SELLER_A, 2);
      const artifact = await service().create(SELLER_A, { format: 'json', status: 'PENDING' });
      const doc = JSON.parse(artifact.body);

      assert.equal(doc.schema, EXPORT_SCHEMA_ID);
      assert.equal(doc.schemaVersion, EXPORT_SCHEMA_VERSION);
      assert.equal(doc.generatedAt, '2026-01-01T00:00:00.000Z');
      assert.equal(doc.expiresAt, '2026-01-02T00:00:00.000Z');
      assert.deepEqual(doc.scope, { sellerPublicKey: SELLER_A });
      assert.deepEqual(doc.filters, { status: 'PENDING', from: null, to: null });
      assert.equal(doc.recordCount, 2);
      assert.equal(doc.truncated, false);
      assert.deepEqual(doc.fields, [...EXPORT_FIELDS]);
      assert.equal(doc.records.length, 2);
      assert.equal(artifact.contentType, 'application/json; charset=utf-8');
    });

    it('exports only allow-listed fields and never personal data', async () => {
      await seed(SELLER_A, 1, {
        sellerName: 'Seller PII', sellerEmail: 'seller-pii@example.com',
        customerName: 'Customer PII', customerEmail: 'customer-pii@example.com',
      });
      const [inv] = await storage.getInvoicesBySeller(SELLER_A);
      await storage.markAsPaid(inv.id, 'f'.repeat(64), 'G' + 'C'.repeat(55), { payerName: 'Payer PII', payerEmail: 'payer-pii@example.com' });

      for (const format of ['json', 'csv'] as const) {
        const { body } = await service().create(SELLER_A, { format });
        for (const pii of ['PII', 'pii@example.com', 'payerEmail', 'customerEmail', 'sellerEmail']) {
          assert.equal(body.includes(pii), false, `${format} leaked ${pii}`);
        }
      }
      const record = toExportRecord({ ...inv, status: 'PAID', paymentTxHash: 'f'.repeat(64) });
      assert.deepEqual(Object.keys(record), [...EXPORT_FIELDS]);
    });
  });

  describe('authorization', () => {
    it("only exports the requester's invoices", async () => {
      await seed(SELLER_A, 2);
      await seed(SELLER_B, 3);
      const doc = JSON.parse((await service().create(SELLER_A, { format: 'json' })).body);
      assert.equal(doc.recordCount, 2);
      const b = JSON.parse((await service().create(SELLER_B, { format: 'json' })).body);
      assert.equal(b.recordCount, 3);
    });

    it("denies requesting another wallet's scope", async () => {
      await seed(SELLER_B, 1);
      await assert.rejects(service().create(SELLER_A, { format: 'json' }, SELLER_B), ExportForbiddenError);
      assert.equal(service().size(), 0);
    });

    it('drops rows that are not the requester\'s even if storage returned them', async () => {
      const [foreign] = await seed(SELLER_B, 1);
      const leaky = { getInvoicesBySeller: async () => [foreign] } as unknown as InvoiceStorage;
      const doc = JSON.parse((await new ExportService(leaky).create(SELLER_A, { format: 'json' })).body);
      assert.equal(doc.recordCount, 0);
    });

    it("hides other wallets' artifacts as not found", async () => {
      await seed(SELLER_A, 1);
      const svc = service();
      const { meta } = await svc.create(SELLER_A, { format: 'json' });
      assert.equal(svc.get(SELLER_A, meta.exportId).state, 'ok');
      assert.equal(svc.get(SELLER_B, meta.exportId).state, 'not_found');
      assert.equal(svc.get(SELLER_A, 'nope').state, 'not_found');
    });
  });

  describe('permission-aware export pipeline (Issue #241)', () => {
    it('never emits a field outside the allow-list even for genuinely stored PII', async () => {
      await seed(SELLER_A, 1, { customerEmail: 'customer@example.com', customerName: 'Jane Customer' });
      const doc = JSON.parse((await service().create(SELLER_A, { format: 'json' })).body);
      const keys = Object.keys(doc.records[0]);
      for (const key of keys) {
        assert.ok((EXPORT_FIELDS as readonly string[]).includes(key), `unexpected field leaked: ${key}`);
      }
      assert.equal('customerEmail' in doc.records[0], false);
      assert.equal('customerName' in doc.records[0], false);
    });

    it('rejects an export cancelled before it starts', async () => {
      await seed(SELLER_A, 5);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        service().create(SELLER_A, { format: 'json' }, SELLER_A, controller.signal),
        ExportCancelledError
      );
    });

    it('cancels a large export in flight and persists no artifact', async () => {
      await seed(SELLER_A, 20);
      const controller = new AbortController();

      let pagesServed = 0;
      const abortingStorage = {
        getInvoicesBySeller: async (...args: Parameters<InvoiceStorage['getInvoicesBySeller']>) => {
          pagesServed += 1;
          if (pagesServed === 2) controller.abort();
          return storage.getInvoicesBySeller(...args);
        },
      } as unknown as InvoiceStorage;

      const cancellingSvc = new ExportService(abortingStorage, { now: () => clock, pageSize: 3 });
      await assert.rejects(
        cancellingSvc.create(SELLER_A, { format: 'json' }, SELLER_A, controller.signal),
        ExportCancelledError
      );
      assert.equal(cancellingSvc.size(), 0, 'no partial artifact should be persisted on cancellation');
    });
  });

  describe('empty, large and filtered exports', () => {
    it('produces a valid empty JSON export and a header-only CSV', async () => {
      const json = JSON.parse((await service().create(SELLER_A, { format: 'json' })).body);
      assert.equal(json.recordCount, 0);
      assert.deepEqual(json.records, []);
      const csv = (await service().create(SELLER_A, { format: 'csv' })).body;
      assert.equal(csv, EXPORT_FIELDS.join(',') + '\r\n');
    });

    it('pages through a large export without losing or duplicating rows', async () => {
      await seed(SELLER_A, 25);
      const doc = JSON.parse((await service({ pageSize: 4 }).create(SELLER_A, { format: 'json' })).body);
      assert.equal(doc.recordCount, 25);
      assert.equal(new Set(doc.records.map((r: any) => r.id)).size, 25);
      assert.equal(doc.truncated, false);
    });

    it('handles an exact page-size multiple', async () => {
      await seed(SELLER_A, 8);
      const doc = JSON.parse((await service({ pageSize: 4 }).create(SELLER_A, { format: 'json' })).body);
      assert.equal(doc.recordCount, 8);
    });

    it('caps at maxRecords and flags truncation; exactly-at-cap is not truncated', async () => {
      await seed(SELLER_A, 12);
      const capped = JSON.parse((await service({ maxRecords: 10, pageSize: 3 }).create(SELLER_A, { format: 'json' })).body);
      assert.equal(capped.recordCount, 10);
      assert.equal(capped.truncated, true);
      const exact = JSON.parse((await service({ maxRecords: 12, pageSize: 5 }).create(SELLER_A, { format: 'json' })).body);
      assert.equal(exact.recordCount, 12);
      assert.equal(exact.truncated, false);
    });

    it('filters by status and created date range', async () => {
      const [a] = await seed(SELLER_A, 3);
      await storage.cancelInvoice(a.id);
      const cancelled = JSON.parse((await service().create(SELLER_A, { format: 'json', status: 'CANCELLED' })).body);
      assert.equal(cancelled.recordCount, 1);

      const future = new Date(Date.now() + 86_400_000);
      const past = new Date(Date.now() - 86_400_000);
      const none = JSON.parse((await service().create(SELLER_A, { format: 'json', from: future })).body);
      const alsoNone = JSON.parse((await service().create(SELLER_A, { format: 'json', to: past })).body);
      const all = JSON.parse((await service().create(SELLER_A, { format: 'json', from: past, to: future })).body);
      assert.deepEqual([none.recordCount, alsoNone.recordCount, all.recordCount], [0, 0, 3]);
      assert.equal(all.filters.from, past.toISOString());
    });
  });

  describe('CSV safety', () => {
    it('neutralises spreadsheet formula injection and escapes quotes/commas/newlines', () => {
      assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
      assert.equal(csvCell('+1'), "'+1");
      assert.equal(csvCell('-2'), "'-2");
      assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
      assert.equal(csvCell('\tcmd'), "'\tcmd");
      assert.equal(csvCell('a,b'), '"a,b"');
      assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
      assert.equal(csvCell('plain'), 'plain');
      assert.equal(csvCell(12.5), '12.5');
      assert.equal(csvCell(null), '');
    });

    it('applies the guard to free-text invoice descriptions', async () => {
      await seed(SELLER_A, 1, { description: '=cmd|"/c calc"!A1' });
      const csv = (await service().create(SELLER_A, { format: 'csv' })).body;
      assert.ok(csv.includes(`"'=cmd|""/c calc""!A1"`), csv);
      assert.equal((await service().create(SELLER_A, { format: 'csv' })).contentType, 'text/csv; charset=utf-8');
    });
  });

  describe('retention', () => {
    it('serves an artifact until it expires, then reports expired to its owner and not-found to others', async () => {
      await seed(SELLER_A, 1);
      const svc = service({ retentionMs: 60_000 });
      const { meta } = await svc.create(SELLER_A, { format: 'json' });

      clock = new Date(clock.getTime() + 59_999);
      assert.equal(svc.get(SELLER_A, meta.exportId).state, 'ok');
      clock = new Date(clock.getTime() + 1);
      assert.equal(svc.get(SELLER_A, meta.exportId).state, 'expired');
      assert.equal(svc.get(SELLER_B, meta.exportId).state, 'not_found');
      assert.equal(svc.size(), 0);
    });

    it('purges expired artifacts on the next create and reports the count', async () => {
      const svc = service({ retentionMs: 1000 });
      await svc.create(SELLER_A, { format: 'json' });
      await svc.create(SELLER_A, { format: 'json' });
      clock = new Date(clock.getTime() + 2000);
      assert.equal(svc.purgeExpired(), 2);
      assert.equal(svc.purgeExpired(), 0);
      await svc.create(SELLER_A, { format: 'json' });
      assert.equal(svc.size(), 1);
    });

    it('keeps at most maxArtifactsPerRequester, evicting the oldest, without touching other wallets', async () => {
      const svc = service({ maxArtifactsPerRequester: 2 });
      const first = await svc.create(SELLER_A, { format: 'json' });
      await svc.create(SELLER_A, { format: 'json' });
      const third = await svc.create(SELLER_A, { format: 'json' });
      const other = await svc.create(SELLER_B, { format: 'json' });
      assert.equal(svc.get(SELLER_A, first.meta.exportId).state, 'not_found');
      assert.equal(svc.get(SELLER_A, third.meta.exportId).state, 'ok');
      assert.equal(svc.get(SELLER_B, other.meta.exportId).state, 'ok');
      assert.equal(svc.size(), 3);
    });

    it('bounds the expired-id tombstone map', async () => {
      const svc = service({ retentionMs: 1, maxArtifactsPerRequester: 5000 });
      for (let i = 0; i < 1005; i++) await svc.create(SELLER_A, { format: 'json' });
      clock = new Date(clock.getTime() + 10);
      assert.equal(svc.purgeExpired(), 1005);
      assert.equal(svc.size(), 0);
    });

    it('uses the real clock and default limits when no options are given', async () => {
      const artifact = await new ExportService(storage).create(SELLER_A, { format: 'json' });
      const ttl = new Date(artifact.meta.expiresAt).getTime() - new Date(artifact.meta.generatedAt).getTime();
      assert.equal(ttl, 24 * 60 * 60 * 1000);
    });

    it('rejects unsafe service limits that would break paging or retention', () => {
      for (const opts of [
        { pageSize: 0 },
        { maxRecords: 0 },
        { retentionMs: -1 },
        { maxArtifactsPerRequester: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        assert.throws(() => new ExportService(storage, opts), ExportConfigurationError);
      }
    });
  });

  describe('export routes', () => {
    async function withServer(fn: (call: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>, svc?: ExportService, st: InvoiceStorage = storage) {
      const app = express();
      app.use(express.json());
      app.use('/api', createExportRouter({ storage: st, service: svc }));
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      try {
        await fn(call);
      } finally {
        server.close();
      }
    }
    const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

    it('generates then downloads an export as JSON and CSV with safe headers', async () => {
      await seed(SELLER_A, 2);
      await withServer(async (call) => {
        const created = await call('/exports', post({ requester: SELLER_A }));
        assert.equal(created.status, 201);
        const { data } = await created.json();
        assert.equal(data.schemaVersion, 1);
        assert.equal(data.recordCount, 2);
        assert.equal(data.format, 'json');

        const dl = await call(data.downloadPath.replace('/api', ''));
        assert.equal(dl.status, 200);
        assert.equal(dl.headers.get('cache-control'), 'private, no-store');
        assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
        assert.match(dl.headers.get('content-disposition')!, /quittance-invoices-v1\.json/);
        assert.equal((await dl.json()).records.length, 2);

        const csv = await (await call('/exports', post({ requester: SELLER_A, format: 'csv' }))).json();
        const csvDl = await call(csv.data.downloadPath.replace('/api', ''));
        assert.match(csvDl.headers.get('content-type')!, /text\/csv/);
        assert.equal((await csvDl.text()).split('\r\n').length, 4);
      });
    });

    it('records an audit event for each export', async () => {
      await seed(SELLER_A, 1);
      await withServer(async (call) => {
        const { data } = await (await call('/exports', post({ requester: SELLER_A }))).json();
        const events = await storage.getAuditEvents!({ entityId: data.exportId });
        assert.equal(events.events.length, 1);
        assert.equal(events.events[0].action, 'PROOF_EXPORTED');
        assert.equal(events.events[0].actor.id, SELLER_A);
      });
    });

    it('still succeeds if the audit write fails or storage has no audit support', async () => {
      const failing = Object.create(storage) as any;
      failing.recordAuditEvent = async () => { throw new Error('audit down'); };
      const original = console.error;
      console.error = () => {};
      try {
        await withServer(async (call) => assert.equal((await call('/exports', post({ requester: SELLER_A }))).status, 201), undefined, failing);
      } finally {
        console.error = original;
      }
      const bare = { getInvoicesBySeller: async () => [] } as unknown as InvoiceStorage;
      await withServer(async (call) => assert.equal((await call('/exports', post({ requester: SELLER_A }))).status, 201), undefined, bare);
    });

    it('denies exporting another wallet\'s scope with 403 and never creates an artifact', async () => {
      await seed(SELLER_B, 1);
      const svc = service();
      await withServer(async (call) => {
        const res = await call('/exports', post({ requester: SELLER_A, sellerPublicKey: SELLER_B }));
        assert.equal(res.status, 403);
        assert.equal((await res.json()).code, 'EXPORT_FORBIDDEN');
        assert.equal(svc.size(), 0);
        assert.equal((await call('/exports', post({ requester: SELLER_A, sellerPublicKey: SELLER_A }))).status, 201);
      }, svc);
    });

    it('rejects invalid requests', async () => {
      await withServer(async (call) => {
        for (const body of [{}, { requester: 'bad' }, { requester: SELLER_A, format: 'xml' }, { requester: SELLER_A, status: 'NOPE' }, { requester: SELLER_A, from: 'yesterday' }]) {
          const res = await call('/exports', post(body));
          assert.equal(res.status, 400, JSON.stringify(body));
          assert.equal((await res.json()).code, 'INVALID_EXPORT_REQUEST');
        }
      });
    });

    it('returns 404 to other wallets, 410 after expiry, and 400 without a requester', async () => {
      await seed(SELLER_A, 1);
      const svc = service({ retentionMs: 1000 });
      await withServer(async (call) => {
        const { data } = await (await call('/exports', post({ requester: SELLER_A }))).json();
        assert.equal((await call(`/exports/${data.exportId}?requester=${SELLER_B}`)).status, 404);
        assert.equal((await call(`/exports/${data.exportId}`)).status, 400);
        assert.equal((await call(`/exports/${data.exportId}?requester=${SELLER_A}`)).status, 200);
        clock = new Date(clock.getTime() + 5000);
        const gone = await call(`/exports/${data.exportId}?requester=${SELLER_A}`);
        assert.equal(gone.status, 410);
        assert.equal((await gone.json()).code, 'EXPORT_EXPIRED');
        assert.equal((await call(`/exports/${data.exportId}?requester=${SELLER_B}`)).status, 404);
      }, svc);
    });

    it('returns 500 with a generic message when generation fails', async () => {
      const broken = { getInvoicesBySeller: async () => { throw new Error('db exploded: secret'); } } as unknown as InvoiceStorage;
      const original = console.error;
      console.error = () => {};
      try {
        await withServer(async (call) => {
          const res = await call('/exports', post({ requester: SELLER_A }));
          assert.equal(res.status, 500);
          const body = await res.json();
          assert.equal(body.code, 'EXPORT_FAILED');
          assert.equal(JSON.stringify(body).includes('secret'), false);
        }, undefined, broken);
      } finally {
        console.error = original;
      }
    });
  });
});
