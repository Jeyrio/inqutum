#!/usr/bin/env tsx
/**
 * CLI tool for snapshot restore verification (Issue #263).
 *
 * Usage:
 *   npx tsx src/db/validate-snapshot-restore.ts [--file <snapshot.json>]
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  verifySnapshotRestore,
  formatSnapshotVerificationReport,
  type SnapshotPackage,
} from './snapshot-restore-verification';
import { MemoryInvoiceStorage } from '../storage/memory-invoice-storage';

async function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  let snapshotPackage: SnapshotPackage;

  if (fileIndex !== -1 && args[fileIndex + 1]) {
    const filePath = path.resolve(args[fileIndex + 1]);
    if (!fs.existsSync(filePath)) {
      console.error(`Snapshot file not found: ${filePath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    snapshotPackage = JSON.parse(raw);
  } else {
    // In default dry-run mode, verify active storage
    const storage = new MemoryInvoiceStorage();
    const invoices = await storage.getAllInvoices();
    snapshotPackage = {
      invoices,
      metadata: {
        exportedAt: new Date().toISOString(),
        source: 'active_storage',
      },
    };
  }

  const report = verifySnapshotRestore(snapshotPackage);
  console.log(formatSnapshotVerificationReport(report));

  if (!report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Snapshot restore verification fatal error:', err);
  process.exit(1);
});
