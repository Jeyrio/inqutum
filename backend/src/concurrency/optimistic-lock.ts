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
