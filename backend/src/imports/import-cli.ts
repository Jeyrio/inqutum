/**
 * Import CLI (#53).
 *
 *   npm run db:import -- --file invoices.csv              dry run, the default
 *   npm run db:import -- --file invoices.csv --apply      write
 *   npm run db:import -- --file invoices.csv --apply --on-error skip
 *   npm run db:import -- --rollback invoices.snapshot.json
 *
 * Exit codes: 0 success or a clean dry run, 1 the file has errors or is not
 * an allowed file type, 2 the command itself failed (unreadable file,
 * unreachable database), 130 cancelled by SIGINT/SIGTERM before COMMIT.
 */

import * as fs from 'fs';
import * as path from 'path';

import { parseImportFile, IMPORT_COLUMNS, REJECTED_COLUMNS } from './import-format';
import { planImport, type ExistingInvoice } from './import-pipeline';
import { formatImportReport, formatApplyReport } from './import-report';
import {
  applyImport,
  rollbackImport,
  loadExisting,
  ImportAbortedError,
  ImportCancelledError,
  type ImportDatabase,
  type ImportSnapshot,
} from './import-executor';
import { pool } from '../config/database';
import {
  AllowListViolation,
  DEFAULT_IMPORT_MAX_BYTES,
  checkImportFileContent,
  checkImportFileStat,
} from '../security/allow-list';

function importMaxBytes(): number {
  const configured = Number(process.env.IMPORT_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_IMPORT_MAX_BYTES;
}

function parseArgs(argv: string[]): {
  file?: string;
  apply: boolean;
  onError: 'abort' | 'skip';
  snapshot?: string;
  rollback?: string;
  json: boolean;
} {
  const args: {
    file?: string;
    apply: boolean;
    onError: 'abort' | 'skip';
    snapshot?: string;
    rollback?: string;
    json: boolean;
  } = { apply: false, onError: 'abort', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--snapshot') args.snapshot = argv[++i];
    else if (arg === '--rollback') args.rollback = argv[++i];
    else if (arg === '--on-error') {
      const value = argv[++i];
      if (value !== 'skip' && value !== 'abort') {
        throw new Error(`--on-error must be "abort" or "skip", got "${value}"`);
      }
      args.onError = value;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }
  return args;
}

function printHelp(): void {
  const columns = IMPORT_COLUMNS.map(
    (c) => `  ${c.column.padEnd(16)} ${c.required ? 'required' : 'optional'}  ${c.description}`
  ).join('\n');
  const rejected = Object.entries(REJECTED_COLUMNS)
    .map(([name, reason]) => `  ${name.padEnd(16)} ${reason}`)
    .join('\n');

  console.log(`Inqutum invoice import

Usage:
  npm run db:import -- --file <path> [options]
  npm run db:import -- --rollback <snapshot.json>

Options:
  --file <path>     CSV or NDJSON file to import.
  --apply           Write the plan. Without this flag the command is a dry run
                    and performs no persistent writes.
  --on-error <mode> abort (default) refuses the whole file if any row is
                    invalid; skip imports the valid rows and reports the rest.
  --snapshot <path> Where to write the undo file. Defaults to <file>.snapshot.json
                    when --apply is used.
  --rollback <path> Undo a previously applied import.
  --json            Machine-readable output, for CI.

Columns:
${columns}

Not importable:
${rejected}`);
}

function toExistingInvoice(row: Record<string, any>): ExistingInvoice {
  return {
    id: String(row.id),
    externalId: row.external_id ?? null,
    memo: String(row.memo),
    status: row.status,
    amount: Number(row.amount),
    assetCode: String(row.asset_code),
    assetIssuer: row.asset_issuer ?? null,
    sellerPublicKey: String(row.seller_public_key),
    sellerName: row.seller_name ?? null,
    sellerEmail: row.seller_email ?? null,
    customerName: row.customer_name ?? null,
    customerEmail: row.customer_email ?? null,
    description: row.description ?? null,
    expiresAt: new Date(row.expires_at),
    metadata: row.metadata ?? null,
  };
}

/**
 * Cancellation (#288): the first SIGINT/SIGTERM aborts the run, which rolls the
 * open transaction back at the next row boundary. A second signal exits at once;
 * PostgreSQL aborts the transaction once its backend sees the connection is gone.
 */
function cancelOnSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals) => {
    if (controller.signal.aborted) process.exit(130);
    console.error(`\n${name} received: cancelling at the next row; press Ctrl-C again to exit immediately.`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

export async function runImportCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.rollback) {
    const snapshot = JSON.parse(fs.readFileSync(args.rollback, 'utf-8')) as ImportSnapshot;
    const cancel = cancelOnSignal();
    const outcome = await rollbackImport({ connect: () => pool.connect() }, snapshot, cancel.signal).finally(cancel.dispose);
    console.log(
      `Rolled back ${snapshot.source ?? 'import'}: ${outcome.restored} row(s) restored, ${outcome.deleted} deleted.`
    );
    return 0;
  }

  if (!args.file) {
    throw new Error('--file <path> is required (or --rollback <snapshot.json>)');
  }

  const absolute = path.resolve(args.file);
  if (!fs.existsSync(absolute)) throw new Error(`file not found: ${absolute}`);
  // Allow-list (#291): type and size are checked before a byte is read.
  const encoding = checkImportFileStat(absolute, fs.statSync(absolute), importMaxBytes());
  const { text } = checkImportFileContent(encoding, fs.readFileSync(absolute));

  const parsed = parseImportFile(absolute, text);
  if (parsed.errors.length > 0) {
    console.error('The file could not be read as a valid import:');
    for (const error of parsed.errors) console.error(`  - ${error}`);
    console.error('\nSee docs/IMPORT_PIPELINE.md for the accepted format.');
    return 1;
  }

  const client = await pool.connect();
  let existing: ExistingInvoice[];
  try {
    const probe = planImport(parsed.rows, { onError: args.onError });
    const loaded = await loadExisting(client, probe);
    existing = [...loaded.values()].map(toExistingInvoice);
  } finally {
    client.release();
  }

  const plan = planImport(parsed.rows, { existing, onError: args.onError });

  if (!args.apply) {
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(formatImportReport(plan));
    return plan.counts.error > 0 ? 1 : 0;
  }

  if (plan.counts.error > 0) {
    console.error(formatImportReport(plan));
    console.error('\nRefusing to apply. Fix the errors, or re-run with --on-error skip.');
    return 1;
  }

  const snapshotPath = args.snapshot ?? `${absolute}.snapshot.json`;
  const cancel = cancelOnSignal();
  const result = await applyImport({ connect: () => pool.connect() }, plan, {
    source: absolute,
    signal: cancel.signal,
  }).finally(cancel.dispose);
  // Written even if a signal arrived after COMMIT: the snapshot is the only undo.
  fs.writeFileSync(snapshotPath, JSON.stringify(result.snapshot, null, 2));
  fs.chmodSync(snapshotPath, 0o600);

  console.log(formatApplyReport(result, path.relative(process.cwd(), snapshotPath)));
  return 0;
}

if (require.main === module) {
  runImportCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof ImportCancelledError) {
        console.error(`\n${error.message}`);
        process.exit(130);
      }
      if (error instanceof AllowListViolation) {
        console.error(`\nFile rejected (${error.code}): ${error.message}`);
        process.exit(1);
      }
      if (error instanceof ImportAbortedError) console.error(`\n${error.message}`);
      else console.error(`\nImport failed: ${(error as Error).message}`);
      process.exit(2);
    });
}
