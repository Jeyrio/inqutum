# Schema and side-effect operations

This runbook covers the compatibility and recovery guarantees for issues #237,
#238, #276, and #281.

## Storage schema upgrades

`backend/src/db/migration-compatibility.ts` is a write-free gate for the next
storage version. Upgrades must move exactly one version at a time. CI and a
production dry-run should call `checkMigrationCompatibility` before applying
the SQL plan. Destructive plans require an explicit approval and a backup.

If the gate fails, do not force the migration. Restore or correct the plan,
then retry the check. If a migration partially applies, use the existing
post-check report to identify missing objects and apply a forward fix. For
destructive changes, restore the pre-migration dump before retrying.

## Stored records and API responses

Records are read through `transformForRead` and written through
`transformForWrite`. Legacy version `0` is upgraded with safe defaults;
unknown future versions fail with `UNSUPPORTED_SCHEMA_VERSION` rather than
being emitted as an incorrect public response. Add a transform and a test
before changing `CURRENT_SCHEMA_VERSION`.

## Idempotent side effects

Use `SideEffectDispatcher.dispatch` with a stable business key and the exact
request payload. The checkpoint is claimed before calling the provider. A
successful replay returns the stored result without calling the provider a
second time. Reusing a key for a different payload is rejected. An uncertain
crash is held as `in_doubt` until an operator can reconcile it; it is never
blindly resent.

## Dead-letter recovery

Jobs that exhaust their retry policy are visible through the existing
maintainer-only `/api/jobs?status=dead` endpoint. `DeadLetterOperator` is the
same authorization boundary for scripts and tests: only an `operator` or
`admin` principal can inspect or requeue a job. Requeue only after the cause is
understood; it resets the attempt budget and preserves the original error
history for auditability.

```bash
cd backend
npm test -- --test-name-pattern='Issues #237, #238, #276 and #281'
npm run typecheck
```
