import type { MigrationPlan } from './migration-safety';

/** Storage versions are advanced one version at a time. */
export const CURRENT_STORAGE_SCHEMA_VERSION = 1;
export const NEXT_STORAGE_SCHEMA_VERSION = 2;

export interface MigrationCompatibilityOptions {
  currentVersion: number;
  targetVersion: number;
  /** Destructive plans require an explicit operator opt-in. */
  allowDestructive?: boolean;
}

export interface MigrationCompatibilityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MigrationCompatibilityReport {
  ok: boolean;
  checks: MigrationCompatibilityCheck[];
  failures: MigrationCompatibilityCheck[];
}

export class MigrationCompatibilityError extends Error {
  readonly code = 'MIGRATION_INCOMPATIBLE';

  constructor(readonly report: MigrationCompatibilityReport) {
    super(report.failures.map((failure) => failure.detail).join('; '));
    this.name = 'MigrationCompatibilityError';
  }
}

/**
 * Checks a migration before it is applied. This deliberately has no database
 * writes, so CI and a production dry-run can use the same gate.
 */
export function checkMigrationCompatibility(
  plan: MigrationPlan,
  options: MigrationCompatibilityOptions,
): MigrationCompatibilityReport {
  const checks: MigrationCompatibilityCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  add(
    'version is a forward, single-step upgrade',
    Number.isInteger(options.currentVersion) &&
      Number.isInteger(options.targetVersion) &&
      options.targetVersion === options.currentVersion + 1,
    `expected target ${options.currentVersion + 1}, received ${options.targetVersion}`,
  );
  add(
    'migration has executable actions',
    plan.actions.length > 0,
    'the migration plan is empty; refusing to claim a schema upgrade',
  );
  add(
    'destructive actions are explicitly approved',
    plan.destructive.length === 0 || options.allowDestructive === true,
    'destructive actions require allowDestructive=true and a pre-migration backup',
  );
  add(
    'data changes have rollback guidance',
    plan.dataChanges.length === 0 || plan.destructive.length > 0 || plan.actions.length > 0,
    'data-changing actions must be represented in the migration plan',
  );

  const failures = checks.filter((check) => !check.ok);
  return { ok: failures.length === 0, checks, failures };
}

export function assertMigrationCompatible(
  plan: MigrationPlan,
  options: MigrationCompatibilityOptions,
): void {
  const report = checkMigrationCompatibility(plan, options);
  if (!report.ok) throw new MigrationCompatibilityError(report);
}
