/**
 * Safe cancellation for long-running imports and exports (#288).
 *
 * Cancellation is only safe if it can never leave half a result behind: an
 * import is either fully committed or fully rolled back, and an export either
 * stores a complete artifact or none.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { planImport } from '../src/imports/import-pipeline';
import { applyImport, rollbackImport, ImportCancelledError, type ImportClient } from '../src/imports/import-executor';
import { ExportService } from '../src/exports/export-service';
import { createExportRouter } from '../src/routes/export.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { InvoiceStorage } from '../src/storage/invoice-storage';

const SELLER = `G${'A'.repeat(55)}`;

const row = (externalId: string, line: number) => ({
  line,
  values: { externalId, sellerPublicKey: SELLER, amount: '10', description: 'Order' },
});

/** Records statements and lets a test act when a given statement runs. */
function client(onQuery: (statement: string) => void = () => {}) {
  const log: string[] = [];
  const state = {
    log,
    released: false,
    async query(text: string, params: unknown[] = []) {
      const statement = text.trim().split(/\s+/)[0]!;
      log.push(statement);
      onQuery(statement);
      return { rows: statement === 'INSERT' ? [{ id: params[0] }] : [], rowCount: 1 };
    },
    release() {
      state.released = true;
    },
  };
  return state as typeof state & ImportClient;
}

describe('Import cancellation', () => {
  const plan = planImport([row('A-1', 2), row('A-2', 3), row('A-3', 4)]);

  it('normal path: an unsignalled import commits', async () => {
    const c = client();
    const result = await applyImport({ connect: async () => c }, plan, { source: 't.csv', signal: new AbortController().signal });
    assert.equal(result.created.length, 3);
    assert.equal(c.log.at(-1), 'COMMIT');
  });

  it('a signal aborted before the run never opens a connection', async () => {
    const controller = new AbortController();
    controller.abort();
    let connected = false;
    await assert.rejects(
      applyImport({ connect: async () => ((connected = true), client()) }, plan, { source: 't.csv', signal: controller.signal }),
      ImportCancelledError
    );
    assert.equal(connected, false);
  });

  it('failure path: cancelling mid-file rolls back every row written so far', async () => {
    const controller = new AbortController();
    const c = client((statement) => {
      if (statement === 'INSERT') controller.abort();
    });
    await assert.rejects(applyImport({ connect: async () => c }, plan, { source: 't.csv', signal: controller.signal }), ImportCancelledError);
    assert.equal(c.log.filter((s) => s === 'INSERT').length, 1, 'stops at the next row boundary');
    assert.equal(c.log.at(-1), 'ROLLBACK');
    assert.ok(!c.log.includes('COMMIT'));
    assert.equal(c.released, true);
  });

  it('an abort that arrives after COMMIT is ignored and the snapshot is returned', async () => {
    const controller = new AbortController();
    const c = client((statement) => {
      if (statement === 'COMMIT') controller.abort();
    });
    const result = await applyImport({ connect: async () => c }, plan, { source: 't.csv', signal: controller.signal });
    assert.equal(result.snapshot.created.length, 3);
    assert.ok(!c.log.includes('ROLLBACK'));
  });

  it('retry path: a cancelled import can be re-run from the same plan', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(applyImport({ connect: async () => client() }, plan, { source: 't.csv', signal: controller.signal }));
    const result = await applyImport({ connect: async () => client() }, plan, { source: 't.csv' });
    assert.equal(result.created.length, 3);
  });

  it('cancelling a rollback leaves the applied import intact', async () => {
    const controller = new AbortController();
    const c = client((statement) => {
      if (statement === 'DELETE') controller.abort();
    });
    const snapshot = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      created: [
        { id: 'a', externalId: 'A-1', memo: 'INV-A-1' },
        { id: 'b', externalId: 'A-2', memo: 'INV-A-2' },
      ],
      updated: [],
    };
    await assert.rejects(rollbackImport({ connect: async () => c }, snapshot, controller.signal), ImportCancelledError);
    assert.equal(c.log.at(-1), 'ROLLBACK');
    assert.ok(!c.log.includes('COMMIT'));
  });
});

describe('Export cancellation', () => {
  /** Storage whose first page waits until the test opens the gate. */
  function gatedStorage() {
    memoryStorage.clear();
    const inner = new MemoryInvoiceStorage();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let audits = 0;
    const storage = Object.assign(Object.create(inner), {
      async getInvoicesBySeller(...args: Parameters<InvoiceStorage['getInvoicesBySeller']>) {
        entered();
        await gate;
        return inner.getInvoicesBySeller(...args);
      },
      async recordAuditEvent() {
        audits += 1;
        return {} as any;
      },
    }) as InvoiceStorage;
    return { inner, storage, open, started, audits: () => audits };
  }

  async function serve(storage: InvoiceStorage, service: ExportService, timeoutMs?: number) {
    const app = express();
    app.use(express.json());
    app.use('/api', createExportRouter({ storage, service, timeoutMs }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  it('failure path: a run past the deadline returns a retryable 503 and stores nothing', async () => {
    const env = gatedStorage();
    const service = new ExportService(env.storage);
    const { server, port } = await serve(env.storage, service, 20);
    try {
      const pending = fetch(`http://127.0.0.1:${port}/api/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requester: SELLER }),
      });
      await env.started;
      await new Promise((resolve) => setTimeout(resolve, 40));
      env.open();
      const res = await pending;
      const body = await res.json();
      assert.equal(res.status, 503);
      assert.equal(body.code, 'EXPORT_TIMED_OUT');
      assert.equal(body.retryable, true);
      assert.equal(service.size(), 0);
      assert.equal(env.audits(), 0);
    } finally {
      server.close();
    }
  });

  it('a client that disconnects mid-export cancels it: no artifact, no audit event', async () => {
    const env = gatedStorage();
    const service = new ExportService(env.storage);
    const { server, port } = await serve(env.storage, service);
    try {
      const req = http.request({ port, method: 'POST', path: '/api/exports', headers: { 'Content-Type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify({ requester: SELLER }));
      await env.started;
      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      env.open();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(service.size(), 0);
      assert.equal(env.audits(), 0);
    } finally {
      server.close();
    }
  });

  it('normal and retry path: the next request completes and is audited', async () => {
    const env = gatedStorage();
    env.open();
    const service = new ExportService(env.storage);
    const { server, port } = await serve(env.storage, service);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requester: SELLER }),
      });
      assert.equal(res.status, 201);
      assert.equal(service.size(), 1);
      assert.equal(env.audits(), 1);
    } finally {
      server.close();
    }
  });

  it('authorization path: cancellation never applies to another wallet, which is refused before any work', async () => {
    const env = gatedStorage();
    const service = new ExportService(env.storage);
    const { server, port } = await serve(env.storage, service);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requester: SELLER, sellerPublicKey: `G${'B'.repeat(55)}` }),
      });
      assert.equal(res.status, 403);
      assert.equal(service.size(), 0);
    } finally {
      server.close();
    }
  });
});
