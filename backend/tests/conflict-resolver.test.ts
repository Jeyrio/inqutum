import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveMultiClientConflict,
  ImmutableFieldConflictError,
  TerminalStatusConflictError,
  UnauthorizedEditError,
} from '../src/concurrency/conflict-resolver';
import type { StoredInvoice } from '../src/storage/invoice-storage';

function createMockInvoice(overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id: 'inv-12345',
    sellerPublicKey: 'GBZXN7PIRZGNMHGA728RGRFZAPPWN9G8391209384910293849102938',
    sellerName: 'Acme Corp',
    sellerEmail: 'billing@acme.com',
    amount: 500,
    assetCode: 'USDC',
    assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    memo: 'INV-12345-MEMO',
    description: 'Initial design work',
    customerName: 'Client Alice',
    customerEmail: 'alice@example.com',
    status: 'PENDING',
    createdAt: new Date('2026-03-01T10:00:00Z'),
    expiresAt: new Date('2026-03-08T10:00:00Z'),
    version: 1,
    metadata: { project: 'Stellar Redesign', phase: 1, tags: ['frontend', 'v1'] },
    ...overrides,
  };
}

describe('Deterministic Conflict Resolver (#284)', () => {
  it('clean merge: non-overlapping concurrent edits merge cleanly without data loss', () => {
    const base = createMockInvoice({ version: 1 });
    // Server modified description to v2
    const server = createMockInvoice({
      version: 2,
      description: 'Design work with revisions',
    });
    // Client updated customerEmail based on v1
    const clientUpdate = {
      customerEmail: 'alice.new@example.com',
    };

    const result = resolveMultiClientConflict(base, server, clientUpdate, { strategy: 'AUTO_MERGE' });

    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.hasConflicts, false);
    assert.ok(result.mergedInvoice);
    // Both edits are preserved
    assert.strictEqual(result.mergedInvoice.description, 'Design work with revisions');
    assert.strictEqual(result.mergedInvoice.customerEmail, 'alice.new@example.com');
    assert.strictEqual(result.mergedInvoice.version, 3);
    assert.strictEqual(result.resolvedFields.length, 1);
    assert.strictEqual(result.resolvedFields[0].field, 'customerEmail');
    assert.strictEqual(result.resolvedFields[0].resolution, 'CLEAN_MERGE');
  });

  it('convergent merge: concurrent edits setting the same value succeed as convergent', () => {
    const base = createMockInvoice({ version: 1, customerName: 'Client Alice' });
    const server = createMockInvoice({ version: 2, customerName: 'Alice Smith' });
    const clientUpdate = { customerName: 'Alice Smith' };

    const result = resolveMultiClientConflict(base, server, clientUpdate);

    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.hasConflicts, false);
    assert.strictEqual(result.mergedInvoice?.customerName, 'Alice Smith');
    assert.strictEqual(result.mergedInvoice?.version, 3);
    assert.strictEqual(result.resolvedFields[0].resolution, 'CONVERGENT');
  });

  it('deterministic tie-breaking: AUTO_MERGE chooses client edit when clientTimestamp is newer', () => {
    const base = createMockInvoice({ version: 1, description: 'Original description' });
    const server = createMockInvoice({
      version: 2,
      description: 'Server updated description',
      createdAt: new Date(1000),
    });
    const clientUpdate = { description: 'Client updated description' };

    // Client timestamp is newer than server
    const result = resolveMultiClientConflict(base, server, clientUpdate, {
      strategy: 'AUTO_MERGE',
      clientTimestamp: 2000,
    });

    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.hasConflicts, true);
    assert.strictEqual(result.mergedInvoice?.description, 'Client updated description');
    assert.strictEqual(result.mergedInvoice?.version, 3);
    assert.strictEqual(result.resolvedFields[0].resolution, 'TIE_BREAK_CLIENT');
  });

  it('deterministic tie-breaking: AUTO_MERGE preserves server edit when server is newer', () => {
    const base = createMockInvoice({ version: 1, description: 'Original description' });
    const server = createMockInvoice({
      version: 2,
      description: 'Server updated description',
      createdAt: new Date(5000),
    });
    const clientUpdate = { description: 'Client updated description' };

    // Client timestamp is older than server
    const result = resolveMultiClientConflict(base, server, clientUpdate, {
      strategy: 'AUTO_MERGE',
      clientTimestamp: 2000,
    });

    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.hasConflicts, true);
    assert.strictEqual(result.mergedInvoice?.description, 'Server updated description');
    assert.strictEqual(result.resolvedFields[0].resolution, 'TIE_BREAK_SERVER');
  });

  it('strategy SERVER_WINS: strictly preserves server value on collision', () => {
    const base = createMockInvoice({ version: 1, sellerName: 'Acme Old' });
    const server = createMockInvoice({ version: 2, sellerName: 'Acme Official' });
    const clientUpdate = { sellerName: 'Acme Alternate' };

    const result = resolveMultiClientConflict(base, server, clientUpdate, {
      strategy: 'SERVER_WINS',
    });

    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.hasConflicts, true);
    assert.strictEqual(result.mergedInvoice?.sellerName, 'Acme Official');
    assert.strictEqual(result.resolvedFields[0].resolution, 'TIE_BREAK_SERVER');
  });

  it('strategy CLIENT_WINS: strictly applies client value on collision', () => {
    const base = createMockInvoice({ version: 1, sellerName: 'Acme Old' });
    const server = createMockInvoice({ version: 2, sellerName: 'Acme Official' });
    const clientUpdate = { sellerName: 'Acme Alternate' };

    const result = resolveMultiClientConflict(base, server, clientUpdate, {
      strategy: 'CLIENT_WINS',
    });

    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.hasConflicts, true);
    assert.strictEqual(result.mergedInvoice?.sellerName, 'Acme Alternate');
    assert.strictEqual(result.resolvedFields[0].resolution, 'TIE_BREAK_CLIENT');
  });

  it('strategy STRICT: returns unresolvable conflict on direct collision', () => {
    const base = createMockInvoice({ version: 1, description: 'Base text' });
    const server = createMockInvoice({ version: 2, description: 'Server text' });
    const clientUpdate = { description: 'Client text' };

    const result = resolveMultiClientConflict(base, server, clientUpdate, {
      strategy: 'STRICT',
    });

    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.hasConflicts, true);
    assert.strictEqual(result.mergedInvoice, null);
    assert.strictEqual(result.unresolvedFields.length, 1);
    assert.strictEqual(result.unresolvedFields[0].field, 'description');
    assert.match(result.summary, /Manual intervention required/);
  });

  it('deep metadata merge: non-conflicting nested keys merge cleanly and scalar collisions resolve', () => {
    const base = createMockInvoice({
      version: 1,
      metadata: { billingId: 'B-100', department: 'Eng', config: { retries: 3 } },
    });
    const server = createMockInvoice({
      version: 2,
      metadata: { billingId: 'B-100', department: 'Sales', config: { retries: 3 } },
    });
    const clientUpdate = {
      metadata: { billingId: 'B-100', department: 'Eng', config: { retries: 5, timeout: 30 } },
    };

    const result = resolveMultiClientConflict(base, server, clientUpdate, {
      strategy: 'AUTO_MERGE',
      clientTimestamp: 10000,
    });

    assert.strictEqual(result.resolved, true);
    assert.ok(result.mergedInvoice);
    const meta = result.mergedInvoice.metadata;
    assert.strictEqual(meta.billingId, 'B-100');
    // timeout was cleanly merged from client
    assert.strictEqual(meta.config.timeout, 30);
    // retries collision resolved deterministically
    assert.strictEqual(meta.config.retries, 5);
  });

  it('immutability guard: rejects attempts to modify financial settlement fields', () => {
    const base = createMockInvoice();
    const server = createMockInvoice();

    for (const forbiddenField of ['amount', 'assetCode', 'memo', 'sellerPublicKey', 'id']) {
      const clientUpdate = { [forbiddenField]: 'tampered-value' };
      assert.throws(
        () => resolveMultiClientConflict(base, server, clientUpdate as any),
        (err: any) => {
          assert.ok(err instanceof ImmutableFieldConflictError);
          assert.strictEqual(err.code, 'IMMUTABLE_FIELD_CONFLICT');
          assert.strictEqual(err.httpStatus, 400);
          return true;
        }
      );
    }
  });

  it('terminal status protection: rejects edits when invoice is in terminal status (PAID, CANCELLED, EXPIRED)', () => {
    for (const terminalStatus of ['PAID', 'CANCELLED', 'EXPIRED'] as const) {
      const base = createMockInvoice({ status: 'PENDING' });
      const server = createMockInvoice({ status: terminalStatus });
      const clientUpdate = { description: 'Updated note' };

      assert.throws(
        () => resolveMultiClientConflict(base, server, clientUpdate),
        (err: any) => {
          assert.ok(err instanceof TerminalStatusConflictError);
          assert.strictEqual(err.code, 'TERMINAL_STATUS_CONFLICT');
          assert.strictEqual(err.httpStatus, 409);
          return true;
        }
      );
    }
  });

  it('authorization path: rejects edit when actor is unprivileged (VIEWER)', () => {
    const base = createMockInvoice();
    const server = createMockInvoice();
    const clientUpdate = { description: 'Updated note' };

    assert.throws(
      () =>
        resolveMultiClientConflict(base, server, clientUpdate, {
          actorRole: 'VIEWER',
          actorId: 'viewer-alice',
        }),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedEditError);
        assert.strictEqual(err.code, 'UNAUTHORIZED_EDIT');
        assert.strictEqual(err.httpStatus, 403);
        return true;
      }
    );
  });
});
