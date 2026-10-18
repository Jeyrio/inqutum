#!/usr/bin/env tsx
/**
 * Synthetic Journey Monitor runner script (Issue #264).
 *
 * Exercises the end-to-end happy path:
 * Invoice creation -> Details inspection -> Payment verification -> Settlement transition -> Proof dispatch.
 *
 * Usage:
 *   npx tsx scripts/synthetic-journey-monitor.ts
 *   npx tsx scripts/synthetic-journey-monitor.ts --json
 *   npx tsx scripts/synthetic-journey-monitor.ts --check
 */

import {
  SyntheticJourneyMonitor,
  formatSyntheticJourneyReport,
} from '../backend/src/ops/synthetic-journey-monitor';

async function main() {
  const isJson = process.argv.includes('--json');
  const isCheck = process.argv.includes('--check');

  const monitor = new SyntheticJourneyMonitor();
  const report = await monitor.runJourney();

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSyntheticJourneyReport(report));
  }

  if (isCheck && !report.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Synthetic journey monitor fatal error:', err);
  process.exit(1);
});
