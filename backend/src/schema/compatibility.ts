/**
 * Compatibility transforms for versioned invoice records.
 *
 * Read path: normalise any record (legacy or current) to the latest shape.
 * Write path: ensure every persisted record carries the schema version.
 *
 * When a new schema version is introduced:
 *   1. Bump CURRENT_SCHEMA_VERSION in schema-version.ts.
 *   2. Add a transform in UPGRADE_TRANSFORMS from the old version to the new one.
 *   3. Move the old version into DEPRECATION_POLICY.deprecated (and eventually unsupported).
 */

import type { StoredInvoice } from '../storage/invoice-storage';
import {
  CURRENT_SCHEMA_VERSION,
  isLegacyRecord,
  versionStamp,
  type SchemaVersion,
  type VersionedRecord,
} from './schema-version';

/**
 * Documents which versions are still accepted, which are deprecated (read-only
 * with warnings), and which are outright rejected.
 */
export const DEPRECATION_POLICY: Record<
  'supported' | 'deprecated' | 'unsupported',
  { versions: SchemaVersion[]; note: string }
> = {
  supported: {
    versions: [CURRENT_SCHEMA_VERSION],
    note: 'Fully supported. Records read and written as-is.',
  },
  deprecated: {
    versions: ['0'],
    note: 'Legacy records created before versioning. Upgraded on read to the current schema.',
  },
  unsupported: {
    versions: [],
    note: 'Records from these versions cannot be processed. Contact maintainers for migration help.',
  },
};

/** Per-version upgrade functions. Each one transforms a record from `fromVersion` to the next. */
type UpgradeTransform = (record: Record<string, unknown>) => Record<string, unknown>;

const UPGRADE_TRANSFORMS: Record<SchemaVersion, { to: SchemaVersion; transform: UpgradeTransform }> = {
  '0': {
    to: '1.0',
    transform: (record) => ({
      ...record,
      // Fields that may be absent on truly old rows get safe defaults.
      assetCode: record.assetCode ?? 'XLM',
      status: record.status ?? 'PENDING',
      version: record.version ?? 1,
    }),
  },
};

function effectiveVersion(record: Record<string, unknown>): SchemaVersion {
  if (isLegacyRecord(record)) return '0';
  return String(record._schemaVersion);
}

function isSupportedOrDeprecated(version: SchemaVersion): boolean {
  return (
    DEPRECATION_POLICY.supported.versions.includes(version) ||
    DEPRECATION_POLICY.deprecated.versions.includes(version)
  );
}

/**
 * Normalise a record (from storage or an older client) to the current schema.
 *
 * - Legacy / unversioned records are upgraded through the transform chain.
 * - Records at the current version pass through.
 * - Unsupported versions throw a structured error.
 */
export function transformForRead(
  record: Record<string, unknown>,
  fromVersion?: SchemaVersion
): VersionedRecord<StoredInvoice> {
  let version = fromVersion ?? effectiveVersion(record);

  if (!isSupportedOrDeprecated(version)) {
    const err: any = new Error(
      `Schema version "${version}" is not supported. Supported: ${DEPRECATION_POLICY.supported.versions.join(', ')}. ` +
        `Deprecated (read-only): ${DEPRECATION_POLICY.deprecated.versions.join(', ') || 'none'}.`
    );
    err.code = 'UNSUPPORTED_SCHEMA_VERSION';
    throw err;
  }

  let current = { ...record };

  // Walk the upgrade chain until we reach the current version.
  while (version !== CURRENT_SCHEMA_VERSION) {
    const step = UPGRADE_TRANSFORMS[version];
    if (!step) {
      const err: any = new Error(`No upgrade path from schema version "${version}".`);
      err.code = 'UNSUPPORTED_SCHEMA_VERSION';
      throw err;
    }
    current = step.transform(current);
    version = step.to;
  }

  return versionStamp(current) as unknown as VersionedRecord<StoredInvoice>;
}

/**
 * Ensure a write payload carries the current schema version.
 */
export function transformForWrite<T extends Record<string, unknown>>(input: T): T & { _schemaVersion: SchemaVersion } {
  return { ...input, _schemaVersion: CURRENT_SCHEMA_VERSION };
}
