# Safe cancellation of imports and exports (#288)

A cancelled run must never leave half a result: an import is either fully
committed or fully rolled back, and an export either stores a complete artifact
or none.

## Imports

`applyImport(db, plan, { signal })` and `rollbackImport(db, snapshot, signal)`
check the `AbortSignal` at these points:

1. before a connection is taken, so a run cancelled before it starts never connects;
2. before every row;
3. once more before `COMMIT`.

On abort the transaction is rolled back, the connection is released and
`ImportCancelledError` is thrown. An abort that arrives **after** `COMMIT` is
ignored: the rows have landed, and the caller still receives the snapshot,
which is the only undo.

CLI (`npm run db:import`):

| Event | Result |
|-------|--------|
| First `Ctrl-C` / `SIGTERM` | Cancels at the next row boundary, rolls back, exits `130`. |
| Second `Ctrl-C` | Exits immediately. PostgreSQL aborts the open transaction when its backend sees the connection is gone: at once if it is waiting for the next command, or after the running statement otherwise. |
| Signal after `COMMIT` | Ignored. The snapshot file is still written, and the command reports success. |

## Exports

`POST /api/exports` passes an `AbortSignal` to `ExportService.create`, which
checks it between storage pages. The signal fires when:

- **the client disconnects** (the response emits `close` before it was written): generation stops, nothing is stored or audited, and no response is sent;
- **the deadline passes** (`timeoutMs`, default 30 s): `503 EXPORT_TIMED_OUT` with `retryable: true`.

The artifact is stored only after the last page, so a cancelled export leaves
nothing to clean up.

## Retry and authorization

- **Retry:** re-run the same import plan or re-send the same export request. Neither cancellation path leaves state behind that a retry would collide with.
- **Authorization:** an export for another wallet is refused with `403` before any work starts, so there is nothing to cancel. Import cancellation is local to the process that holds the database credentials.

## Operational edge cases

- A cancel arriving while a row's SQL statement is running takes effect when that statement returns. Statements are single-row, so the delay is bounded.
- Very large exports should narrow `from` / `to` instead of raising the deadline. `truncated: true` still marks a capped export.

## Contract and migration

- `ApplyOptions.signal` and the `rollbackImport(…, signal)` argument are optional.
- `POST /api/exports` adds `503` (documented in `API_CONTRACT`).
- No schema change. Roll back by reverting the commit.
