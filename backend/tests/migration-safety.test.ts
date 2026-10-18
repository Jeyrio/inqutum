import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseSchemaSql,
  previewMigration,
  runPostChecks,
  rollbackNotes,
  formatPreview,
  formatPostChecks,
  type MigrationDatabase,
} from '../src/db/migration-safety';

const SCHEMA_PATH = path.join(__dirname, '../../db/schema.sql');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

/**
 * Fake pg surface. `state` describes what the live database looks like so both
 * the converged and the half-migrated case can be exercised without Postgres.
 */
interface FakeState {
  tables: Set<string>;
  views: Set<string>;
  indexes: Set<string>;
  columns: Set<string>; // "table.column"
  rowCounts: Record<string, number>;
  /** Columns to answer NULL counts for during the backfill check. */
  nullCounts: Record<string, number>;
  failOn?: string;
}

function fakeDb(state: FakeState): MigrationDatabase {
  return {
    async query(text: string, params: unknown[] = []) {
      if (state.failOn && text.includes(state.failOn)) {
        throw new Error(`simulated failure: ${state.failOn}`);
      }
      if (text.includes('pg_class')) {
        const [name, kinds] = params as [string, string[]];
        const pool = state.tables.has(name) ? state.tables : state.views.has(name) ? state.views : state.indexes;
        if (!pool || !pool.has(name)) return { rows: [] };
        const relkind = kinds.includes('r') ? 'table' : kinds.includes('v') ? 'view' : 'index';
        const matches =
          (relkind === 'table' && state.tables.has(name)) ||
          (relkind === 'view' && state.views.has(name)) ||
          (relkind === 'index' && state.indexes.has(name));
        return { rows: matches ? [{ '?column?': 1 }] : [] };
      }
      if (text.includes('information_schema.columns')) {
        const [table, column] = params as [string, string];
        return { rows: state.columns.has(`${table}.${column}`) ? [{ '?column?': 1 }] : [] };
      }
      // The backfill probe is a COUNT(*) with a WHERE clause, so it also
      // matches the generic count prefix below. Match it first, otherwise the
      // generic branch shadows it and the check always reports "complete".
      if (text.includes('WHERE expires_at IS NULL')) {
        const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? '';
        return { rows: [{ count: state.nullCounts[table] ?? 0 }] };
      }
      if (text.includes('COUNT(*)::int AS count FROM "')) {
        const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? '';
        return { rows: [{ count: state.rowCounts[table] ?? 0 }] };
      }
      return { rows: [] };
    },
  };
}

function emptyState(): FakeState {
  return {
    tables: new Set(),
    views: new Set(),
    indexes: new Set(),
    columns: new Set(),
    rowCounts: {},
    nullCounts: {},
  };
}

describe('Migration safety framework (Issue #75)', () => {
  const plan = parseSchemaSql(schema);
  let state: FakeState;

  beforeEach(() => {
    state = emptyState();
  });

  describe('Planning', () => {
    it('plans every DDL statement in the real schema file', () => {
      const kinds = new Set(plan.actions.map((a) => a.kind));
      for (const expected of [
        'create-table',
        'create-index',
        'create-view',
        'add-column',
        'drop-column',
        'drop-table',
        'data-update',
        'alter-column',
      ]) {
        assert.ok(kinds.has(expected as any), `expected plan to include ${expected}`);
      }
    });

    it('flags destructive and data-touching actions', () => {
      assert.ok(plan.destructive.some((a) => a.kind === 'drop-table' && a.name === 'users'));
      assert.ok(plan.destructive.some((a) => a.kind === 'drop-column' && a.name === 'invoices.user_id'));
      assert.ok(plan.dataChanges.some((a) => a.kind === 'data-update' && a.table === 'invoices'));
    });

    it('treats an empty database as unconverged', () => {
      assert.equal(plan.isConverged, false);
    });

    it('ignores comments and blank statements', () => {
      const noisy = parseSchemaSql('-- just a comment\n\n  \n');
      assert.deepEqual(noisy.actions, []);
      assert.equal(noisy.isConverged, true);
    });
  });

  describe('Preview before writes', () => {
    it('reports what would be created on an empty database', async () => {
      const preview = await previewMigration(plan, fakeDb(state));

      assert.ok(preview.wouldCreate.includes('invoices'));
      assert.ok(preview.wouldCreate.includes('invoice_stats'));
      assert.ok(preview.wouldCreate.includes('idx_jobs_due'));
      assert.equal(preview.alreadyPresent.length, 0);
    });

    it('skips objects that already exist', async () => {
      state.tables.add('invoices');
      state.views.add('invoice_stats');
      state.indexes.add('idx_jobs_due');
      state.columns.add('invoices.version');

      const preview = await previewMigration(plan, fakeDb(state));

      assert.ok(preview.alreadyPresent.includes('invoices'));
      assert.ok(preview.alreadyPresent.includes('invoice_stats'));
      assert.ok(preview.alreadyPresent.includes('invoices.version'));
      assert.equal(preview.wouldCreate.includes('invoices'), false);
    });

    it('reports affected record counts before any write', async () => {
      state.rowCounts.invoices = 1_234;
      const preview = await previewMigration(plan, fakeDb(state));

      const affected = preview.affectedRecords.find((r) => r.table === 'invoices');
      assert.equal(affected?.matchingRows, 1_234);
    });

    it('degrades to "unknown" rather than claiming zero rows', async () => {
      state.failOn = 'COUNT(*)';
      const preview = await previewMigration(plan, fakeDb(state));
      const affected = preview.affectedRecords.find((r) => r.table === 'invoices');
      assert.equal(affected?.matchingRows, null);
    });

    it('prints rollback guidance for the destructive steps', async () => {
      const notes = rollbackNotes(plan);
      assert.ok(notes.some((n) => n.includes('invoices.user_id')));
      assert.ok(notes.some((n) => n.includes('users')));
      assert.ok(notes.some((n) => /pre-migration dump/i.test(n)));
      assert.equal(formatPreview(await previewMigration(plan, fakeDb(state))).includes('Rollback'), true);
    });
  });

  describe('Post-checks — successful migration', () => {
    it('passes when every planned object exists', async () => {
      for (const action of plan.creates) {
        if (action.kind === 'create-table' && action.table) state.tables.add(action.table);
        if (action.kind === 'create-view') state.views.add(action.name);
        if (action.kind === 'create-index') state.indexes.add(action.name);
        if (action.kind === 'add-column' && action.table && action.column) {
          state.columns.add(`${action.table}.${action.column}`);
        }
      }

      const report = await runPostChecks(fakeDb(state), plan);

      assert.equal(report.ok, true, JSON.stringify(report.failures));
      assert.equal(report.failures.length, 0);
      assert.ok(report.checks.length > 0);
      assert.ok(formatPostChecks(report).includes('All post-checks passed.'));
    });

    it('confirms the backfill left no NULL expires_at rows', async () => {
      for (const action of plan.creates) {
        if (action.kind === 'create-table' && action.table) state.tables.add(action.table);
        if (action.kind === 'create-view') state.views.add(action.name);
        if (action.kind === 'create-index') state.indexes.add(action.name);
        if (action.kind === 'add-column' && action.table && action.column) {
          state.columns.add(`${action.table}.${action.column}`);
        }
      }
      state.nullCounts.invoices = 0;

      const report = await runPostChecks(fakeDb(state), plan);
      const backfill = report.checks.find((c) => c.name.includes('NULL expires_at'));
      assert.equal(backfill?.ok, true);
    });
  });

  describe('Post-checks — failed / partial migration', () => {
    it('detects a table that never landed', async () => {
      for (const action of plan.creates) {
        if (action.kind === 'create-table' && action.table && action.table !== 'jobs') {
          state.tables.add(action.table);
        }
        if (action.kind === 'create-view') state.views.add(action.name);
        if (action.kind === 'create-index') state.indexes.add(action.name);
        if (action.kind === 'add-column' && action.table && action.column) {
          state.columns.add(`${action.table}.${action.column}`);
        }
      }

      const report = await runPostChecks(fakeDb(state), plan);

      assert.equal(report.ok, false);
      const failure = report.failures.find((f) => f.name === 'table jobs exists');
      assert.ok(failure, 'expected a failure for the missing table');
      assert.equal(failure?.detail, 'missing after migration');
    });

    it('detects an index that silently did not get created', async () => {
      for (const action of plan.creates) {
        if (action.kind === 'create-table' && action.table) state.tables.add(action.table);
        if (action.kind === 'create-view') state.views.add(action.name);
        if (action.kind === 'create-index' && action.name !== 'idx_invoices_memo') {
          state.indexes.add(action.name);
        }
        if (action.kind === 'add-column' && action.table && action.column) {
          state.columns.add(`${action.table}.${action.column}`);
        }
      }

      const report = await runPostChecks(fakeDb(state), plan);
      const failure = report.failures.find((f) => f.name === 'index idx_invoices_memo exists');
      assert.ok(failure);
    });

    it('detects an incomplete backfill', async () => {
      for (const action of plan.creates) {
        if (action.kind === 'create-table' && action.table) state.tables.add(action.table);
        if (action.kind === 'create-view') state.views.add(action.name);
        if (action.kind === 'create-index') state.indexes.add(action.name);
        if (action.kind === 'add-column' && action.table && action.column) {
          state.columns.add(`${action.table}.${action.column}`);
        }
      }
      state.nullCounts.invoices = 42;

      const report = await runPostChecks(fakeDb(state), plan);
      const failure = report.failures.find((c) => c.name.includes('NULL expires_at'));
      assert.ok(failure);
      assert.match(String(failure?.detail), /42 row/);
    });

    it('detects a missing column added by the migration', async () => {
      for (const action of plan.creates) {
        if (action.kind === 'create-table' && action.table) state.tables.add(action.table);
        if (action.kind === 'create-view') state.views.add(action.name);
        if (action.kind === 'create-index') state.indexes.add(action.name);
      }

      const report = await runPostChecks(fakeDb(state), plan);
      assert.ok(report.failures.some((f) => f.name === 'column invoices.version exists'));
    });
  });
});
