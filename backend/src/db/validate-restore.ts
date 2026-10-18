/**
 * Restore validation CLI (#62).
 *
 *   npm run db:validate            validate the configured database, read-only
 *   npm run db:validate -- --json  machine-readable report
 *
 * Exits 0 when every invariant holds and 1 on any violation, so it can gate a
 * cutover in a deploy script. It never writes: see src/db/restore-validation.ts
 * for the invariants and the read-only guarantee.
 */
import { pool } from '../config/database';
import { runRestoreValidation, formatValidationReport, type ValidationDatabase } from './restore-validation';

const asJson = process.argv.includes('--json');
const sampleLimitArg = process.argv.find((a) => a.startsWith('--sample-limit='));
const sampleLimit = sampleLimitArg ? Number(sampleLimitArg.split('=')[1]) : undefined;

async function main() {
  const db = pool as unknown as ValidationDatabase;
  const report = await runRestoreValidation(db, { sampleLimit });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatValidationReport(report));
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('Restore validation could not run:', error instanceof Error ? error.message : error);
  process.exit(2);
});
