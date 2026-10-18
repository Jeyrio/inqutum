# Maintainer ops health report

`GET /api/ops/health` returns one JSON summary of everything a maintainer
should act on: unresolved failures, stale work, reconciliation drift and
user-facing errors. It uses the same maintainer token as the job routes.
If `JOBS_ADMIN_TOKEN` is unset the route returns `403`, and a wrong token
returns `401`.

```bash
curl -s -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" localhost:3001/api/ops/health \
  | jq '.data | {status, attention, counts: (.categories | map_values(.count))}'
```

`data.status` is `ok` when every category count is 0, otherwise `attention`.
`data.attention` lists the categories that need action. The route is mounted
on the Postgres server (`npm run dev`), next to `/api/jobs`.

## Health categories

Each category has a `count`, a `description`, a `link` to the list to
investigate, and up to 10 `samples`, each with its own `link`.

| Category | Counts | What to do |
|---|---|---|
| `deadJobs` | Jobs in the dead-letter set (`status = dead`). Equals `counts.dead` from `GET /api/jobs`. | Open the sample `link`, fix the cause, then `POST /api/jobs/:id/retry`. |
| `staleJobs` | `running` jobs whose lease has expired (the worker died mid-job), plus `queued` jobs more than 5 minutes past `runAt` (no worker draining the queue). | Check that `npm run worker` is running. Expired leases are reclaimed automatically once a worker is up. |
| `invoiceExpiryDrift` | `PENDING` invoices more than two sweep intervals (2 min) past `expires_at`. Reads still hide this from users by expiring lazily, but a non-zero count means the `invoices.expire-pending` sweep is stalled or failing. | Check `GET /api/jobs?type=invoices.expire-pending` for dead or stuck sweeps. |
| `serverErrors` | Failed operations with HTTP status ≥ 500 (or no status) in the in-process recent-log buffer (last 200 operations). 4xx responses are caller errors and are excluded. | Search logs for the sample `correlationId`. `GET /api/observability/metrics` has the per-code breakdown. |

`staleJobs` is omitted when the server has no job store. `thresholds` in the
response echoes the limits in use (`backend/src/ops/ops-health.ts`).

## Redaction

The report is meant to be pasted into issues and chat, so it carries
identifiers, not data:

- Job samples: id, type, attempts, timestamps, and the last error message run
  through `sanitizeForLogging`, with emails replaced by `[email]` and the text
  cut to 200 characters. It never includes payloads or stack traces.
  `GET /api/jobs/:id` (same token) has those.
- Invoice samples: id, expiry, and the seller key masked to `GABC…WXYZ`. It
  never includes amounts, names or emails.
- Error samples: operation, error code, status and correlation id. Log
  `metadata` is not included.

## Limits

- `serverErrors` is per process and resets on restart. For history across
  instances, use your log platform.
- Stale-job counts scan up to 1,000 rows per status. Above that the category
  reports `truncated: true` and the count is a lower bound.

## Tests

```bash
cd backend
node --import tsx --test tests/ops-health.test.ts          # counts, redaction, auth
DATABASE_URL=postgres://… npm run test:pg                  # overdue-invoice SQL
```
