# Recovery checkpoints around external side effects (#289)

Module: [`backend/src/recovery/side-effect-checkpoint.ts`](../backend/src/recovery/side-effect-checkpoint.ts).

An email handed to a provider cannot be rolled back. If the process dies after
the provider accepts it but before the result is recorded, a naive retry sends
it twice. A checkpoint records the intent before the call and the outcome after
it, keyed by an idempotency key:

```
(none) ──claim──▶ started ──ok──────▶ succeeded   retry returns the stored result
                    │  └──error─────▶ failed      the next retry runs it again
                    └──stale────────▶ in_doubt    outcome unknown; never re-run blindly
```

## Which side effects are covered

| Side effect | Key | Store |
|-------------|-----|-------|
| `EmailDeliveryService.deliver` (`POST /api/email/send`) | `email:<idempotencyKey>` (the route already derives `invoice:<invoiceId>`) | Postgres (`side_effect_checkpoints`) on the Postgres server, process memory elsewhere |
| `EmailService.sendInvoiceEmail` (`POST /api/invoices/:id/send-email`) | `invoice-email:<invoiceId>:<Idempotency-Key header>` | Process memory |

- Sends without a key are not deduplicated, as before.
- `StellarService.sendPayment` has no caller in this codebase and was left unchanged.

## Paths

- **Normal:** claim → send → `succeeded`. A retry with the same key returns the first result without calling the provider.
- **Failure:** the send fails → `failed` with the error. The next request with the key sends again (`attempt + 1`).
- **Concurrent duplicate:** the key is `started` and not stale → `409 EMAIL_SEND_IN_PROGRESS`, retryable.
- **Crash:** a `started` row older than the stale window (`checkpointStaleAfterMs`, default 5 min) → `in_doubt` → `409 EMAIL_OUTCOME_IN_DOUBT`, not retryable.
- **Checkpoint store down:** the send is refused (retryable) rather than made unrecorded.
- **Fencing:** every settle is conditional on the attempt number, so a run that lost its claim cannot overwrite a newer one.
- **Key reused for a different payload:** each checkpoint stores a SHA-256 fingerprint of the email (recipient, subject, body). A different payload under the same key returns `422` (`EMAIL_IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_KEY_REUSED`) and is never answered with the first email's result. This follows the IETF Idempotency-Key draft (`draft-ietf-httpapi-idempotency-key-header`), which also recommends `409` for a request still in progress.
- **Authorization:** an invoice email key is scoped to the invoice id, so reusing a key on another invoice can never replay this invoice's result.

## Resolving `in_doubt` (operator)

1. Look the message up in the provider's log (recipient, time window).
2. If it was delivered:
   `UPDATE side_effect_checkpoints SET state = 'succeeded', result = '{"status":"sent","ok":true}' WHERE key = '<key>' AND state = 'in_doubt';`
3. If it was not:
   `UPDATE side_effect_checkpoints SET state = 'failed' WHERE key = '<key>' AND state = 'in_doubt';`
   The next request sends it.

Open checkpoints:

```sql
SELECT key, effect, state, attempt, updated_at
FROM side_effect_checkpoints
WHERE state IN ('started', 'in_doubt');
```

This query is served by the partial index `idx_side_effect_checkpoints_open`.

## Operational edge cases

- **Stale window:** keep it above the longest possible send (provider timeout × attempts + backoff). Too short, and a slow but live send is declared in doubt.
- **The process-memory store** survives retries but not restarts. That is acceptable for the MVP server, whose delivery log is also in memory.
- **Growth:** rows are one per key. Purge old settled rows when needed:
  `DELETE FROM side_effect_checkpoints WHERE state IN ('succeeded','failed') AND updated_at < NOW() - INTERVAL '90 days';`

## Contract and migration

- **Migration:** `npm run db:migrate` adds `side_effect_checkpoints` (idempotent `CREATE TABLE IF NOT EXISTS`). Apply it before deploying the code. The Postgres server writes to the table on the first keyed email.
- **New outcomes:** `409` and `422` on `POST /api/email/send` and `POST /api/invoices/:id/send-email`, plus `400 INVALID_IDEMPOTENCY_KEY` for a header longer than 200 characters. All are in `API_CONTRACT`.
- **Replaced shortcut:** `EmailDeliveryService.deliver` no longer short-circuits on the in-memory delivery log, which matched on the key alone. The checkpoint replays the first result for the same key and payload, so retries still never resend.
- **CORS:** allows the `Idempotency-Key` request header.
- **Rollback:** revert the code. The table is additive and may be dropped afterwards with `DROP TABLE side_effect_checkpoints;`.
