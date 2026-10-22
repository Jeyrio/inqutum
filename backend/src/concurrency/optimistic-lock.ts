/**
 * Optimistic concurrency control for invoice state transitions.
 *
 * Each invoice carries a `version` counter that increments on every write.
 * Clients pass the expected version; if another session has written in the
 * meantime the version will not match and a ConflictError is thrown.
 *
 * Old clients that do not send a version are allowed through (backward compat).
 */

export class ConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  readonly currentVersion: number;
  readonly attemptedVersion: number;

  constructor(currentVersion: number, attemptedVersion: number) {
    super(
      `Invoice was modified by another session (current version: ${currentVersion}, attempted: ${attemptedVersion}). Please refresh and try again.`
    );
    this.name = 'ConflictError';
    this.currentVersion = currentVersion;
    this.attemptedVersion = attemptedVersion;
  }
}

export class InvalidVersionError extends Error {
  readonly code = 'INVALID_VERSION' as const;

  constructor(readonly field: 'expected' | 'actual', readonly value: number) {
    super(`${field} version must be a non-negative safe integer.`);
    this.name = 'InvalidVersionError';
  }
}

function assertVersion(field: 'expected' | 'actual', value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidVersionError(field, value);
  }
}

/**
 * Compare the expected version with the actual version.
 *
 * - If `expected` is undefined (old client), the check is skipped.
 * - If the versions match, the check passes silently.
 * - If they differ, a ConflictError is thrown.
 */
export function checkVersion(expected: number | undefined, actual: number): void {
  assertVersion('actual', actual);
  if (expected === undefined) return;
  assertVersion('expected', expected);
  if (expected !== actual) {
    throw new ConflictError(actual, expected);
  }
}

/** Persistence the generic lock helper needs: read the version, and compare-and-set it. */
export interface OptimisticLockStore {
  readVersion(id: string): Promise<number | undefined>;
  /** Sets `next` only if the stored version is still `expected`; returns whether it did. */
  writeVersion(id: string, expected: number, next: number): Promise<boolean>;
}

export type OptimisticLockResult =
  | { ok: true; code: 'LOCK_ACQUIRED'; nextVersion: number }
  | { ok: false; code: 'STALE_VERSION'; currentVersion?: number; recoverable: false }
  | { ok: false; code: 'LOCK_STORE_UNAVAILABLE'; recoverable: true };

/**
 * Compare-and-set a record's version: succeeds only when the caller's observed
 * version is still current. A store failure is reported as recoverable, never
 * as a conflict, so callers can tell "retry later" from "re-read first".
 */
export async function acquireOptimisticLock(
  store: OptimisticLockStore,
  record: { id: string; version: number },
  expectedVersion: number
): Promise<OptimisticLockResult> {
  try {
    const current = await store.readVersion(record.id);
    if (current !== expectedVersion) {
      return { ok: false, code: 'STALE_VERSION', currentVersion: current, recoverable: false };
    }
    const nextVersion = expectedVersion + 1;
    if (!(await store.writeVersion(record.id, expectedVersion, nextVersion))) {
      return { ok: false, code: 'STALE_VERSION', recoverable: false };
    }
    return { ok: true, code: 'LOCK_ACQUIRED', nextVersion };
  } catch {
    return { ok: false, code: 'LOCK_STORE_UNAVAILABLE', recoverable: true };
  }
}
