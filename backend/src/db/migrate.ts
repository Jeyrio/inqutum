import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../config/database';
import {
  parseSchemaSql,
  previewMigration,
  runPostChecks,
  formatPreview,
  formatPostChecks,
  type MigrationDatabase,
} from './migration-safety';

// SQL lives at the repo root (db/), the runner lives with the backend code so
// `npm run db:migrate` (tsx src/db/migrate.ts) resolves both the script and its
// dependencies.
//
// schema.sql applied here defines the full parity column set: seller name and
// email, asset_code + asset_issuer pair, customer name + email, all payer
// fields (public_key / name / email / tx_hash / paid_at), expires_at, and
// JSONB metadata. Any column added to StoredInvoice in invoice-storage.ts
// requires a matching ALTER or a re-run of this migrate against production;
// the shared interface + TypeScript will surface the mismatch at compile
// time if the two drift.
//
// #75: the runner is now guarded by the migration safety framework —
//   npm run db:migrate -- --dry-run   preview impact, write nothing
//   npm run db:migrate                apply, then verify convergence
const SQL_DIR = path.join(__dirname, '../../../db');

const isDryRun = process.argv.includes('--dry-run');

async function migrate() {
  const schemaPath = path.join(SQL_DIR, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  const plan = parseSchemaSql(schema);
  const db = pool as unknown as MigrationDatabase;

  console.log('🚀 Starting database migration...\n');
  console.log(`Planned actions: ${plan.actions.length}`);

  // Preview first: report affected records before any write.
  const preview = await previewMigration(plan, db);
  console.log(`\n${formatPreview(preview)}\n`);

  if (isDryRun) {
    console.log('🧪 --dry-run: no changes written.\n');
    return { applied: false, postChecks: null };
  }

  if (plan.isConverged && preview.wouldCreate.length === 0) {
    console.log('✅ Schema already converged — nothing to apply.\n');
  } else {
    await pool.query(schema);
    console.log('✅ Schema applied.\n');
  }

  // Post-checks detect an incomplete or inconsistent result instead of
  // reporting success on a partial rollout.
  const report = await runPostChecks(db, plan);
  console.log(`\n${formatPostChecks(report)}\n`);

  if (!report.ok) {
    const error = new Error(
      `Migration applied but ${report.failures.length} post-check(s) failed: ` +
        report.failures.map((f) => f.name).join(', '),
    );
    (error as Error & { postChecks?: unknown }).postChecks = report;
    throw error;
  }

  return { applied: true, postChecks: report };
}

migrate()
  .then((result) => {
    console.log('✨ All done!');
    void result;
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration error:', error);
    process.exit(1);
  });
