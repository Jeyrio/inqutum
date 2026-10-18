# Incident triage and emergency rollback runbook

Operational playbook for diagnosing production issues, performing emergency
rollbacks, and reconciling data after an incident. This document is meant to be
used during an active incident -- commands are copy-pasteable and sections are
self-contained so you can jump straight to the relevant category.

> **Security rule:** Never paste secrets (`JOBS_ADMIN_TOKEN`, `DATABASE_URL`,
> private keys) into issue trackers, chat, or incident reports. Use correlation
> IDs and masked keys (first 4 + last 4 characters) for cross-referencing.

---

## Quick reference

| Action | Command |
|--------|---------|
| Health check | `curl -s $API/api/health \| jq .` |
| Readiness probe | `curl -s $API/api/ready` |
| Ops health report | `curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/ops/health \| jq '.data'` |
| Feature flag state | `curl -s $API/api/health \| jq .features` |
| Telemetry metrics | `curl -s $API/api/observability/metrics \| jq .` |
| Prometheus scrape | `curl -s $API/metrics` |
| List dead jobs | `curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" "$API/api/jobs?status=dead"` |
| Retry a dead job | `curl -s -X POST -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/jobs/:id/retry` |
| Audit events | `curl -s "$API/api/audit/events?action=PAYMENT_VERIFIED"` |
| Export audit trail | `curl -s "$API/api/audit/export" -o audit.json` |
| Deploy smoke test | `cd backend && npm run deploy:smoke` |
| Run migrations | `cd backend && npm run db:migrate` |
| Type check | `cd backend && npm run typecheck` |
| Run tests | `cd backend && npm test` |
| Run Postgres tests | `cd backend && npm run test:pg` |

Set `$API` to your deployment origin, e.g. `https://quittance-api.onrender.com`
or `http://localhost:3001`.

---

## Incident categories

### 1. Payment verification failures (Horizon/Stellar connectivity)

**Symptoms:**
- `POST /api/invoices/:id/verify` returns 5xx or times out
- Metrics show rising `NETWORK_MISMATCH`, `NO_PAYMENT_OPERATION`, or other
  rejection codes
- Audit trail has no recent `PAYMENT_VERIFIED` events

**Diagnosis:**

```bash
# Check overall health
curl -s $API/api/health | jq .

# Look for Horizon-related errors in ops report
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/ops/health \
  | jq '.data.categories.serverErrors'

# Check rejection code breakdown
curl -s $API/api/observability/metrics | jq '.verificationCodes'

# Check recent payment audit events
curl -s "$API/api/audit/events?action=PAYMENT_VERIFIED"
curl -s "$API/api/audit/events?action=PAYMENT_REJECTED"
```

**Fix actions:**
1. Verify Horizon is reachable: `curl -s https://horizon-testnet.stellar.org/`
   (or the production Horizon URL).
2. If Horizon is down, this is an upstream outage. Notify maintainers and wait.
   Invoices remain `PENDING`; payers can retry verification once Horizon
   recovers.
3. If `STELLAR_HORIZON_URL` or `STELLAR_NETWORK` is wrong, fix the environment
   variable and restart the service.
4. If the `paymentAmountTolerance` flag is suspected, check its state and see
   [Feature flag misconfiguration](#4-feature-flag-misconfiguration).

See also: [VERIFY.md](./VERIFY.md) for the full check order and rejection codes.

---

### 2. Database connectivity loss

**Symptoms:**
- `/api/health` returns unhealthy or the database section reports an error
- `/api/ready` returns non-200
- All invoice/job operations fail with 500
- Workers cannot claim or complete jobs

**Diagnosis:**

```bash
# Health and readiness
curl -s $API/api/health | jq .
curl -s -o /dev/null -w "%{http_code}" $API/api/ready

# Attempt a migration (safe to re-run)
cd backend && npm run db:migrate

# Test connection directly (local/CI)
psql "$DATABASE_URL" -c "SELECT 1"
```

**Fix actions:**
1. Check that `DATABASE_URL` is set and correct in the deployment environment.
2. Verify the Postgres instance is running and accepting connections (check
   Render/provider dashboard for database status).
3. If the database is up but connections are exhausted, restart the service to
   release the pool.
4. If schema is out of date, run `npm run db:migrate` (idempotent -- safe to
   re-run).
5. For the MVP in-memory server (`server-mvp.ts`), no database is involved.
   Restart recovers the service but all data is lost.

---

### 3. Job queue stalls (dead workers, expiry drift)

**Symptoms:**
- Ops health report shows `staleJobs` or `invoiceExpiryDrift` with non-zero
  counts
- `PENDING` invoices are not expiring on time
- Dead-letter queue is growing

**Diagnosis:**

```bash
# Full ops report
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/ops/health \
  | jq '.data | {status, attention, categories: {staleJobs, invoiceExpiryDrift, deadJobs}}'

# List dead jobs
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" "$API/api/jobs?status=dead" | jq .

# List running jobs (check for stuck leases)
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" "$API/api/jobs?status=running" | jq .

# Check expiry sweep jobs specifically
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" \
  "$API/api/jobs?type=invoices.expire-pending&status=dead" | jq .
```

**Fix actions:**
1. **No worker running:** Start the worker process (`npm run worker` or
   `npm run dev:pg` which embeds a worker). Expired leases are reclaimed
   automatically once a worker is up.
2. **Dead jobs:** Inspect individual jobs with `GET /api/jobs/:id`, fix the root
   cause, then retry: `POST /api/jobs/:id/retry`.
3. **Embedded worker disabled:** If `JOBS_EMBEDDED_WORKER=false`, ensure a
   standalone worker is running alongside the API.
4. **Expiry drift:** If the `invoices.expire-pending` sweep job is dead or
   stalled, retry it. The sweep is idempotent.

See also: [JOBS.md](./JOBS.md) for lifecycle, retry policy, and worker
configuration. [OPS_HEALTH.md](./OPS_HEALTH.md) for health category
definitions and thresholds.

---

### 4. Feature flag misconfiguration

**Symptoms:**
- Payment verifications behave differently than expected (e.g. tolerance
  accepting or rejecting unexpectedly)
- `/api/health` `features` section shows an unexpected flag state

**Diagnosis:**

```bash
# Check effective flag state
curl -s $API/api/health | jq .features
```

**Fix actions:**
1. Set the correct environment variable value. Accepted values: `true` / `1` /
   `on` and `false` / `0` / `off` (case-insensitive). Any other value
   (including typos) falls back to the safe default.
2. Restart the service for the change to take effect. Flags are read from the
   environment on every check, but changing the environment requires a process
   restart.
3. Verify the change: `curl -s $API/api/health | jq .features`.

Current flags and their safe defaults are documented in
[FEATURE_FLAGS.md](./FEATURE_FLAGS.md). Flag definitions live in
`backend/src/config/feature-flags.ts`.

---

### 5. Deployment failures

**Symptoms:**
- Deploy smoke test fails (`npm run deploy:smoke`)
- New deployment returns 500 or does not respond
- Health check fails after deploy

**Diagnosis:**

```bash
# Smoke test against deployed URL
cd backend && npm run deploy:smoke

# Health check
curl -s $API/api/health | jq .
curl -s -o /dev/null -w "%{http_code}" $API/api/ready
```

**Fix actions:**
1. Check the deployment platform dashboard (Vercel or Render) for build errors.
2. If the build succeeded but the app does not start, check environment
   variables -- a missing required variable can prevent boot.
3. If the issue is a bad code deploy, perform an emergency rollback (see
   [Emergency rollback steps](#emergency-rollback-steps) below).
4. After rollback, run the smoke test again to confirm recovery.

---

### 6. CORS/security misconfigurations

**Symptoms:**
- Frontend receives CORS errors in the browser console
- API responds with 403 or missing `Access-Control-Allow-Origin` headers

**Diagnosis:**

```bash
# Check CORS preflight
curl -s -X OPTIONS -H "Origin: https://your-frontend.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -i $API/api/invoices

# Check health (CORS is usually not blocking server-to-server)
curl -s $API/api/health | jq .
```

**Fix actions:**
1. Verify `FRONTEND_URL` and/or `FRONTEND_URLS` environment variables are set
   to the correct frontend origin(s).
2. Restart the service after correcting the values.
3. If the issue is urgent, temporarily set `FRONTEND_URLS` to include the
   affected origin, restart, and verify.

---

## Triage flowchart

Use this decision tree when an alert fires or a user reports an issue.

```
START
  |
  v
[1] curl $API/api/health
  |
  +-- non-200 or unreachable?
  |     |
  |     v
  |   [2] Check deployment platform dashboard (Vercel/Render)
  |     +-- deploy failed? --> Rollback deployment (see below)
  |     +-- app crashed? --> Check logs, restart service
  |     +-- OK? --> continue to [3]
  |
  +-- 200 but status unhealthy?
  |     |
  |     v
  |   [3] curl $API/api/ready
  |     +-- non-200? --> Database connectivity issue (Category 2)
  |     +-- 200? --> continue to [4]
  |
  +-- 200 and healthy?
        |
        v
      [4] curl ops/health (with admin token)
        |
        +-- deadJobs > 0? -----------> Job queue issue (Category 3)
        +-- staleJobs > 0? ----------> Worker not running (Category 3)
        +-- invoiceExpiryDrift > 0? -> Expiry sweep stalled (Category 3)
        +-- serverErrors > 0? -------> Check correlation IDs in logs
        +-- all zero?
              |
              v
            [5] curl /api/observability/metrics
              |
              +-- rising rejection codes? --> Payment verification (Category 1)
              +-- unexpected feature state? -> Feature flag issue (Category 4)
              +-- CORS errors in browser? --> CORS misconfiguration (Category 6)
              +-- all normal? --> Collect user report details, escalate
```

---

## Diagnosis commands

All commands use `$API` for the deployment origin and `$JOBS_ADMIN_TOKEN` for
the admin bearer token. Neither should be hardcoded.

### Health and readiness

```bash
# Liveness
curl -s $API/api/health | jq .

# Readiness (used by Render healthCheckPath)
curl -s -o /dev/null -w "ready: %{http_code}\n" $API/api/ready

# Feature flags
curl -s $API/api/health | jq .features
```

### Ops health report

```bash
# Full report (requires JOBS_ADMIN_TOKEN)
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/ops/health | jq '.data'

# Summary: status + categories that need attention
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/ops/health \
  | jq '.data | {status, attention, counts: (.categories | map_values(.count))}'
```

### Job inspection

```bash
# List dead jobs
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" "$API/api/jobs?status=dead" | jq .

# Inspect a specific job (full error history)
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" "$API/api/jobs/<JOB_ID>" | jq .

# Retry a dead job
curl -s -X POST -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/jobs/<JOB_ID>/retry

# List expiry sweep jobs
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" \
  "$API/api/jobs?type=invoices.expire-pending" | jq .
```

### Observability

```bash
# Application metrics (JSON)
curl -s $API/api/observability/metrics | jq .

# Prometheus format
curl -s $API/metrics
```

### Audit trail

```bash
# Recent payment verifications
curl -s "$API/api/audit/events?action=PAYMENT_VERIFIED"

# Recent payment rejections
curl -s "$API/api/audit/events?action=PAYMENT_REJECTED"

# Invoice-specific audit trail
curl -s "$API/api/invoices/<INVOICE_ID>/audit-trail"

# Export full audit trail
curl -s "$API/api/audit/export" -o audit-export.json
```

### Database

```bash
# Run migrations (idempotent)
cd backend && npm run db:migrate

# Test connection (local/CI only)
psql "$DATABASE_URL" -c "SELECT 1"

# Seed test data (non-production only)
cd backend && npm run db:seed
```

### Deployment verification

```bash
# Smoke test
cd backend && npm run deploy:smoke

# Type check
cd backend && npm run typecheck

# Full test suite
cd backend && npm test

# Postgres integration tests
cd backend && npm run test:pg
```

---

## Emergency rollback steps

### Disable a risky feature via feature flags

This is the fastest rollback for behaviour changes guarded by a flag.

1. Set the flag environment variable to `false` (or delete it -- the safe
   default is always the lower-risk behaviour):
   - **Render:** Dashboard > Environment > edit the variable > Save > Manual
     Deploy (or restart).
   - **Vercel:** Dashboard > Settings > Environment Variables > edit > Redeploy.
2. Restart the service for the change to take effect.
3. Verify: `curl -s $API/api/health | jq .features` should show the flag as
   `false`.

No migration or data change is involved. Invoices already settled under the
previous flag state stay `PAID`.

See [FEATURE_FLAGS.md](./FEATURE_FLAGS.md) for the current flag list and
rollout/rollback details.

### Rollback a Vercel deployment

1. Go to the Vercel dashboard for the project.
2. Navigate to **Deployments**.
3. Find the last known-good deployment.
4. Click the three-dot menu and select **Promote to Production** (or
   **Redeploy**).
5. Verify with `curl -s $API/api/health` and `npm run deploy:smoke`.

Alternatively, revert the commit in git and push, which triggers a new deploy
from the previous code state.

### Rollback a Render deployment

1. Go to the Render dashboard for the `quittance-api` service.
2. Navigate to **Events** or **Deploys**.
3. Find the last known-good deploy and click **Rollback** (or **Redeploy**
   from that commit).
4. Verify with `curl -s $API/api/health` and `npm run deploy:smoke`.

The Render blueprint (`backend/render.yaml`) uses `autoDeployTrigger: commit`,
so reverting the commit in git and pushing also triggers a rollback deploy.

### Rollback database migrations

Migrations are **forward-only** (`backend/src/db/migrate.ts`). There is no
automated rollback mechanism.

To reverse a migration:
1. Deploy the previous code version (which does not include the new migration).
2. If the migration added a column or table that the previous code does not
   use, it is harmless to leave it in place.
3. If the migration made a destructive change (dropped a column, changed a
   type), you must write a new forward migration to undo it and deploy that.
4. Always test migrations against a staging database before production.

### Drain or pause the job queue

To stop workers from picking up new jobs without losing queued work:

1. **Stop the standalone worker process** (`npm run worker`). Queued jobs
   remain in the database and are picked up when a worker restarts.
2. **Disable the embedded worker:** Set `JOBS_EMBEDDED_WORKER=false` and
   restart the API server. The API continues serving requests but does not
   process background jobs.
3. **Running jobs** finish or time out (lease expiry is 60 s). A job whose
   worker is killed mid-run will be reclaimed and retried when workers resume.

To resume: start the worker process or set `JOBS_EMBEDDED_WORKER=true` and
restart.

---

## Record reconciliation

### Find affected invoices

```bash
# List invoices by status
curl -s "$API/api/invoices?status=PENDING&sellerPublicKey=<SELLER_KEY>"
curl -s "$API/api/invoices?status=PAID&sellerPublicKey=<SELLER_KEY>"

# Filter by date range (if supported by query params)
curl -s "$API/api/invoices?status=PENDING&from=2026-09-25T00:00:00Z&to=2026-09-26T00:00:00Z"

# Export invoices for a seller (JSON or CSV)
curl -s -X POST "$API/api/exports" \
  -H "Content-Type: application/json" \
  -d '{"requester": "<SELLER_KEY>", "format": "json", "status": "PENDING"}'
```

### Identify stuck PENDING invoices

Invoices past their `expiresAt` that are still `PENDING` indicate the expiry
sweep is stalled.

```bash
# Check expiry drift in ops report
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" $API/api/ops/health \
  | jq '.data.categories.invoiceExpiryDrift'
```

The expiry sweep (`invoices.expire-pending`) marks overdue invoices as
`EXPIRED`. If the sweep is dead:
1. Retry the dead sweep job: `POST /api/jobs/:id/retry`.
2. Ensure a worker is running (the sweep is enqueued automatically).
3. Invoices are also expired lazily on read, so a `GET` for a specific invoice
   will show it as `EXPIRED` even if the sweep has not run yet.

### Verify payment event consistency

```bash
# Compare paid invoices with payment verification audit events
curl -s "$API/api/audit/events?action=PAYMENT_VERIFIED" | jq '.[].invoiceId' > verified.txt
curl -s "$API/api/invoices?status=PAID&sellerPublicKey=<SELLER_KEY>" | jq '.data[].id' > paid.txt
diff verified.txt paid.txt

# Check for rejected payments on a specific invoice
curl -s "$API/api/invoices/<INVOICE_ID>/audit-trail" | jq .

# Cross-reference a payment on Horizon using the transaction hash
curl -s "https://horizon-testnet.stellar.org/transactions/<TX_HASH>" | jq .
```

---

## Communication checklist

### Who to notify

- **Project maintainers:** Notify via the project's primary communication
  channel (issue tracker, team chat).
- **Affected sellers:** If invoices were impacted, notify sellers through the
  application's notification system or direct communication.

### What to include in the incident report

- **Timestamp:** When the issue was detected (UTC).
- **Duration:** How long the incident lasted.
- **Impact:** Number of affected invoices, sellers, or failed operations.
  Use `computeUserImpactReport()` from `scripts/incident-drill.ts` against the
  set of invoices found in [Record reconciliation](#record-reconciliation)
  above to compute these figures (and masked seller keys) rather than
  counting by hand; `npx tsx scripts/incident-drill.ts --json` runs it
  against a sample fixture to verify the check itself still works.
- **Category:** Which incident category (1--6 above).
- **Correlation IDs:** From the ops health report or observability metrics.
  Never include raw data, secrets, or full keys.
- **Root cause:** What caused the issue.
- **Resolution:** What was done to fix it.
- **Follow-ups:** Any remaining work (e.g. reconciliation, code fixes).

### Post-incident review template

```
## Incident: [Title]
**Date:** YYYY-MM-DD
**Duration:** HH:MM - HH:MM UTC
**Severity:** [Critical / High / Medium / Low]
**Category:** [Payment / Database / Jobs / Feature Flag / Deployment / CORS]

### Timeline
- HH:MM — Issue detected (how: alert, user report, smoke test)
- HH:MM — Triage started, initial diagnosis
- HH:MM — Root cause identified
- HH:MM — Fix applied (rollback / config change / restart)
- HH:MM — Service confirmed healthy

### Impact
- Invoices affected: N
- Sellers affected: N
- Payments delayed/failed: N

### Root cause
[Description — what broke and why]

### Resolution
[What was done to fix it]

### Lessons learned
- What went well
- What could be improved
- Action items (with owners and deadlines)
```

---

## Security notes

- **Never expose secrets** (`JOBS_ADMIN_TOKEN`, `DATABASE_URL`, Stellar secret
  keys, `HORIZON_URL` credentials) in incident reports, issues, chat, or logs.
- **Use correlation IDs** from `/api/observability/metrics` and the ops health
  report for cross-referencing events. These are safe to share.
- **Mask Stellar keys** in external communications: show the first 4 and last 4
  characters only (e.g. `GABC...WXYZ`). The ops health report already applies
  this masking to seller keys.
- **Sanitised job errors** in the ops report strip emails (`[email]`) and
  truncate to 200 characters. Use `GET /api/jobs/:id` (admin-only) for full
  error details; do not paste those externally.
- **Audit exports** (`GET /api/audit/export`) contain operation identifiers but
  no personal data. They are safe for internal analysis but should not be shared
  externally without review.
- **Invoice exports** never include seller, customer, or payer names or emails
  (see [EXPORTS.md](./EXPORTS.md)).
