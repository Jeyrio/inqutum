# Data Retention

Explicit retention behaviour for operational data, so records are kept long
enough for audits and support without accumulating indefinitely.

- **Policy:** `backend/src/db/retention.ts` (`RETENTION_POLICY`)
- **Executor and job:** `backend/src/db/retention-sweep.ts`
- **Job type:** `retention.sweep`
- **Tests:** `backend/tests/data-retention.test.ts`

## The problem this solves

Retention was previously an accident of implementation rather than a decision:

- Postgres rows were kept forever, because nothing ever deleted them.
- The audit buffer, email delivery log and notification list are bounded
  in-memory ring buffers (5000 / 2000 entries). That is a memory guard, not a
  retention policy — it evicts the oldest entry under pressure, regardless of
  whether a dispute depends on it, and loses everything on restart.
- Export artifacts had a 24 h TTL, which was the only rule anyone had written
  down.

This document makes the rules explicit, gives every window a rationale, and
puts the destructive decision behind a dry run.

## Classification

| Class | Data | Window | Purgeable | Why |
| --- | --- | --- | --- | --- |
| `settlement` | `transactions` | **indefinite** | no | The evidence a payment happened. A deleted transaction cannot be reconstructed from the network, and invoices are reported against them. |
| `invoice_lifecycle` | unsettled `invoices` | 730 d | yes | Two years covers support and tax reconciliation. `PAID` invoices are settlement-linked and protected instead. |
| `payment_event` | `payment_events` | 730 d | yes | Matches the invoices they describe, so a timeline never has a hole. |
| `audit_trail` | durable audit copies | 365 d | yes | One year covers a full support cycle. |
| `telemetry` | metrics and logs | 30 d | yes | Answers "is this endpoint slowing down" and nothing longer. Highest volume, no audit value. |
| `export_artifact` | generated documents | 7 d | yes | Contains the invoice data it was built from, so it must not outlive it. |
| `support_evidence` | bounces, impersonation records | 90 d | yes | The support follow-up window, including what was sent and to whom. |
| `job_history` | completed / dead `jobs` | 30 d | yes | Enough to investigate a failure. Dead-lettered jobs get 90 d. |

The age anchor differs per class and is part of the rule, not an assumption:
`created_at` for most, `processed_at` for transactions, `completed_at` for jobs.

## Protection always wins

Eligibility is decided in this order, and the first rule that matches wins:

1. **Financial settlement.** Anything a `PAID` invoice depends on is never
   eligible, at any age. A three-year-old settled invoice is still protected;
   age never overrides it. This is a ledger, not a cache.
2. **Legal hold.** `metadata.legal_hold`, `metadata.under_dispute` or
   `metadata.under_audit` set to `true` pins a record regardless of class or
   age.
3. **Class window.** Only then does the retention window apply.

A record whose age anchor cannot be parsed is also protected rather than
guessed at. Keeping a row costs storage; deleting a financial record that was
merely mis-anchored costs an audit trail.

### About the hold convention

The repository has no disputes or cases table. Rather than invent a
case-management subsystem inside a retention issue, holds are expressed through
the `metadata` JSONB column that already exists on `invoices`. This is a
convention, deliberately, and it has two consequences worth stating plainly:

- A record is only held if something **writes** the flag. Nothing sets it
  automatically today; it is the integration point for a future dispute or
  audit system.
- Because the check reads `metadata`, it works without a schema change, so
  pointing it at a real `disputes` table later is a change to one function
  (`hasLegalHold`), not a migration of every row.

## Running a sweep

The sweep is a background job, `retention.sweep`, registered by
`registerRetentionJob`. **Dry run is the default** — the job cannot delete
anything unless the payload explicitly says so.

```jsonc
// Report only. The default, and what a scheduler should enqueue.
{ "version": 1, "data": {} }

// Apply, bounded to one table.
{ "version": 1, "data": { "dryRun": false, "tables": ["payment_events"] } }
```

Output:

```
====================================================
Inqutum retention sweep — DRY RUN (nothing will be deleted)
Generated: 2026-09-27T12:00:00.000Z
====================================================

  settlement         window=indefinite eligible=0 protected=1
  invoice_lifecycle  window=730d       eligible=1 protected=3
  job_history        window=30d        eligible=0 protected=0

  1 record(s) eligible; first 5: invoices/i-old

  Dry run complete. 1 record(s) would be removed. Re-run with dryRun:false to apply.
====================================================
```

## Safety properties

The affected records are always reported **before** the first `DELETE` is
issued, as the issue requires. Beyond that:

- **Dry run by default.** `dryRun !== false` means report-only.
- **Bounded batches.** Each table is capped at `batchSize` rows (default 1000)
  per run, so a mistaken window cannot delete a table in one sweep.
- **Unknown tables are refused.** A table the policy does not describe raises
  rather than being silently skipped.
- **Failures are never retried.** A sweep that errors part-way may have removed
  part of a batch, so it throws `NonRetryableJobError` and waits for a human
  instead of retrying and compounding the damage.

## Why the decision is a pure function

`planRetention(records, { now })` takes records and a clock and returns what is
eligible, what is protected, and why. It touches no database.

This is the important structural choice. A cleanup job that decides *and*
deletes is a destructive script whose decision logic nobody can test without a
database. Splitting them means the decision has 34 tests covering every class,
every protection rule and both window edges, while the executor only has to do
one thing: execute a decision it was handed.

## What this does not cover

- **In-memory stores.** The audit buffer, notification list and email delivery
  log are bounded in memory and vanish on restart. They have no durable
  retention to manage; if those need to survive a restart, that is a storage
  decision, not a retention one.
- **Backups and exports of the database itself.** This policy governs rows in
  the live database. Retention of backup snapshots is a separate concern.
- **Legal/regulatory minimums.** The windows above are engineering defaults
  chosen to be defensible. If a jurisdiction or contract requires a different
  period, change `RETENTION_POLICY` — it is data, and the tests will show you
  what moves.

Related: [RESTORE_VALIDATION.md](RESTORE_VALIDATION.md), [JOBS.md](JOBS.md),
[RUNBOOK.md](RUNBOOK.md), [MIGRATIONS.md](MIGRATIONS.md)
