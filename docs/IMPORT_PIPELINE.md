# Invoice Import Pipeline

Bulk-load invoices from an existing system, with a dry run that tells you
exactly what would change before anything is written.

- **Format:** `backend/src/imports/import-format.ts`
- **Validation and planning:** `backend/src/imports/import-pipeline.ts`
- **Execution and rollback:** `backend/src/imports/import-executor.ts`
- **CLI:** `backend/src/imports/import-cli.ts` (`npm run db:import`)
- **Tests:** `backend/tests/invoice-import.test.ts`

## The problem this solves

Onboarding data was previously a sequence of `curl` calls against the public
API. That has three bad properties:

- No preview. A 4,000-row file either half-succeeds or you find out which
  4,000 rows failed by grepping logs.
- No undo. A mistake means writing a script to find and revert what you
  changed, against a live ledger.
- No honest statement of what a re-run does. Running the same import twice
  either creates duplicates or is a no-op depending on undocumented details.

This importer is dry-run-first and idempotent-by-default, and it hands you an
undo file.

## Usage

```bash
# Dry run. Writes nothing. This is the default.
npm run db:import -- --file invoices.csv

# Apply, after reading the dry run.
npm run db:import -- --file invoices.csv --apply

# Import the valid rows and report the rest.
npm run db:import -- --file invoices.csv --apply --on-error skip

# Machine-readable, for CI.
npm run db:import -- --file invoices.csv --json

# Undo.
npm run db:import -- --rollback invoices.csv.snapshot.json
```

Exit codes: `0` success or a clean dry run, `1` the file has errors, `2` the
command itself failed.

## Format

CSV with a header row is the primary format — reviewable in a spreadsheet and
diffable in a pull request. NDJSON (`.ndjson`, `.jsonl`) is accepted for data
that is already JSON.

```csv
externalId,sellerPublicKey,amount,assetCode,assetIssuer,description,expiresInDays,customerEmail,metadata
LEGACY-1,GABC...XYZ,1250.50,XLM,,Invoice 0001,30,ada@example.com,"{""order"":""A-17""}"
```

| Column | Required | Rules |
| --- | --- | --- |
| `externalId` | no | ≤255 chars. **Supply it** — it is what makes the import idempotent. |
| `sellerPublicKey` | **yes** | 56-char Stellar account (`G` + 55 base32 chars). |
| `amount` | **yes** | Plain decimal, > 0, ≤ 1,000,000,000. No thousands separators. |
| `assetCode` | no | Defaults to `XLM`. |
| `assetIssuer` | conditional | Required for any asset except `XLM`; forbidden on `XLM`. |
| `description` | no | ≤500 chars, markup stripped. |
| `customerName` / `sellerName` | no | ≤255 chars. |
| `customerEmail` / `sellerEmail` | no | Valid email. |
| `expiresInDays` | no | Whole days within the policy range. Default applies otherwise. |
| `createdAt` / `expiresAt` | no | ISO-8601. Both supplied → `expiresAt` wins. |
| `memo` | no | `INV-<alnum>-<alnum>`. Generated when omitted. |
| `metadata` | no | JSON object. |

### What the format refuses

These columns are rejected outright, with a reason in the error:

`status`, `paidAt`, `paymentTxHash`, `payerPublicKey`, `payerName`,
`payerEmail`, `id`, `version`

A payment's status and its transaction hash are *evidence*. They are recorded
when settlement is observed on-chain, and a data file is not an observation. An
import that could set `status: PAID` could mark an invoice as settled for
money that never arrived, and the invoice would then be treated as a completed
receivable forever. The same reasoning excludes `id` and `version`, which the
server assigns.

### Validation

Every row is validated against `createInvoiceSchema` — the same zod schema the
HTTP API uses. This is deliberate: an import must not be able to create an
invoice the API would reject, so the two cannot drift. If the API's rules
change, the importer changes with them.

The importer additionally rejects things the API does not have to worry about
because a request carries one invoice: a malformed CSV (unterminated quotes,
wrong field counts), a duplicate column, an unknown column, a duplicate
`externalId` within the file, and a `metadata` value that is not a JSON object.

## Dry-run output

```
============================================================================
Inqutum import — DRY RUN (no data was written)
============================================================================

  4 row(s): 1 to create, 1 to update, 1 already current, 1 failed validation

  CREATE (1)
----------------------------------------------------------------------------
    line 4  GAAAAAAA…  2500 XLM  externalId=NEW-1
      Deposit for March
      ! no externalId supplied, so this row is not idempotent: re-running the
        file will create a second invoice

  UPDATE (1)
----------------------------------------------------------------------------
    line 3  invoice inv-2  externalId=SRC-2
      description: "Order 2" -> "Order 2 amended"

  SKIP (1) — already present and unchanged; a re-run is a no-op
    line 2  invoice inv-1  externalId=SRC-1

  ERROR (1) — these rows will not be imported
----------------------------------------------------------------------------
    line 5  externalId=A-3
      amount: must be a plain decimal number (got "ten dollars")
        fix: must be a plain decimal number, greater than zero, e.g. 1250.50

  1 created row(s) have no externalId. A re-run of this file will create
  duplicates; add externalId to those rows if the file may be imported more
  than once.

============================================================================
Dry run complete. Re-run with --apply to write these changes.
============================================================================
```

A dry run performs no persistent writes. `planImport` takes rows, a set of
existing records and a clock, and has no database handle at all — the decision
cannot write because there is nothing to write through.

## Idempotency

A re-run of the same file against an unchanged database is a no-op: every row
reports `skip`. The identity used is:

1. `externalId`, when the row supplies one. This is the intended key.
2. `memo`, when the row supplies one. A file that carries memos is idempotent
   without external IDs.

Rows that supply neither cannot be deduplicated across runs, and the dry run
says so on each one. That is a property of the file, not a limitation the
importer hides: the alternative would be inventing a hash-based key that
silently collides.

The unique index backing this is part of the schema, not just the pipeline:

```sql
CREATE UNIQUE INDEX idx_invoices_external_id
  ON invoices(external_id) WHERE external_id IS NOT NULL;
```

so two concurrent imports of the same external ID cannot both succeed even if
they interleave their planning.

### What an update may change

Only descriptive fields: `description`, `customerName`, `customerEmail`,
`sellerName`, `sellerEmail`, `expiresAt`, `metadata`.

Identity fields — `amount`, `assetCode`, `assetIssuer`, `sellerPublicKey` —
are compared, and a disagreement is an **error**, not an update. These terms
define what a buyer owes. If the stored invoice says 100 XLM and the file says
999, the import cannot decide which is right, so it refuses and tells you to
reconcile the source data.

Two more rules:

- **Omitted means unchanged.** A column the file does not mention is not reset
  to a default. Without this, every re-import would rewrite the expiry of every
  invoice it touched.
- **`PAID` is frozen.** If the file would change any field on a settled
  invoice, that is an error. A matching row still skips, so re-importing an
  archived file is harmless.

## Partial failures

`--on-error abort` (the default) refuses the entire file if any row is invalid.
`applyImport` refuses to open a transaction, so a partly-valid file cannot be
half-applied by accident.

`--on-error skip` imports the valid rows and reports the rest. The dry run
shows the counts either way, so the choice is made with full information.

On the database side the whole file is **one transaction**. A failure on row
900 rolls back rows 1–899; there is no partial commit. Rows being updated are
re-read `FOR UPDATE` inside the transaction, and if a row has disappeared since
the dry run the import aborts rather than writing to the wrong record.

### Undoing an import

`--apply` writes a snapshot of everything it touched *before* it touches any of
it, to `<file>.snapshot.json` (mode 0600, since it describes financial rows):

- `created[]` — the ids and memos of rows the import inserted
- `updated[]` — the id and complete prior row state of every row it overwrote

```bash
npm run db:import -- --rollback invoices.csv.snapshot.json
```

The transaction rollback covers a *failed* import. This snapshot covers a
*successful* one that turned out to be wrong, which is the case operators
actually ask about. Restoring a row writes back every prior column, so an
update is undone to exactly its previous value, and a created row is deleted.

## Remediation

The report's `fix:` line under each error is the intended action:

| Error | Fix |
| --- | --- |
| `plain decimal number` | `1250.50`, not `1,250.50` — quote it if a CSV needs a separator |
| `assetIssuer is required` | Add the issuer, or use `XLM` |
| `must not carry an issuer` | Drop `assetIssuer`; `XLM` is the native asset |
| `duplicate: already defined on row N` | Remove one row, or give the second a different id |
| `terms are not editable by import` | Reconcile against the stored invoice; the ledger wins |
| `already PAID` | Exclude the row — it has settled |
| `valid email address` | Fix or blank the column |

A file-level failure (bad header, unknown column, unparseable JSON) is reported
before any row is examined, because no row in the file can be trusted until the
shape of the file is.

## Notes and limits

- **Postgres only.** The importer writes SQL; the in-memory MVP backend has no
  equivalent and does not need one.
- **Invoices only.** Transactions and payment events are not importable, for
  the same evidence reason that `status` and `paymentTxHash` are not.
- **Memos.** A row without a `memo` gets a server-generated one at apply time.
  It is written to the snapshot, so a rollback knows what to remove.
- **No `externalId` in the API.** `POST /invoices` still generates its own memo;
  the column is nullable and only imports populate it.

Related: [MIGRATIONS.md](MIGRATIONS.md), [RESTORE_VALIDATION.md](RESTORE_VALIDATION.md),
[DATA_RETENTION.md](DATA_RETENTION.md), [API_CONTRACTS.md](API_CONTRACTS.md)
