# Migration safety

`npm run db:migrate` applies [`db/schema.sql`](../../db/schema.sql). Because the
schema is also the convergence target for older databases (it contains
`ADD COLUMN IF NOT EXISTS`, `DROP COLUMN IF EXISTS` and a data backfill), running
it is not always a no-op — it can drop objects and rewrite rows on a production
database. This document covers how to preview that, verify it, and recover.

## 1. Preview before writing (dry-run)

```bash
cd backend
npm run db:migrate -- --dry-run
```

Issues only `SELECT`s and prints:

- how many actions the schema plans,
- which objects **already exist** and will be skipped,
- which objects **would be created**,
- which actions are **destructive** (`DROP TABLE ... CASCADE`, `DROP COLUMN`),
- **affected record counts** for every data-rewriting statement,
- **rollback / forward-fix notes** for each risky action.

The exit code is 0 and nothing is written. Use this before any production run.

## 2. Apply and verify

```bash
npm run db:migrate
```

The runner now prints the same preview, applies the schema, then runs
**post-checks** against the live database. It exits non-zero when any check
fails, so a partial rollout cannot be mistaken for success.

Post-checks assert that every table, view, index and added column the schema
declares actually exists, and that the `expires_at` backfill left no NULL rows
behind. Failures name the specific object:

```
FAIL  table jobs exists — missing after migration
FAIL  invoice.invoices has no NULL expires_at rows — 42 row(s) still NULL
```

## 3. What is destructive in the current schema

| Statement | Risk | Recovery |
| --- | --- | --- |
| `ALTER TABLE invoices DROP COLUMN IF EXISTS user_id` | Column data lost | Not recoverable from the schema. Re-add the column with its original type; values must come from a dump. |
| `DROP TABLE IF EXISTS users CASCADE` | Removes the legacy users table **and every object depending on it** | Restore from a pre-migration `pg_dump`, or re-create and repopulate. |
| `UPDATE invoices SET expires_at = ... WHERE expires_at IS NULL` | Rewrites rows in place | Restore the affected column from a dump. |

Always take a dump first:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=pre-migrate-$(date +%Y%m%dT%H%M%S).dump
```

## 4. Rollback and forward-fix

The schema is written to be **idempotent**, so the usual forward fix is to fix
the cause and re-run:

1. **Re-run after fixing the DDL.** `CREATE ... IF NOT EXISTS` and
   `ADD COLUMN IF NOT EXISTS` mean a corrected schema converges on the next run
   without manual cleanup.
2. **Partial failure (some objects missing).** Read the failing check names,
   correct `db/schema.sql`, then re-run `npm run db:migrate`. Nothing needs to be
   undone by hand.
3. **Rolled back the wrong way (data already dropped).** Restore from the dump:

   ```bash
   pg_restore --clean --if-exists --dbname "$DATABASE_URL" pre-migrate-<timestamp>.dump
   npm run db:migrate -- --dry-run   # confirm the plan is now a no-op
   ```

4. **Only want the preview in automation?** Use `--dry-run`; it is safe on
   production and performs no writes.

## 5. Adding a new migration

1. Append the change to `db/schema.sql`, keeping the `IF NOT EXISTS` /
   `IF EXISTS` guards so the file stays re-runnable.
2. Add a post-check expectation if the change introduces a new object the
   framework should verify (tables, views, indexes, columns are picked up
   automatically from the parsed plan).
3. Run `npm run db:migrate -- --dry-run` locally and read the affected-record
   counts.
4. Run it against staging, confirm the post-checks pass, then production.

Related: [`docs/SCHEMA_VERSIONING.md`](SCHEMA_VERSIONING.md) ·
[`docs/RUNBOOK.md`](RUNBOOK.md) · [`docs/CONCURRENCY.md`](CONCURRENCY.md)
