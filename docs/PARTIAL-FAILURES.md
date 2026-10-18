# Partial failures

`backend/src/domain/partial-failures.ts` builds a report of operations that
started internally but did not finish in an external system (a background
job that died or keeps retrying, a payment seen on chain that never settled
its invoice). It is a pure function: it reads plain records and never retries or
resolves anything.

```ts
import { buildPartialFailureReport, jobsToOperations } from './domain/partial-failures';

const report = buildPartialFailureReport(jobsToOperations(jobs), { now: new Date() });
```

## What the report contains

- `unresolved`: open failures, most severe and oldest first.
- `summary`: counts by operation type, severity, age bucket (`under_1h`,
  `1h_to_24h`, `over_24h`) and how many are retryable. Resolved and ignored
  operations are counted but not listed.

Each failure carries its internal state, the external reference (tx hash or
job correlation id), attempts, and `links` to inspect it, retry it (only when
retryable and open) and read the remediation below. Error text goes through
`redactSecrets`, which strips Stellar secret seeds, bearer tokens, credentials
in URLs and `token=` / `password=` style values. Job stack traces are never
included.

## Severity

| Severity | When |
| -------- | ---- |
| `critical` | any `payment.*` operation (funds may be involved) |
| `error` | not retryable, or open longer than the stale window (24h by default) |
| `warning` | retryable and recent |

An operation with `resolvedAt` is resolved. One with `ignoredAt` has been
dismissed by an operator and should carry `ignoredReason`.

## Remediation

### job

Queued jobs with errors are retried by the worker on their backoff schedule.
Dead jobs have used up their attempts or failed with a non retryable error:
read the error history, fix the cause, then requeue from the dead letter set
(see [JOBS.md](JOBS.md)).

### payment

Treat the chain as the source of truth. Look the transaction up on Horizon and
settle the invoice through the normal verify path; see
[VERIFY.md](VERIFY.md).

## Tests

```bash
cd backend && node --import tsx --test tests/partial-failures.test.ts
```
