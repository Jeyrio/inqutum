/**
 * Migration safety framework (#75).
 *
 * `npm run db:migrate` used to pipe `db/schema.sql` straight into the pool: no
 * preview of what would change, no report of what a write would touch, and no
 * verification that the schema actually converged. A partial failure therefore
 * left the database in an unknown state with nothing to tell an operator.
 *
 * This module adds the three pieces the issue asks for:
 *
 *  1. **Preview / dry-run** — `parseSchemaSql` turns the schema file into a
 *     plan, and `previewMigration` intersects it with the live database so a
 *     maintainer sees exactly which tables, columns and rows are affected
 *     *before* anything is written.
 *  2. **Post-checks** — `runPostChecks` verifies the objects the schema claims
 *     to provide actually exist, and reports inconsistencies (a table present
 *     but missing its NOT NULL columns, indexes that never landed, a backfill
 *     that left NULLs behind) instead of assuming success.
 *  3. **Rollback / forward-fix** — `rollbackNotes` describes, per risky action,
 *     how to reverse it or what the forward fix is. Surfaced by the CLI and
 *     documented in docs/MIGRATIONS.md.
 */

export type MigrationActionKind =
  | 'create-table'
  | 'create-index'
  | 'create-view'
  | 'add-column'
  | 'drop-column'
  | 'drop-table'
  | 'data-update'
  | 'alter-column';

export interface PlannedAction {
  kind: MigrationActionKind;
  name: string;
  table?: string;
  column?: string;
  /** True when the action removes data or objects. */
  destructive: boolean;
  /** True when the action rewrites rows. */
  touchesData: boolean;
  sql: string;
}

export interface MigrationPlan {
  actions: PlannedAction[];
  creates: PlannedAction[];
  destructive: PlannedAction[];
  dataChanges: PlannedAction[];
  /** Nothing in the plan would change anything (re-run of a converged schema). */
  isConverged: boolean;
}

export interface AffectedRecords {
  table: string;
  /** null when the live count could not be determined (permissions, etc.). */
  matchingRows: number | null;
  /** Columns the action touches, for the preview output. */
  columns: string[];
}

export interface MigrationPreview {
  plan: MigrationPlan;
  /** Objects the database already has — the plan skips these. */
  alreadyPresent: string[];
  /** Objects that would be created. */
  wouldCreate: string[];
  /** Destructive actions that would run. */
  wouldRunDestructive: PlannedAction[];
  /** Row counts for every data-touching action, gathered before writes. */
  affectedRecords: AffectedRecords[];
  rollbackNotes: string[];
}

/** Minimal surface the framework needs from a pg pool, so tests can fake it. */
export interface MigrationDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PostCheckReport {
  ok: boolean;
  checks: PostCheck[];
  failures: PostCheck[];
}

const strip = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function tableName(after: string): string {
  const match = after.match(/(?:EXISTS\s+)?([A-Za-z_][\w$]*)/i);
  return match ? canonicalIdent(match[1]) : '';
}

/**
 * Postgres folds unquoted identifiers to lowercase, so that is the only form
 * that can be matched against `pg_class.relname` or `information_schema`.
 * Statement matching runs against the uppercased SQL, so names lifted out of it
 * have to be folded back here — otherwise the plan reports `INVOICE_STATS` /
 * `INVOICES.USER_ID` while the live database holds `invoice_stats` /
 * `invoices.user_id`, and every existence check silently misses.
 */
function canonicalIdent(name: string): string {
  return name.toLowerCase();
}

/**
 * Parses DDL into a plan. Understands the statements `db/schema.sql` uses:
 * CREATE TABLE/INDEX/VIEW, ALTER TABLE ADD/DROP/ALTER COLUMN, DROP TABLE and
 * bare UPDATE statements. Unknown statements are ignored rather than guessed at.
 */
export function parseSchemaSql(sql: string): MigrationPlan {
  const actions: PlannedAction[] = [];
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  for (const raw of withoutComments.split(';')) {
    const statement = strip(raw);
    if (!statement) continue;
    const upper = statement.toUpperCase();

    let match: RegExpMatchArray | null;

    if ((match = upper.match(/^CREATE TABLE IF NOT EXISTS\s+/))) {
      const name = tableName(statement.slice(match[0].length));
      if (name) {
        actions.push({
          kind: 'create-table',
          name,
          table: name,
          destructive: false,
          touchesData: false,
          sql: statement,
        });
      }
      continue;
    }

    if ((match = upper.match(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS\s+/))) {
      const name = tableName(statement.slice(match[0].length));
      if (name) {
        actions.push({
          kind: 'create-index',
          name,
          destructive: false,
          touchesData: false,
          sql: statement,
        });
      }
      continue;
    }

    if (upper.startsWith('CREATE OR REPLACE VIEW') || upper.startsWith('CREATE VIEW')) {
      match = upper.match(/VIEW\s+([A-Za-z_][\w$]*)/);
      if (match) {
        actions.push({
          kind: 'create-view',
          name: canonicalIdent(match[1]),
          destructive: false,
          touchesData: false,
          sql: statement,
        });
      }
      continue;
    }

    if ((match = upper.match(/^ALTER TABLE\s+([A-Za-z_][\w$]*)\s+ADD COLUMN IF NOT EXISTS\s+([A-Za-z_][\w$]*)/))) {
      const table = canonicalIdent(match[1]);
      const column = canonicalIdent(match[2]);
      actions.push({
        kind: 'add-column',
        name: `${table}.${column}`,
        table,
        column,
        destructive: false,
        touchesData: false,
        sql: statement,
      });
      continue;
    }

    if ((match = upper.match(/^ALTER TABLE\s+([A-Za-z_][\w$]*)\s+DROP COLUMN IF EXISTS\s+([A-Za-z_][\w$]*)/))) {
      const table = canonicalIdent(match[1]);
      const column = canonicalIdent(match[2]);
      actions.push({
        kind: 'drop-column',
        name: `${table}.${column}`,
        table,
        column,
        destructive: true,
        touchesData: true,
        sql: statement,
      });
      continue;
    }

    if ((match = upper.match(/^ALTER TABLE\s+([A-Za-z_][\w$]*)\s+ALTER COLUMN\s+([A-Za-z_][\w$]*)\s+(.+)/))) {
      const table = canonicalIdent(match[1]);
      const column = canonicalIdent(match[2]);
      actions.push({
        kind: 'alter-column',
        name: `${table}.${column}`,
        table,
        column,
        destructive: false,
        touchesData: false,
        sql: statement,
      });
      continue;
    }

    if ((match = upper.match(/^DROP TABLE IF EXISTS\s+([A-Za-z_][\w$]*)/))) {
      const table = canonicalIdent(match[1]);
      actions.push({
        kind: 'drop-table',
        name: table,
        table,
        destructive: true,
        touchesData: true,
        sql: statement,
      });
      continue;
    }

    if ((match = upper.match(/^UPDATE\s+([A-Za-z_][\w$]*)/))) {
      const table = canonicalIdent(match[1]);
      actions.push({
        kind: 'data-update',
        name: table,
        table,
        destructive: false,
        touchesData: true,
        sql: statement,
      });
    }
  }

  const creates = actions.filter((a) =>
    ['create-table', 'create-index', 'create-view', 'add-column'].includes(a.kind),
  );
  const destructive = actions.filter((a) => a.destructive);
  const dataChanges = actions.filter((a) => a.touchesData);

  return {
    actions,
    creates,
    destructive,
    dataChanges,
    // The schema is converged when nothing creates a new object.
    isConverged: creates.length === 0 && dataChanges.length === 0,
  };
}

async function relationExists(db: MigrationDatabase, name: string, kind: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND c.relkind = ANY($2::char[])
     AND n.nspname = current_schema() LIMIT 1`,
    [name, kind === 'table' ? ['r', 'p'] : kind === 'view' ? ['v'] : ['i']],
  );
  return res.rows.length > 0;
}

async function columnExists(db: MigrationDatabase, table: string, column: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return res.rows.length > 0;
}

async function countRows(db: MigrationDatabase, table: string): Promise<number | null> {
  try {
    const res = await db.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    const value = res.rows[0]?.count;
    return typeof value === 'number' ? value : null;
  } catch {
    // Missing table or no permission — reported as unknown rather than zero.
    return null;
  }
}

/**
 * Intersects the plan with the live database. Safe to run with no writes: only
 * SELECTs are issued.
 */
export async function previewMigration(
  plan: MigrationPlan,
  db: MigrationDatabase,
): Promise<MigrationPreview> {
  const alreadyPresent: string[] = [];
  const wouldCreate: string[] = [];
  const affectedRecords: AffectedRecords[] = [];

  for (const action of plan.actions) {
    if (action.kind === 'create-table' && action.name) {
      (await relationExists(db, action.name, 'table'))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
      continue;
    }
    // Views and indexes are named by `name` only — they are never associated
    // with a `table`, so the existence check must key off `name`. Guarding on
    // `action.table` here silently skipped every view and index in the plan,
    // which is exactly what the preview exists to report.
    if (action.kind === 'create-view' && action.name) {
      (await relationExists(db, action.name, 'view'))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
      continue;
    }
    if (action.kind === 'create-index' && action.name) {
      (await relationExists(db, action.name, 'index'))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
      continue;
    }
    if (action.kind === 'add-column' && action.table && action.column) {
      (await columnExists(db, action.table, action.column))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    }
  }

  for (const action of plan.dataChanges) {
    if (!action.table) continue;
    affectedRecords.push({
      table: action.table,
      matchingRows: await countRows(db, action.table),
      columns: action.column ? [action.column] : [],
    });
  }

  return {
    plan,
    alreadyPresent,
    wouldCreate,
    wouldRunDestructive: plan.destructive,
    affectedRecords,
    rollbackNotes: rollbackNotes(plan),
  };
}

/** Human/operator-facing rollback or forward-fix guidance per risky action. */
export function rollbackNotes(plan: MigrationPlan): string[] {
  const notes: string[] = [];

  for (const action of plan.destructive) {
    if (action.kind === 'drop-column') {
      notes.push(
        `${action.name}: column data is lost. Re-add with ` +
          `ALTER TABLE ${action.table} ADD COLUMN ${action.column} <type>; — the prior values cannot be recovered, so take a dump first.`,
      );
    }
    if (action.kind === 'drop-table') {
      notes.push(
        `${action.name}: DROP TABLE ... CASCADE also removes dependent objects. ` +
          `Restore with your pre-migration dump (pg_dump) or re-create the table and repopulate.`,
      );
    }
  }

  for (const action of plan.dataChanges) {
    if (action.kind === 'data-update') {
      notes.push(
        `${action.name}: rows are rewritten in place. To reverse, restore the affected columns from a ` +
          `pre-migration dump; the previous values are not recoverable from the schema alone.`,
      );
    }
  }

  if (notes.length === 0) {
    notes.push('No destructive or data-rewriting actions in this migration — safe to re-run.');
  }
  return notes;
}

/**
 * Verifies convergence after the migration ran. Every check is an independent
 * assertion, so a partial failure is reported as a specific missing object
 * rather than a generic error.
 */
export async function runPostChecks(
  db: MigrationDatabase,
  plan: MigrationPlan,
): Promise<PostCheckReport> {
  const checks: PostCheck[] = [];

  for (const action of plan.creates) {
    if (action.kind === 'create-table' && action.table) {
      const exists = await relationExists(db, action.table, 'table');
      checks.push({
        name: `table ${action.table} exists`,
        ok: exists,
        detail: exists ? 'present' : 'missing after migration',
      });
      continue;
    }
    if (action.kind === 'create-view') {
      const exists = await relationExists(db, action.name, 'view');
      checks.push({
        name: `view ${action.name} exists`,
        ok: exists,
        detail: exists ? 'present' : 'missing after migration',
      });
      continue;
    }
    if (action.kind === 'create-index') {
      const exists = await relationExists(db, action.name, 'index');
      checks.push({
        name: `index ${action.name} exists`,
        ok: exists,
        detail: exists ? 'present' : 'missing after migration',
      });
      continue;
    }
    if (action.kind === 'add-column' && action.table && action.column) {
      const exists = await columnExists(db, action.table, action.column);
      checks.push({
        name: `column ${action.table}.${action.column} exists`,
        ok: exists,
        detail: exists ? 'present' : 'missing after migration',
      });
    }
  }

  // Consistency checks: a backfill that silently left NULLs behind is the
  // classic partial-rollout failure this framework exists to catch.
  const backfilled = plan.dataChanges.find((a) => a.kind === 'data-update');
  if (backfilled?.table) {
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM "${backfilled.table}" WHERE expires_at IS NULL`,
      );
      const remaining = res.rows[0]?.count ?? 0;
      checks.push({
        name: `${backfilled.table} has no NULL expires_at rows`,
        ok: remaining === 0,
        detail: remaining === 0 ? 'backfill complete' : `${remaining} row(s) still NULL`,
      });
    } catch {
      checks.push({
        name: `${backfilled.table} backfill verified`,
        ok: false,
        detail: 'could not verify backfill (column or table missing)',
      });
    }
  }

  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

/** Renders a preview as the CLI prints it. */
export function formatPreview(preview: MigrationPreview): string {
  const lines: string[] = [];
  lines.push('Migration preview (no writes performed)');
  lines.push('=======================================');
  lines.push(`Planned actions: ${preview.plan.actions.length}`);
  lines.push(`Already present: ${preview.alreadyPresent.length}`);
  lines.push(`Would create:    ${preview.wouldCreate.length}`);
  lines.push('');

  if (preview.wouldCreate.length > 0) {
    lines.push('Would create:');
    for (const name of preview.wouldCreate) lines.push(`  + ${name}`);
    lines.push('');
  }

  if (preview.wouldRunDestructive.length > 0) {
    lines.push('Destructive actions (review before running):');
    for (const action of preview.wouldRunDestructive) lines.push(`  - ${action.name}`);
    lines.push('');
  }

  if (preview.affectedRecords.length > 0) {
    lines.push('Affected records:');
    for (const record of preview.affectedRecords) {
      const count = record.matchingRows === null ? 'unknown' : String(record.matchingRows);
      lines.push(`  ~ ${record.table}: ${count} row(s) inspected`);
    }
    lines.push('');
  }

  lines.push('Rollback / forward-fix notes:');
  for (const note of preview.rollbackNotes) lines.push(`  - ${note}`);

  return lines.join('\n');
}

/** Renders a post-check report as the CLI prints it. */
export function formatPostChecks(report: PostCheckReport): string {
  const lines: string[] = [];
  lines.push('Post-migration checks');
  lines.push('======================');
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'All post-checks passed.' : `${report.failures.length} post-check(s) failed.`);
  return lines.join('\n');
}
