# Background jobs

Delayed and retryable work runs through a small durable job queue instead of
request handlers or ad-hoc `setInterval` timers. Code lives in
`backend/src/jobs/`.

## Lifecycle

```
queued ──claim──▶ running ──ok──────────────▶ succeeded
   ▲                 │
   │                 ├─ error, attempts left ─▶ queued (run_at = now + backoff)
   │                 └─ error, exhausted or
   │                    NonRetryableJobError ─▶ dead   (dead-letter set)
   └──────── POST /api/jobs/:id/retry ───────────┘
```

A `running` job holds a lease (`locked_until`, default 60 s). If its worker
crashes, another worker reclaims the job once the lease expires. A worker that
lost its lease cannot mark the job succeeded or failed (guarded by `locked_by`).

## Job format

| Field | Meaning |
| --- | --- |
| `type` | Handler name, e.g. `invoices.expire-pending` |
| `payload` | `{ version, data }` — versioned so handlers can evolve |
| `retryPolicy` | `maxAttempts` (incl. first), `baseDelayMs`, `backoffFactor`, `maxDelayMs` |
| `idempotencyKey` | Optional. Enqueueing an existing key returns the existing job |
| `errors[]` | Every failed attempt: `attempt`, `at`, `message`, `stack` |
| `result` | Handler return value once succeeded |

Defaults: 5 attempts, 1 s base delay, ×2 backoff, capped at 5 min.

## Writing a job

```ts
worker.register('my.job', async (payload, { attempt, idempotencyKey }) => {
  // Delivery is at-least-once: a job can run again after a crash or lease
  // expiry. Key side effects on idempotencyKey so a rerun is harmless.
  return { done: true };
});
await queue.enqueue('my.job', { id: 1 }, { idempotencyKey: 'my.job:1' });
```

Throw `NonRetryableJobError` for failures that retrying cannot fix (bad
payload); the job is dead-lettered immediately.

## Built-in job: invoice expiry

`invoices.expire-pending` replaces the `setInterval` that used to live in
`PaymentMonitorService`. A scheduler enqueues one sweep per minute; the bucket
number is the idempotency key, so multiple instances never duplicate a sweep.
The sweep itself (`markExpiredInvoices`) is idempotent. It now runs even when
`SELLER_PUBLIC_KEY` is unset (previously only with the payment monitor).

## Running workers locally

Requires PostgreSQL with the schema applied (`npm run db:migrate` creates the
`jobs` table; re-running is safe).

```bash
cd backend
npm run dev:pg          # API + embedded worker (default)
npm run worker          # standalone worker process (uses DATABASE_URL)
```

To run workers only in the standalone process, start the API with
`JOBS_EMBEDDED_WORKER=false`. Any number of workers may run concurrently;
claiming uses `FOR UPDATE SKIP LOCKED`.

The MVP in-memory server (`dev:mvp`) has no timers: it expires invoices lazily
on read. `MemoryJobStore` is available for tests and local experiments.

## Inspecting jobs

Payloads and stack traces are internal, so the routes require
`Authorization: Bearer $JOBS_ADMIN_TOKEN`. If `JOBS_ADMIN_TOKEN` is unset the
routes return `403` (disabled).

| Route | Purpose |
| --- | --- |
| `GET /api/jobs?status=&type=&limit=&offset=` | List jobs, plus counts per status |
| `GET /api/jobs/:id` | Full job including error history |
| `POST /api/jobs/:id/retry` | Requeue a dead job with a fresh attempt budget (audited) |

```bash
curl -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" "localhost:3001/api/jobs?status=dead"
```

## Tests

`backend/tests/jobs.test.ts` — retry with backoff, retry exhaustion into the
dead-letter set, non-retryable errors, crash recovery / stale-worker rejection
and idempotent reprocessing, expiry scheduling, admin auth and routes, and the
Postgres query contract (against a stub pool).
