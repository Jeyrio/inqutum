# Stale-Cache & Stale-Index Detection with Automated Repair Recommendations

## Context & Architecture
In Inqutum, search indexing (`PermissionAwareSearchIndex`), seller dashboards, and aggregate statistics rely on asynchronous and in-memory read projections derived from the primary invoice database. Under network partitions, unhandled worker crashes, or high concurrency, projections can drift from storage truth.

The **Stale Projection Detection & Repair Service** (Issue #269) introduces active drift discovery, severity scoping, automated operator repair recommendations, and dual-mode reconciliation.

## Drift Classification & Severity Model

1. **Status Drift (`STATUS_DRIFT`)**:
   - Storage marks an invoice `PAID`, `EXPIRED`, or `CANCELLED`, but projection still displays `PENDING`.
   - **Severity**: `CRITICAL` when an invoice is settled in storage but shows pending in projections, risking duplicate payments.
2. **Missing Projections (`MISSING_PROJECTION`)**:
   - Stored invoice exists in database but was never indexed into search.
   - **Severity**: `CRITICAL` for paid invoices; `WARNING` for pending invoices.
3. **Orphaned Projections (`ORPHANED_PROJECTION`)**:
   - Search index retains an entry whose source record was deleted or pruned.
   - **Severity**: `WARNING`.
4. **Attribute Mismatch (`ATTRIBUTE_MISMATCH`)**:
   - Currency code, amount, or memo divergence between storage and read projections.
   - **Severity**: `WARNING`.

## Operator Recommendations & Repair Actions

The service analyzes anomaly counts and assigns automated repair recommendations:
- **`IMMEDIATE_REPAIR`**: Applied when anomaly count < 100. In-memory projections are updated immediately in-line.
- **`REBUILD_PROJECTION`**: Recommended when structural index corruption or divergence between 100 and 500 records occurs.
- **`QUEUE_BACKGROUND_SYNC`**: Recommended when anomaly count > 500 to avoid blocking real-time HTTP request loops.

## REST Endpoints

All stale-projection endpoints are admin-authenticated via `JOBS_ADMIN_TOKEN`:

- `GET /api/ops/stale-projections/detect`: Returns full detection report with operator-visible evidence for every drifted record.
- `POST /api/ops/stale-projections/repair`: Executes repair in `{ mode: 'immediate' | 'queued' }` and returns structured execution evidence.

## Operational Edge Cases & Failure Modes

1. **Concurrent Writes During Repair**: Repairs update only desynchronized keys and reconcile against authoritative storage locks; newly created invoices are preserved.
2. **Reversibility / Rollback**: Because projections are strictly derived views of authoritative storage records, running repairs is idempotent and 100% reversible with zero financial loss.
3. **Queue Overload**: If background reconciliation is queued, workers drain records with a concurrency limiter to prevent database connection starvation.
