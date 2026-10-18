# Disaster Recovery Validation

Read-only validation of the core domain invariants, for use after a database
restore, a migration, or any incident where a maintainer needs evidence that the
data is still coherent.

- **Command:** `npm run db:validate` (from `backend/`)
- **Implementation:** `backend/src/db/restore-validation.ts`
- **CLI:** `backend/src/db/validate-restore.ts`
- **Tests:** `backend/tests/restore-validation.test.ts`

## What it answers

A migration that exits `0` has told you the statements ran. It has not told you
that an invoice marked `PAID` still has the transaction that settled it, that a
restored backup did not break the `memo` uniqueness the settlement flow depends
on, or that half the `jobs` rows are stuck `running` with nobody to finish them.

This command answers exactly that. It runs a fixed set of invariants, reports
how many rows violate each, and exits non-zero if any do — so it can gate a
cutover:

```bash
# Gate a cutover: refuse to promote a restore that fails validation
npm run db:validate --prefix backend || { echo "restore invalid, stopping"; exit 1; }
```

## It never writes

This is the property that makes it safe to point at a database you are trying to
recover. Every statement is a `SELECT`, and `assertReadOnly` re-checks each one
at runtime, so a future edit that introduces a write fails loudly instead of
executing. There is no `--apply` flag, and there is no code path that issues an
`INSERT`, `UPDATE` or `DELETE`. Run it as often as you like.

## Usage

```bash
cd backend

npm run db:validate                      # human-readable report
npm run db:validate -- --json            # machine-readable, for CI or a report
npm run db:validate -- --sample-limit=20 # wider offender sample
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every invariant holds. |
| `1` | At least one invariant is violated. The report lists remediation per failure. |
| `2` | The validation could not run at all (unreachable database, bad configuration). |

Configuration comes from the usual `DATABASE_URL`; see `backend/env.example.txt`.

## The invariants

Grouped by the failure each one catches.

### orphaned — a reference that no longer resolves

| Id | Checks |
| --- | --- |
| `transactions.orphaned-invoice` | Every `transactions.invoice_id` points at an invoice that exists. |
| `payment-events.orphaned-invoice` | Every `payment_events.invoice_id` points at an invoice that exists. |

A restore that dropped invoices while keeping their transactions is the usual
cause. Do not simply delete the transactions: they are the only evidence the
payment happened.

### missing — a record something depends on is absent

| Id | Checks |
| --- | --- |
| `invoices.missing-transaction` | Every `PAID` invoice has a transaction behind it. |
| `transactions.detached-from-invoice` | A transaction whose memo still matches an invoice is still linked to it. |

`transactions.invoice_id` is declared `ON DELETE SET NULL`, so deleting an
invoice silently detaches its payment history rather than blocking the delete.
`transactions.detached-from-invoice` exists specifically to catch that: the
transaction survives, the link does not, and the invoice looks unpaid.

### duplicated — a uniqueness guarantee the restore broke

| Id | Checks |
| --- | --- |
| `invoices.duplicate-memo` | No two invoices share a `memo`. |
| `transactions.duplicate-tx-hash` | No two transactions share a `tx_hash`. |

Both columns carry `UNIQUE` in `db/schema.sql`, so these can only fail if the
constraints were not restored. The impact is settlement-critical: duplicate
memos make two invoices indistinguishable at payment, and a duplicated
`tx_hash` means one payment can be counted twice.

### inconsistent — a record contradicts its neighbours

| Id | Checks |
| --- | --- |
| `invoices.paid-without-timestamp` | `PAID` implies `paid_at` is set. |
| `invoices.unpaid-with-timestamp` | Not `PAID` implies `paid_at` is null. |
| `invoices.paid-without-tx-hash` | `PAID` implies `payment_tx_hash` is set. |
| `invoices.unknown-status` | Status is one of `PENDING`/`PAID`/`EXPIRED`/`CANCELLED`. |
| `invoices.amount-disagrees-with-settlement` | A settled invoice agrees with its transaction's amount. |
| `invoices.expiry-not-after-creation` | `expires_at` is after `created_at`. |
| `invoices.version-invalid` | `version >= 1`, so optimistic concurrency still detects lost updates. |
| `invoices.paid-but-overdue` | A `PAID` invoice was not settled after its `expires_at`. |
| `jobs.stale-running-lease` | No job is `running` with an expired lease. |
| `jobs.terminal-without-completion` | A `succeeded`/`dead` job has `completed_at`. |
| `jobs.non-terminal-with-completion` | A `queued`/`running` job has no `completed_at`. |

`invoices.amount-disagrees-with-settlement` and `invoices.paid-but-overdue` are
flagged as judgement calls, not defects. Both are possible in a healthy
database: a late payment can legitimately settle after the window, and a
corrected amount is a real accounting event. Confirm against the ledger before
changing anything.

## Interpreting failures

Each violation is reported with an offending-row sample and a remediation
line. The triage order that works:

1. **Duplicates first.** They poison every downstream join and make the other
   checks' counts untrustworthy. De-duplicate, re-apply the constraint, re-run.
2. **Orphans next.** Decide per row whether the parent is recoverable. Restoring
   the parent is almost always right; the child is the evidence.
3. **Missing settlement evidence.** Treat every `PAID` invoice in this state as
   unverified. Re-verify `payment_tx_hash` against Horizon before you let the
   invoice be reported as revenue.
4. **Inconsistencies last.** Most are repairable from a sibling record. The
   amount and overdue cases need a human.

A check that **could not run** is reported as `FAIL` with the error, not as a
pass. An unknown state is not a healthy one — reporting success because a probe
errored would hide the very thing you are checking for. The same applies to a
partial restore: if `jobs` or `transactions` is absent, the report says so
rather than quietly validating the rest.

## Recovery assumptions

- **The database is the source of truth for invoices, transactions, payment
  events and jobs.** Audit events, notifications, email delivery records and
  export artifacts are in-memory or derived, so a restore does not recover them
  — see `docs/DATA_RETENTION.md`.
- **Validation is evidence, not repair.** It reports; it does not fix. Every
  remediation is a decision with accounting consequences.
- **Stellar is the settlement authority.** Where a local record disagrees with
  the network, the network wins. Use `POST /api/invoices/:id/verify` to
  re-derive status rather than editing rows.
- **Restoring an older backup is expected.** The `version` and `expires_at`
  checks catch the two schema convergences most likely to be missing from an
  older restore.

## Escalation

If a violation cannot be resolved from available backups:

1. Capture the report (`--json`) and attach it, with the `correlationId`s and
   timestamps, to the incident.
2. Escalate to a maintainer with invoice access — an impersonation session
   (`POST /api/ops/impersonation`) is audited and is the supported path for
   support-driven inspection.
3. Do **not** delete settlement records to make validation pass. A failing
   report is a correct report; a silenced one is a corrupted ledger.

Related: [MIGRATIONS.md](MIGRATIONS.md), [RUNBOOK.md](RUNBOOK.md),
[DATA_RETENTION.md](DATA_RETENTION.md), [CONCURRENCY.md](CONCURRENCY.md)
