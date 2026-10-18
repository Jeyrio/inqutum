# Versioned event replay for projections (#290)

Module: [`backend/src/ops/projection-replay.ts`](../backend/src/ops/projection-replay.ts).

The stale-projection repair (#269) copies the search index from storage.
Replay instead rebuilds it from the audit trail. That proves the event log can
reproduce the projection; a log that cannot is reported, never swapped in.

## Endpoints (admin, `Authorization: Bearer $JOBS_ADMIN_TOKEN`)

| Request | Result |
|---------|--------|
| `POST /api/ops/projections/search-index/replay` `{}` | Dry run (default): `200` with the report. The live index is untouched. |
| `… /replay` `{ "dryRun": false }` | `200` with outcome `applied`, or `409 REPLAY_REFUSED` with the report and its reasons. |
| `… /replay` `{ "projectorVersion": 1 }` | Pins the projector version. An unknown version returns `400 INVALID_PROJECTOR_VERSION`. |
| `POST /api/ops/projections/search-index/rollback` | Restores the index the last applied replay replaced. `409 NOTHING_TO_ROLL_BACK` if there is none. |

- A replay while another one runs returns `409 REPLAY_IN_PROGRESS`.
- Applies and rollbacks are written to the audit trail as `MAINTAINER_ACTION`.

## How a replay runs

1. **Snapshot.** Take the events oldest first and verify each hash and each link to the previous event.
2. **Fold.** Run the events through projector **v1** into a fresh shadow index. v1 handles `INVOICE_CREATED`, `INVOICE_CANCELLED`, `INVOICE_EXPIRED`, `PAYMENT_VERIFIED` and `PAYMENT_SIMULATED`, using the invoice in `afterState`. Other actions are counted as `skipped`. A payload that is not a full invoice is counted as `rejected`.
3. **Carry over non-event state.** Copy visibility from the live index, because operators set it and no event records it. Overlay lazy expiry from storage (`derivedExpiries`), because expiry is applied on read and never recorded as an event.
4. **Verify.** Compare the shadow with storage using the #269 detector.
5. **Swap.** Replace the live index in one synchronous step, keeping the previous index for one rollback.

The swap is refused when any of these hold:

- the hash chain is broken;
- history was truncated (the in-memory audit store keeps the newest 5,000 events);
- an event was rejected;
- the shadow disagrees with storage.

## Versioning

Projector versions are immutable. Changing how events map to records means
adding version 2 to `SEARCH_INDEX_PROJECTORS`, which becomes the default, while
v1 remains selectable to reproduce earlier reports. Every report names the
version that produced it.

## Operational edge cases and recovery

| Report says | Cause | Recovery |
|-------------|-------|----------|
| `truncated` | Events older than the audit buffer were evicted, or the process restarted | Use `POST /api/ops/stale-projections/repair` (rebuild from storage). |
| `MISSING_PROJECTION` anomalies | Invoices with no events, e.g. created by `db:import` | Same: repair from storage. |
| `brokenAt: <id>` | An audit event was altered | Investigate as tampering; do not repair blindly. |
| `REPLAY_IN_PROGRESS` | Concurrent request | Retry after the first finishes. |
| Bad index after an apply | — | `POST …/rollback` (one step). |

- **Retry:** every run builds a fresh shadow, so retrying is always safe.
- **Concurrent writes:** a write that lands between verification and the swap is caught by the next #269 detection.
- **Rollback scope:** it is held in process memory and lost on restart. The projection can always be rebuilt again from storage.

## Contract and migration

- Two new admin routes are declared in `API_CONTRACT` and `API_CONTRACTS.md`.
- `MemoryAuditStore.listChronological()`, `hashEvent` (now exported), and `PermissionAwareSearchIndex.exportRecords()` / `replaceAll()` are additive.
- No schema change. Roll back by reverting the commit.
