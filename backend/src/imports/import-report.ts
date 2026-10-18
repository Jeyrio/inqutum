/**
 * Dry-run reporting for the import pipeline (#53).
 *
 * The report is the deliverable of a dry run, so it is written to be read by
 * someone deciding whether to type `--apply`. It answers, in order: what would
 * happen, what is wrong, what has to be fixed by hand, and how to undo it.
 */

import type { ImportPlan, ImportAction } from './import-pipeline';
import type { ApplyResult } from './import-executor';

const RULE = '='.repeat(76);
const THIN = '-'.repeat(76);

/** Remediation shown next to a class of error, keyed by field. */
const REMEDIATION: Record<string, string> = {
  externalId: 'supply a unique externalId, or remove the row if it is a duplicate',
  sellerPublicKey:
    'must be a 56-character Stellar account id (G...) — the account that issues the invoice',
  amount: 'must be a plain decimal number, greater than zero, e.g. 1250.50',
  assetCode: 'use XLM, or any 1-12 character alphanumeric asset code',
  assetIssuer:
    'required for every asset except XLM, and forbidden on XLM; must be a Stellar account id',
  customerEmail: 'must be a valid email address, or left empty',
  sellerEmail: 'must be a valid email address, or left empty',
  expiresInDays: 'must be a whole number of days within the allowed range',
  createdAt: 'must be an ISO-8601 timestamp, e.g. 2026-01-15T09:30:00Z',
  expiresAt: 'must be an ISO-8601 timestamp, and later than createdAt',
  metadata: 'must be a JSON object, e.g. {"order":"A-17"}',
  memo: 'must match INV-<alphanumeric>-<alphanumeric>, or be left empty to generate one',
};

function remediationFor(field: string | undefined, message: string): string {
  // Whole-row diagnoses first: a duplicate or a settled invoice is a more
  // specific answer than anything the per-field table can offer.
  if (message.includes('duplicate')) return 'remove one of the two rows, or give the second a different id';
  if (message.includes('already PAID')) return 'this invoice has settled; exclude it from the file';
  if (field && REMEDIATION[field]) return REMEDIATION[field]!;
  if (message.includes('differs from the stored invoice')) {
    return 'the stored invoice is the record of truth; correct the file to match it, or import a correction through the API';
  }
  return 'correct the row in the source file and re-run the dry run';
}

export function formatImportReport(plan: ImportPlan): string {
  const out: string[] = [];
  out.push(RULE);
  out.push('Inqutum import — DRY RUN (no data was written)');
  out.push(RULE);
  out.push('');
  out.push(
    `  ${plan.total} row(s): ${plan.counts.create} to create, ${plan.counts.update} to update, ` +
      `${plan.counts.skip} already current, ${plan.counts.error} failed validation`
  );
  out.push('');

  if (plan.counts.create > 0) {
    out.push(`  CREATE (${plan.counts.create})`);
    for (const row of plan.rows.filter((r) => r.action === 'create')) {
      out.push(THIN);
      out.push(
        `    line ${row.line}  ${row.invoice!.sellerPublicKey.slice(0, 8)}…  ` +
          `${row.invoice!.amount} ${row.invoice!.assetCode}` +
          (row.externalId ? `  externalId=${row.externalId}` : '')
      );
      if (row.invoice!.description) out.push(`      ${row.invoice!.description}`);
      for (const warning of row.warnings) out.push(`      ! ${warning}`);
    }
    out.push('');
  }

  if (plan.counts.update > 0) {
    out.push(`  UPDATE (${plan.counts.update})`);
    for (const row of plan.rows.filter((r) => r.action === 'update')) {
      out.push(THIN);
      out.push(`    line ${row.line}  invoice ${row.existingId}  externalId=${row.externalId ?? '—'}`);
      for (const [field, change] of Object.entries(row.changes ?? {})) {
        out.push(`      ${field}: ${JSON.stringify(change?.from)} -> ${JSON.stringify(change?.to)}`);
      }
    }
    out.push('');
  }

  if (plan.counts.skip > 0) {
    out.push(`  SKIP (${plan.counts.skip}) — already present and unchanged; a re-run is a no-op`);
    for (const row of plan.rows.filter((r) => r.action === 'skip')) {
      out.push(`    line ${row.line}  invoice ${row.existingId}  externalId=${row.externalId ?? '—'}`);
    }
    out.push('');
  }

  if (plan.counts.error > 0) {
    out.push(`  ERROR (${plan.counts.error}) — these rows will not be imported`);
    for (const row of plan.rows.filter((r) => r.action === 'error')) {
      out.push(THIN);
      out.push(`    line ${row.line}${row.externalId ? `  externalId=${row.externalId}` : ''}`);
      for (const error of row.errors) {
        out.push(`      ${error.field ? `${error.field}: ` : ''}${error.message}`);
        out.push(`        fix: ${remediationFor(error.field, error.message)}`);
      }
    }
    out.push('');
  }

  for (const message of plan.formatErrors) {
    out.push(`  ${message}`);
  }

  const nonIdempotent = plan.rows.filter((r) => r.action === 'create' && r.warnings.length > 0).length;
  if (nonIdempotent > 0) {
    out.push('');
    out.push(
      `  ${nonIdempotent} created row(s) have no externalId. A re-run of this file will create duplicates;`
    );
    out.push('  add externalId to those rows if the file may be imported more than once.');
  }

  out.push('');
  out.push(RULE);
  if (plan.counts.error > 0) {
    out.push('Dry run complete. Nothing can be applied until every error is resolved.');
  } else if (plan.counts.create === 0 && plan.counts.update === 0) {
    out.push('Dry run complete. Nothing to do — the database already matches this file.');
  } else {
    out.push('Dry run complete. Re-run with --apply to write these changes.');
  }
  out.push(RULE);

  return out.join('\n');
}

export function formatApplyReport(result: ApplyResult, snapshotPath?: string): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(`Inqutum import — APPLIED (${result.source})`);
  out.push(RULE);
  out.push('');
  out.push(
    `  ${result.counts.create} created, ${result.counts.update} updated, ${result.counts.skip} unchanged`
  );
  out.push('');

  for (const row of result.created) {
    out.push(`  + line ${row.line}: ${row.id}  memo=${row.memo}${row.externalId ? `  externalId=${row.externalId}` : ''}`);
  }
  for (const row of result.updated) {
    out.push(`  ~ line ${row.line}: ${row.id}  changed ${row.changed.join(', ')}`);
  }

  out.push('');
  out.push(THIN);
  out.push('  Rollback');
  if (snapshotPath) {
    out.push(`    Snapshot written to ${snapshotPath}`);
    out.push(`    Undo everything with:  npm run db:import -- --rollback ${snapshotPath}`);
  } else {
    out.push('    No snapshot was requested, so this import can only be undone row by row.');
    out.push('    Re-run with --snapshot <path> to capture an undo file.');
  }
  out.push(RULE);

  return out.join('\n');
}

export function summarisePlan(plan: ImportPlan): Record<ImportAction, number> {
  return { ...plan.counts };
}
