# Resumable Record Repair Job for Orphaned and Inconsistent Records

Module: [`backend/src/ops/resumable-repair.service.ts`](../backend/src/ops/resumable-repair.service.ts).

After disaster recovery, database restores, or partial cascading failures, database records can become orphaned or inconsistent with respect to domain invariants defined in [`backend/src/db/restore-validation.ts`](../backend/src/db/restore-validation.ts). Running unbounded `UPDATE` queries across large production datasets causes table locks, timeouts, memory spikes, and partial state corruption if interrupted.

The **Resumable Repair Service** provides a durable, phased, keyset-paginated repair framework that checkpoints progress after every batch, enabling seamless pause, resumption, retry, and preview without reprocessing already repaired records.

---

## Architecture & Repair Phases

The repair job processes data across 5 sequential phases:

```
[1. detached_transactions]
       │
       ▼
[2. orphaned_transactions]
       │
       ▼
[3. orphaned_payment_events]
       │
       ▼
[4. inconsistent_invoices]
       │
       ▼
[5. inconsistent_jobs]
```

### Phase Details

| Phase | Failure Caught | Authoritative Repair Action | Preservation / Safety |
|---|---|---|---|
| `detached_transactions` | Transactions with valid invoice `memo` but `invoice_id IS NULL` | `UPDATE transactions SET invoice_id = matching_invoice_id` | Reconnects payments to authoritative invoices. |
| `orphaned_transactions` | Transactions referencing an `invoice_id` that no longer exists in `invoices` | Nulls `invoice_id` and records the broken reference in `metadata.orphaned_invoice_id` | **Never deletes financial transactions.** Financial audit history is preserved in JSONB metadata. |
| `orphaned_payment_events` | Payment events referencing a deleted/non-existent `invoice_id` | Nulls `invoice_id` and records the reference in `event_data.orphaned_invoice_id` | Preserves full audit event data and timeline. |
| `inconsistent_invoices` | Status contradicts `paid_at`, `payment_tx_hash`, or `version < 1` | Backfills `paid_at` from linked transaction for `PAID` invoices; clears `paid_at` on non-`PAID` invoices; backfills `payment_tx_hash`; resets `version = 1` | Restores optimistic locking and settlement coherence. |
| `inconsistent_jobs` | Stale running worker leases; terminal jobs missing `completed_at`; active jobs with premature `completed_at` | Requeues stale running jobs (`status = 'queued', locked_until = NULL`); backfills or clears `completed_at` | Restores background worker scheduler coherence. |

---

## Keyset Pagination & Checkpointing

Traditional `OFFSET/LIMIT` pagination suffers from $O(N^2)$ tuple scanning and page drifting when rows are updated.

The repair engine utilizes **keyset cursor pagination** on sorted primary keys:

```sql
WHERE ($1::text IS NULL OR id::text > $1::text)
ORDER BY id ASC
LIMIT $2
```

### Checkpoint Lifecycle

```
[pending] ──start──▶ [running] ──batches finished──▶ [completed]
                         │
                         ├── maxBatches reached / worker interrupt ──▶ [paused]
                         │                                               │
                         │                                          resumeRepairJob
                         │                                               │
                         │◀──────────────────────────────────────────────┘
                         │
                         └── fatal query exception ──▶ [failed]
```

- A checkpoint row is persisted in `record_repair_checkpoints` after every executed batch.
- Each checkpoint stores:
  - `jobId`: unique repair execution identifier (`repair_<uuid>`).
  - `status`: `'pending' | 'running' | 'paused' | 'completed' | 'failed'`.
  - `phase`: current active phase in the repair sequence.
  - `cursor`: highest record ID successfully evaluated in the current phase.
  - `batchSize`: configured batch chunk size (default: 100).
  - `dryRun`: boolean flag indicating preview mode vs. live apply mode.
  - `scannedCount`, `repairedCount`, `skippedCount`, `failedCount`.
  - `errors`: structured log of errors encountered during execution.
  - `actionLog`: audit trail of repair mutations planned or executed.

---

## Execution Paths

### 1. Normal Path
- Operator or system initiates repair via `POST /api/ops/repair-records/jobs` or background job worker.
- Progresses sequentially through all 5 phases until all records are processed.
- Final state transitions to `completed` with full execution counts and duration.

### 2. Dry-Run Path
- When `dryRun: true` is passed, the engine runs identical scan queries and determines required mutations.
- Records planned repairs into `actionLog` and report counts, but executes **zero** SQL `UPDATE` statements against the database.
- Safe to run on live production instances to inspect drift before applying changes.

### 3. Failure & Error Recovery Path
- **Record-level failures:** If an individual row update triggers a constraint error, the error is recorded in `checkpoint.errors`, `failedCount` is incremented, and the remaining records in the batch continue processing.
- **Scan-level failures:** If database connectivity or syntax errors interrupt a query, the job transitions to `failed` and saves the cursor up to the last successful batch.
- Resuming the job continues from the exact saved cursor without re-evaluating completed records.

### 4. Retry & Worker Queue Path
- Registered in the background worker framework under `RESUMABLE_REPAIR_JOB = 'records.resumable-repair'`.
- If an unhandled process termination or worker timeout occurs, worker retry policies invoke `resumeRepairJob(jobId)`.

### 5. Authorization Path
- All ops endpoints (`/api/ops/repair-records/*`) are protected by `requireAdmin(options.adminToken)`.
- Requests missing a valid `Bearer <JOBS_ADMIN_TOKEN>` are rejected with HTTP 401/403.
- Every repair start and resume action writes a `MAINTAINER_ACTION` audit record into `auditStore`.

---

## HTTP Ops API Reference

### Start Repair Job
```http
POST /api/ops/repair-records/jobs
Authorization: Bearer <JOBS_ADMIN_TOKEN>
Content-Type: application/json

{
  "dryRun": false,
  "batchSize": 100,
  "phases": ["detached_transactions", "orphaned_transactions"],
  "maxBatches": 10
}
```

Response (`201 Created`):
```json
{
  "success": true,
  "data": {
    "jobId": "repair_9c82b143-a602-4fc7-bf84-88457c126d40",
    "status": "completed",
    "dryRun": false,
    "startedAt": "2026-10-17T23:00:00.000Z",
    "completedAt": "2026-10-17T23:00:01.250Z",
    "durationMs": 1250,
    "currentPhase": "orphaned_transactions",
    "cursor": "tx_fa91...",
    "counts": {
      "scanned": 150,
      "repaired": 150,
      "skipped": 0,
      "failed": 0
    },
    "errors": [],
    "actionLogSample": []
  },
  "correlationId": "req_84920..."
}
```

### Resume Repair Job
```http
POST /api/ops/repair-records/jobs/:id/resume
Authorization: Bearer <JOBS_ADMIN_TOKEN>
Content-Type: application/json

{
  "batchSize": 50,
  "maxBatches": 20
}
```

### Inspect Job Status
```http
GET /api/ops/repair-records/jobs/:id
Authorization: Bearer <JOBS_ADMIN_TOKEN>
```

### List Repair Jobs
```http
GET /api/ops/repair-records/jobs?status=paused&limit=10
Authorization: Bearer <JOBS_ADMIN_TOKEN>
```

---

## Operational Edge Cases & Recovery

### Concurrent Modifications
If a record being scanned by the repair job is concurrently modified or paid by user traffic:
- Keyset ordering ensures monotonically ascending traversal by primary key (`id > $cursor`).
- Updates are strictly targeted by primary key and matching expected invariant condition (e.g., `WHERE id = $1 AND invoice_id IS NULL`), preventing lost updates.

### Preserving Financial Truth
- Transactions are **never deleted**. When a transaction's parent invoice is missing, the transaction is detached by setting `invoice_id = NULL` and storing the former ID in `metadata.orphaned_invoice_id`.
- Payment events similarly preserve former parent references in `event_data.orphaned_invoice_id`.

### Rollback Procedure
1. **Always preview first:** Run with `dryRun: true` to confirm the set of affected rows.
2. **Reversing re-linked transactions:** Detached transactions re-linked to invoices can be re-evaluated via the `actionLog` in `record_repair_checkpoints`.
3. **Reversing isolated references:** If an invoice was restored after transactions/events were isolated, re-run the `detached_transactions` phase or restore foreign references using `metadata->>'orphaned_invoice_id'`.
4. **Point-in-Time Recovery:** For catastrophic production failures, use pre-repair database snapshots.

---

## Database Schema & Migrations

The repair job introduces the additive table `record_repair_checkpoints` in [`db/schema.sql`](../db/schema.sql):

```sql
CREATE TABLE IF NOT EXISTS record_repair_checkpoints (
  id VARCHAR(64) PRIMARY KEY,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
  phase VARCHAR(50) NOT NULL,
  cursor TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  batch_size INTEGER NOT NULL DEFAULT 100,
  phases JSONB NOT NULL DEFAULT '[]'::jsonb,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_repair_checkpoints_status
  ON record_repair_checkpoints(status, updated_at DESC);
```

- **Backward Compatibility:** Completely non-breaking; all existing tables, foreign keys, and indexes remain unchanged.
- **Rollback:** `DROP TABLE IF EXISTS record_repair_checkpoints;`.
