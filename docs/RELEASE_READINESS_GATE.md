# Release Readiness Gate & Rehearsal Verification

## Overview
In Inqutum, critical invoice settlement, payment proof verification, and financial accounting cannot tolerate broken migrations, secret leaks, missing deploy contracts, or unvalidated rollbacks.

The **Release Readiness Gate** (Issue #270) provides an automated preflight CI/CD checkpoint blocking deployment if any release readiness criteria are violated.

## The Four Gates

### 1. Migrations & Schema Convergence Gate
- **Idempotency**: All DDL definitions must support safe re-runs (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- **Destructive Operation Containment**: Prevents uncontained table or column drops without documented migration plans and transition notes.
- **Convergence**: Guarantees that applying the schema against existing databases converges to the declared target state without leaving orphaned constraints.

### 2. Security & Secret Leakage Gate
- **Secret Seed Scanning**: Automated scan of application source trees to ensure no Stellar secret keys (`S...`), private keys, or API tokens are hardcoded.
- **Template Injection & Content Safety**: Validates that dynamic invoice export documents (PDF/HTML) strictly sanitize user-controlled fields through HTML escaping.
- **PII Boundary Protection**: Confirms that notification pipelines, search indexes, and logs never ingest customer or payer PII.

### 3. Smoke Tests & Health Contract Gate
- **Liveness & Readiness**: Asserts `/health` and `/ready` HTTP contracts are pinned.
- **End-to-End Core Lifecycle**: Validates that `scripts/deploy-smoke.mjs` verifies creating and retrieving an invoice before marking a build ready.

### 4. Rollback & Disaster Recovery Rehearsal Gate
- **Read-Only Invariant Enforcement**: Evaluates state coherence against the four primary failure families: `missing`, `orphaned`, `duplicated`, and `inconsistent`.
- **Rehearsal Dry-Runs**: Executes dry-run rehearsals to verify that rolling back to a previous backup or schema point restores an uncorrupted state.

## Live Release Checks (Issue #313)

The four gates above are static by default, which is what CI runs. Before
promoting a release, point the gate at the deployed target and the migrated
database. Each live check runs only when its input is supplied, so CI output is
unchanged.

| Input | Gate | What it verifies |
|-------|------|------------------|
| `--approve-destructive=<table.column,...>` | Migrations | A maintainer approved each destructive action in `db/schema.sql` for **this** release. Approvals are case-insensitive and named as the plan names them (`invoices.legacy_note`, `users`). The reviewed legacy cleanup (`invoices.user_id`, `users`) stays pre-approved. An approval that matches no planned action **fails** the gate, so a standing approval cannot silently authorize a future drop. Rollback notes for every destructive or data-rewriting action are printed in the details. |
| `RELEASE_GATE_DATABASE_URL` (env only) | Migrations | `runPostChecks`: every table, view, index and column the schema declares exists on the target, and the `expires_at` backfill left no NULL rows. |
| `RELEASE_GATE_DATABASE_URL` (env only) | Rollback rehearsal | `runRestoreValidation` against the target, for example a restored snapshot. Covers the missing, orphaned, duplicated and inconsistent families plus missing tables. Without the variable, the rehearsal uses the coherent fixture, and the details say so. |
| `--smoke-url=<https://host/api>` | Smoke tests | Live `GET /health` (`status: "ok"`) and `GET /ready` (`ready: true`) on the deployed API, with bounded retry. When readiness fails, the API's `reasons` appear in the details. |

The database URL is read from the environment only, never from argv, so it
does not appear in shell history or process listings. The connection is
opened with `max: 1` and `options: -c default_transaction_read_only=on`, so the
session rejects writes. Every check also issues only `SELECT`s.

### Retry and authorization behaviour of the smoke probe

`scripts/http-probe.ts` (shared with contributor diagnostics):

- Network errors, timeouts (10 s per request), `429`, `502`, `503` and `504`
  are retried. So is a `2xx` response that is not JSON, such as an interstitial
  page. The smoke probe allows up to 10 attempts, with exponential backoff
  (1 s, 2 s, 4 s, 8 s, then 15 s), which adds up to 90 s of waiting. Render
  documents that a spun-down free service takes "about one minute" to start, so
  this covers a cold start. A `Retry-After` header (delay-seconds or HTTP-date)
  takes precedence, capped at 15 s. Worst case, if every attempt times out, the
  probe takes about 190 s per endpoint (10 × 10 s plus 90 s of backoff).
- `401` / `403` fail immediately with an authorization remediation. Health and
  readiness must be public. A protected preview deployment or auth gateway in
  front of the API is a misconfigured target, and retrying will not fix it.
- Only idempotent `GET`s are probed. Invoice create/read stays in
  `scripts/deploy-smoke.mjs`, which is never retried, because a retried `POST`
  would create duplicate invoices.
- Plain `http://` is accepted only for loopback hosts. Deployed targets must be HTTPS.

### Release procedure

```bash
# 1. Static gate (also runs in CI)
cd backend && npm run release:check

# 2. After deploying to staging and migrating its database
RELEASE_GATE_DATABASE_URL="$STAGING_DATABASE_URL" \
  npx tsx ../scripts/release-readiness-gate.ts --check \
  --smoke-url=https://staging-api.example.com/api \
  --approve-destructive=invoices.legacy_note        # only if this release drops something

# 3. Promote traffic only on exit code 0, then run the full create/read smoke
DEPLOY_API_URL=https://api.example.com/api node ../scripts/deploy-smoke.mjs
```

### Failure and rollback decisions

| Failure | Meaning | Action |
|---------|---------|--------|
| `Schema has not converged on the target database` | Migration partially applied | Re-run `npm run db:migrate` (idempotent), then re-run the gate. |
| `Destructive-action approval does not match any action` | Stale or mistyped approval | Remove the approval. Approve per release only. |
| `Target database could not be inspected` / rehearsal could not run | Connectivity or permissions | Fix `RELEASE_GATE_DATABASE_URL` or grants. The gate fails closed and never passes on an unknown state. |
| Rollback rehearsal violations | The restored snapshot is not coherent | Do not promote. Triage with `npm run db:validate` and restore from the previous dump (`docs/MIGRATIONS.md` §4). |
| `/ready did not become healthy after N attempt(s)` | The deploy is up but not ready | Do not shift traffic. Fix the listed readiness reasons, or roll back to the previous release. |
| `rejected the unauthenticated smoke probe` | Wrong or protected URL | Point `--smoke-url` at the public API origin. |

### Compatibility

The report shape (`totalGates: 4`, gate keys, `PASS`/`FAIL`) is unchanged.
Gate functions take a new optional second argument and keep their existing
signatures. `checkRollbackRehearsalGate()` with no arguments still runs the
fixture rehearsal.

## CLI & CI Usage

```bash
# Full readable checklist report:
pnpm run release:gate

# CI blocking mode (exits non-zero if ANY gate fails):
pnpm run release:check

# Machine-readable JSON for release pipelines:
npx tsx scripts/release-readiness-gate.ts --json
```

## Operational Edge Cases & Failure Modes

1. **Uncontained Destructive DDL**: If a migration script contains raw `DROP TABLE` or `DROP COLUMN` without approved transition status, release is blocked immediately with remediation instructions.
2. **Missing Invariant Coverage**: If a database restore leaves orphan transactions without matching invoices, the rollback rehearsal gate flags `totalViolations > 0` and stops deployment.
3. **Partial Deployments**: If deploy smoke fails against a staging container, the release gate prevents traffic cutover.

## Rollback & Recovery Procedures

1. **Gate Failure Triage**: Inspect the CLI summary and `details` array to identify the offending gate.
2. **Schema Rollback**: If a schema migration is rejected, consult `docs/MIGRATIONS.md` and use the forward-fix notes associated with the planned action.
3. **Data Coherence Recovery**: Run `pnpm run db:validate` to generate an audit report of row-level invariant violations and apply designated remediations.
