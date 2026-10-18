import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  verifySchemaRollback,
  verifyDeploymentRollback,
  runFullRollbackVerification,
  UnauthorizedRollbackVerificationError,
  type SchemaBaseline,
  type MigrationDatabaseClient,
  type DeploymentProbeClient,
} from '../src/ops/rollback-verification';

function createMockDb(tables: Array<{ table_name: string; table_type: string }>, columns: Array<{ table_name: string; column_name: string }>, locks: boolean = false): MigrationDatabaseClient {
  return {
    async query(text: string) {
      if (text.includes('information_schema.tables')) {
        return { rows: tables };
      }
      if (text.includes('information_schema.columns')) {
        return { rows: columns };
      }
      if (text.includes('migrations_lock')) {
        return { rows: locks ? [{ is_locked: true }] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('Rollback Verification Engine (#301)', () => {
  const baseline: SchemaBaseline = {
    tables: ['invoices', 'transactions', 'payment_events'],
    views: ['invoice_stats'],
    columns: {
      invoices: ['id', 'seller_public_key', 'amount', 'status', 'created_at', 'expires_at'],
      transactions: ['id', 'invoice_id', 'tx_hash'],
      payment_events: ['id', 'invoice_id', 'event_type'],
    },
  };

  it('normal path: schema perfectly matching pre-migration baseline passes verification', async () => {
    const db = createMockDb(
      [
        { table_name: 'invoices', table_type: 'BASE TABLE' },
        { table_name: 'transactions', table_type: 'BASE TABLE' },
        { table_name: 'payment_events', table_type: 'BASE TABLE' },
        { table_name: 'invoice_stats', table_type: 'VIEW' },
      ],
      [
        { table_name: 'invoices', column_name: 'id' },
        { table_name: 'invoices', column_name: 'seller_public_key' },
        { table_name: 'invoices', column_name: 'amount' },
        { table_name: 'invoices', column_name: 'status' },
        { table_name: 'invoices', column_name: 'created_at' },
        { table_name: 'invoices', column_name: 'expires_at' },
        { table_name: 'transactions', column_name: 'id' },
        { table_name: 'transactions', column_name: 'invoice_id' },
        { table_name: 'transactions', column_name: 'tx_hash' },
        { table_name: 'payment_events', column_name: 'id' },
        { table_name: 'payment_events', column_name: 'invoice_id' },
        { table_name: 'payment_events', column_name: 'event_type' },
      ]
    );

    const result = await verifySchemaRollback(db, baseline, { actorRole: 'ADMIN' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.missingTables.length, 0);
    assert.strictEqual(result.extraneousTables.length, 0);
    assert.strictEqual(result.missingColumns.length, 0);
    assert.strictEqual(result.extraneousColumns.length, 0);
    assert.strictEqual(result.remediationSql.length, 0);
  });

  it('detects extraneous tables and columns created by aborted migration', async () => {
    // Database has an extra table 'experimental_audit_v2' and extra column 'invoices.bad_column'
    const db = createMockDb(
      [
        { table_name: 'invoices', table_type: 'BASE TABLE' },
        { table_name: 'transactions', table_type: 'BASE TABLE' },
        { table_name: 'payment_events', table_type: 'BASE TABLE' },
        { table_name: 'invoice_stats', table_type: 'VIEW' },
        { table_name: 'experimental_audit_v2', table_type: 'BASE TABLE' },
      ],
      [
        { table_name: 'invoices', column_name: 'id' },
        { table_name: 'invoices', column_name: 'seller_public_key' },
        { table_name: 'invoices', column_name: 'amount' },
        { table_name: 'invoices', column_name: 'status' },
        { table_name: 'invoices', column_name: 'created_at' },
        { table_name: 'invoices', column_name: 'expires_at' },
        { table_name: 'invoices', column_name: 'bad_column' },
        { table_name: 'transactions', column_name: 'id' },
        { table_name: 'transactions', column_name: 'invoice_id' },
        { table_name: 'transactions', column_name: 'tx_hash' },
        { table_name: 'payment_events', column_name: 'id' },
        { table_name: 'payment_events', column_name: 'invoice_id' },
        { table_name: 'payment_events', column_name: 'event_type' },
      ]
    );

    const result = await verifySchemaRollback(db, baseline, { actorRole: 'ADMIN' });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.extraneousTables, ['experimental_audit_v2']);
    assert.strictEqual(result.extraneousColumns.length, 1);
    assert.strictEqual(result.extraneousColumns[0].column, 'bad_column');

    // Generates deterministic remediation SQL
    assert.ok(result.remediationSql.some((s) => s.includes('DROP TABLE IF EXISTS public.experimental_audit_v2')));
    assert.ok(result.remediationSql.some((s) => s.includes('DROP COLUMN IF EXISTS bad_column')));
  });

  it('detects missing baseline tables and views after incomplete restore', async () => {
    const db = createMockDb(
      [
        { table_name: 'invoices', table_type: 'BASE TABLE' },
        // transactions and invoice_stats view are missing
      ],
      [{ table_name: 'invoices', column_name: 'id' }]
    );

    const result = await verifySchemaRollback(db, baseline, { actorRole: 'ADMIN' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.missingTables.includes('transactions'));
    assert.ok(result.missingViews.includes('invoice_stats'));
  });

  it('detects active migration lock left behind', async () => {
    const db = createMockDb(
      [
        { table_name: 'invoices', table_type: 'BASE TABLE' },
        { table_name: 'transactions', table_type: 'BASE TABLE' },
        { table_name: 'payment_events', table_type: 'BASE TABLE' },
        { table_name: 'invoice_stats', table_type: 'VIEW' },
        { table_name: 'migrations_lock', table_type: 'BASE TABLE' },
      ],
      [],
      true // lock active!
    );

    const result = await verifySchemaRollback(db, { tables: ['invoices', 'transactions', 'payment_events', 'migrations_lock'], columns: {} });
    assert.strictEqual(result.ok, false);
    assert.ok(result.dirtyMarkers.includes('MIGRATION_LOCK_ACTIVE'));
    assert.ok(result.remediationSql.some((s) => s.includes('is_locked = false')));
  });

  it('deployment rollback: verifies healthy endpoints and exact target version', async () => {
    const mockProbe: DeploymentProbeClient = {
      async fetch(url: string) {
        if (url.endsWith('/health')) {
          return {
            status: 200,
            json: async () => ({ status: 'ok', version: 'v1.4.2' }),
            headers: { get: () => 'v1.4.2' },
          };
        }
        return { status: 200, json: async () => ({ ready: true }) };
      },
    };

    const result = await verifyDeploymentRollback('http://localhost:3001/api', mockProbe, {
      expectedVersion: 'v1.4.2',
      actorRole: 'ADMIN',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.livenessOk, true);
    assert.strictEqual(result.readinessOk, true);
    assert.strictEqual(result.versionMatch, true);
    assert.strictEqual(result.observedVersion, 'v1.4.2');
  });

  it('deployment rollback: detects version mismatch when rollback did not deploy expected version', async () => {
    const mockProbe: DeploymentProbeClient = {
      async fetch() {
        return {
          status: 200,
          json: async () => ({ status: 'ok', version: 'v1.5.0-bad' }), // wrong version!
          headers: { get: () => 'v1.5.0-bad' },
        };
      },
    };

    const result = await verifyDeploymentRollback('http://localhost:3001/api', mockProbe, {
      expectedVersion: 'v1.4.2',
      actorRole: 'ADMIN',
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.versionMatch, false);
    assert.strictEqual(result.observedVersion, 'v1.5.0-bad');
    assert.ok(result.remediation.some((r) => r.includes("Version mismatch: expected 'v1.4.2'")));
  });

  it('deployment rollback retry path: recovers on transient connection error', async () => {
    let callCount = 0;
    const mockProbe: DeploymentProbeClient = {
      async fetch() {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNREFUSED - container starting up');
        }
        return {
          status: 200,
          json: async () => ({ status: 'ok', version: 'v1.4.2' }),
          headers: { get: () => 'v1.4.2' },
        };
      },
    };

    const result = await verifyDeploymentRollback('http://localhost:3001/api', mockProbe, {
      expectedVersion: 'v1.4.2',
      maxRetries: 2,
      initialBackoffMs: 10,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(callCount >= 2, true);
  });

  it('authorization path: unprivileged role is rejected from executing rollback verification', async () => {
    const db = createMockDb([], []);
    await assert.rejects(
      () => verifySchemaRollback(db, baseline, { actorRole: 'VIEWER' as any }),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedRollbackVerificationError);
        assert.strictEqual(err.code, 'UNAUTHORIZED_ROLLBACK_VERIFICATION');
        assert.strictEqual(err.httpStatus, 403);
        return true;
      }
    );
  });

  it('runFullRollbackVerification executes combined report', async () => {
    const db = createMockDb(
      [{ table_name: 'invoices', table_type: 'BASE TABLE' }],
      [{ table_name: 'invoices', column_name: 'id' }]
    );
    const mockProbe: DeploymentProbeClient = {
      async fetch() {
        return { status: 200, json: async () => ({ ok: true }) };
      },
    };

    const report = await runFullRollbackVerification({
      db,
      baseline: { tables: ['invoices'], columns: { invoices: ['id'] } },
      baseUrl: 'http://localhost:3001/api',
      probeClient: mockProbe,
      options: { actorRole: 'ADMIN', actorId: 'lead-devops' },
    });

    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.scope, 'FULL');
    assert.strictEqual(report.authorizedBy, 'lead-devops');
    assert.strictEqual(report.exitCode, 0);
  });
});
