# Rollback Verification After Failed Migrations or Deployments (#301)

## Overview & Goal
When a database migration fails midway, post-checks fail, or a production release experiences runtime errors, operators and automated continuous deployment systems trigger rollbacks. However, assuming that a rollback has cleanly converged without verification is dangerous. The Rollback Verification Engine validates that both the database schema and application deployment have completely, cleanly, and safely reverted to the expected baseline state.

---

## Verification Scope & Checks

### 1. Database Schema Rollback Verification
Given an expected pre-migration `SchemaBaseline`:
- **Missing Object Detection**: Verifies that all expected tables, views, and columns are restored.
- **Extraneous / Dirty Object Detection**: Scans for tables, columns, views, or indexes created by the failed migration that were not properly cleaned up by the rollback script.
- **Dangling Lock & State Check**: Verifies that no migration locks (`migrations_lock`) or dirty migration status markers remain active in the database.
- **Automated Remediation SQL**: Generates exact, copy-pasteable SQL commands (`DROP TABLE IF EXISTS ...`, `ALTER TABLE ... DROP COLUMN ...`) to remediate dirty objects.

### 2. Application Deployment Rollback Verification
- **Liveness & Readiness**: Probes `/api/health` and `/api/ready` to verify service health.
- **Version Assertion**: Checks that the observed running software version matches the declared rollback target version.
- **Transient Connection Retries**: Employs configurable retry loops with exponential backoff to handle container restarts and pool warmups.

---

## Operational Edge Cases & Recovery / Rollback Behavior

| Operational Scenario | Impact / System Behavior | Recovery & Rollback Path |
|---|---|---|
| **Aborted migration left dangling tables** | The failed migration created `table_v2`, but rollback DDL only reverted alterations on existing tables. | Verifier flags `extraneousTables: ['table_v2']` and emits `DROP TABLE IF EXISTS public.table_v2 CASCADE;`. |
| **Migration lock held by crashed runner** | Node process crashed during migration; lock flag remains `true`. | Verifier detects `dirtyMarkers: ['MIGRATION_LOCK_ACTIVE']` and outputs remediation SQL `UPDATE migrations_lock SET is_locked = false;`. |
| **Deployment rollback container rollover delay** | Verifier runs immediately while old pods are terminating and rollback pods are spinning up. | Built-in exponential backoff retries probe up to `maxRetries` (default: 2), avoiding false alarms. |
| **Partial deployment rollback (stale version running)** | Some nodes were rolled back but load balancer still routes to old deployment version. | Verifier fails with `versionMatch: false` and lists observed vs expected version. Operators restart remaining pods. |
| **Unauthorized execution** | Unprivileged operator or unauthorized script attempts to certify rollback. | Fails immediately with `UnauthorizedRollbackVerificationError` (HTTP 403). Requires `ADMIN` or `OWNER` credentials. |

---

## Complexity Analysis
- **Time Complexity**: $O(N)$ where $N$ is the number of schema objects ($O(1)$ per information schema row).
- **Space Complexity**: $O(N)$ for object sets and reporting structures.
