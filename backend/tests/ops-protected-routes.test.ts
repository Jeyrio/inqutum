/**
 * HTTP-level checks for the ops routes added with #195, #196 and #197:
 * the anomaly report, signed approvals and approval-gated archival.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOpsRouter } from '../src/routes/ops.routes';
import { correlationMiddleware } from '../src/observability/telemetry';
import { auditStore } from '../src/audit/audit-service';
import { SignedApprovalService } from '../src/ops/signed-approval';
import type { StoredInvoice } from '../src/storage/invoice-storage';

const ADMIN = 'admin-token-for-tests';
const REASON = 'Quarterly cleanup of settled invoices';
const old = new Date(Date.now() - 90 * 86_400_000);

const invoices = new Map<string, StoredInvoice>([
  ['inv-paid', { id: 'inv-paid', sellerPublicKey: 'G'.padEnd(56, 'A'), amount: 5, assetCode: 'XLM', memo: 'm', status: 'PAID', createdAt: old, paidAt: old, settledAt: old, expiresAt: old, version: 2 }],
  ['inv-pending', { id: 'inv-pending', sellerPublicKey: 'G'.padEnd(56, 'A'), amount: 5, assetCode: 'XLM', memo: 'm', status: 'PENDING', createdAt: old, expiresAt: new Date(Date.now() + 86_400_000), version: 1 }],
]);

let server: Server;
let base: string;
let signed: SignedApprovalService;

before(async () => {
  signed = new SignedApprovalService({ secret: 'route-test-secret-long-enough' });
  const storage = { getInvoiceById: async (id: string) => invoices.get(id) ?? null } as any;
  const app = express();
  app.use(correlationMiddleware());
  app.use(express.json());
  app.use(
    '/api',
    createOpsRouter({
      storage,
      adminToken: ADMIN,
      approvals: null,
      capabilities: null,
      signedApprovals: signed,
    })
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => auditStore.clear());

async function call(method: string, path: string, body?: unknown, token: string | null = ADMIN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const approval = async (action: string, target: string, signer = 'bob') => {
  const res = await call('POST', '/ops/signed-approvals', { action, target, actor: 'alice', signer, reason: REASON });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

describe('GET /ops/anomalies', () => {
  it('requires the admin token', async () => {
    assert.equal((await call('GET', '/ops/anomalies', undefined, null)).status, 401);
  });

  it('reports repeated failures recorded in the audit trail, read-only', async () => {
    for (let i = 0; i < 6; i++) {
      auditStore.recordEvent({
        action: 'IMPERSONATION_ACTION_BLOCKED',
        actor: { type: 'maintainer', id: 'm-9' },
        scope: { entityType: 'invoice', entityId: 'inv-7' },
      });
    }
    const before = auditStore.listChronological().length;
    const res = await call('GET', '/ops/anomalies');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.findings.map((f: any) => f.signal).sort(), ['REPEATED_FAILURE']);
    assert.equal(res.body.data.findings[0].resource, 'invoice:inv-7');
    assert.equal(auditStore.listChronological().length, before);
  });
});

describe('approval-gated archival', () => {
  it('refuses to archive without an approval', async () => {
    const res = await call('POST', '/ops/invoices/inv-paid/archive', { actor: 'alice', reason: REASON });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'APPROVAL_REQUIRED');
  });

  it('archives and restores with valid approvals and records audit events', async () => {
    const a1 = await approval('invoice.archive', 'inv-paid');
    const archived = await call('POST', '/ops/invoices/inv-paid/archive', { actor: 'alice', reason: REASON, approvals: [a1] });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.data.state, 'ARCHIVED');
    assert.equal((await call('GET', '/ops/invoices/inv-paid/history')).body.data.lifecycleState, 'ARCHIVED');

    // the same approval cannot be replayed, nor used for a different action
    const replay = await call('POST', '/ops/invoices/inv-paid/restore', { actor: 'alice', reason: REASON, approvals: [a1] });
    assert.equal(replay.body.code, 'APPROVAL_ACTION_MISMATCH');

    const a2 = await approval('invoice.restore', 'inv-paid');
    const restored = await call('POST', '/ops/invoices/inv-paid/restore', { actor: 'alice', reason: REASON, approvals: [a2] });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.data.state, 'ACTIVE');
    assert.equal(restored.body.data.archivedStatus, 'PAID');

    const actions = auditStore.listChronological().map((e) => e.action);
    assert.ok(actions.includes('INVOICE_ARCHIVED') && actions.includes('INVOICE_RESTORED'));
  });

  it('denies archival of ineligible invoices even with a valid approval, and reports why', async () => {
    const a = await approval('invoice.archive', 'inv-pending');
    const res = await call('POST', '/ops/invoices/inv-pending/archive', { actor: 'alice', reason: REASON, approvals: [a] });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOT_TERMINAL');
    const info = await call('GET', '/ops/invoices/inv-pending/archive');
    assert.deepEqual([info.body.data.eligible, info.body.data.denials[0].code], [false, 'NOT_TERMINAL']);
  });

  it('rejects an approval used by a different actor', async () => {
    const a = await approval('invoice.archive', 'inv-paid');
    const res = await call('POST', '/ops/invoices/inv-paid/archive', { actor: 'mallory', reason: REASON, approvals: [a] });
    assert.equal(res.body.code, 'APPROVAL_ACTOR_MISMATCH');
  });
});

describe('signed approvals disabled', () => {
  it('fails closed when no secret is configured', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: {} as any, adminToken: ADMIN, approvals: null, capabilities: null, signedApprovals: null }));
    const s = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/ops/invoices/x/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
        body: '{}',
      });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as any).code, 'SIGNED_APPROVALS_DISABLED');
    } finally {
      s.close();
    }
  });
});
