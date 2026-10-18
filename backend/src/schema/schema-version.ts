/**
 * Schema versioning for Quittance records.
 *
 * Every record emitted by the API carries a `_schemaVersion` field so clients
 * and migration tooling can distinguish shapes across releases. Records
 * persisted before versioning was introduced are treated as version "0" and
 * upgraded on read through the compatibility layer.
 */

export const CURRENT_SCHEMA_VERSION = '1.0';

export type SchemaVersion = string;

export type VersionedRecord<T> = T & { _schemaVersion: SchemaVersion };

export class InvalidSchemaRecordError extends TypeError {
  readonly code = 'INVALID_SCHEMA_RECORD';

  constructor() {
    super('Schema record must be a non-null, non-array object');
    this.name = 'InvalidSchemaRecordError';
  }
}

function assertSchemaRecord(record: unknown): asserts record is Record<string, unknown> {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new InvalidSchemaRecordError();
  }
}

/**
 * Stamp an arbitrary record with the current schema version.
 * If the record already carries a `_schemaVersion` it is overwritten to the
 * current version (caller is responsible for any migration before calling).
 */
export function versionStamp<T extends Record<string, unknown>>(record: T): VersionedRecord<T> {
  assertSchemaRecord(record);
  return { ...record, _schemaVersion: CURRENT_SCHEMA_VERSION };
}

/**
 * Returns true when the record was persisted before schema versioning existed.
 */
export function isLegacyRecord(record: Record<string, unknown>): boolean {
  assertSchemaRecord(record);
  if (!Object.prototype.hasOwnProperty.call(record, '_schemaVersion')) return true;
  return record._schemaVersion === undefined || record._schemaVersion === null;
}
