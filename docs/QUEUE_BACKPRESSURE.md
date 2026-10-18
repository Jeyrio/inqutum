# Bounded Queue Backpressure Architecture (#275)

## Overview

The Bounded Queue Backpressure engine protects Inqutum's asynchronous background pipeline from memory bloat, thread starvation, and runaway worker saturation caused by burst workloads (such as bulk invoice imports, automated ledger sweeps, batch CSV exports, and cryptographic evidence verification).

## Key Components

1. **BackpressureController (`backend/src/jobs/backpressure.ts`)**:
   - Maintains real-time tracking of queue depth and workload computational costs.
   - Enforces watermark hysteresis:
     - **High Watermark (default 80%)**: Triggers `DEGRADED` state; sheds low and normal priority background jobs with HTTP 429 semantics.
     - **Low Watermark (default 50%)**: Restores `NORMAL` state, preventing rapid oscillation/thrashing around thresholds.
     - **Hard Capacity Limit (default 100%)**: Rejects non-emergency admissions.
     - **Emergency Buffer (up to 120%)**: Reserved exclusively for critical settlement, ledger rollbacks, and authorized maintainer operations.

2. **Workload Cost Weighting**:
   - Differentiates compute/IO footprint across distinct background job types:
     - `invoices.expire-pending`: 1 unit
     - `notifications.email`: 2 units
     - `webhooks.delivery`: 3 units
     - `crypto.evidence-verification`: 8 units
     - `reports.csv-export`: 10 units
     - `invoices.bulk-import`: 15 units
     - `reconciliation.ledger-sweep`: 20 units

3. **BoundedBackpressureQueue**:
   - Thin drop-in wrapper around `JobQueue` checking active store depth prior to enqueue.
   - Preserves existing `JobStore` and `JobWorker` interfaces without breaking changes.

## Acceptance Paths Covered

| Path | Behavior |
|------|----------|
| **Normal Path** | Jobs below high watermark are admitted immediately with accurate cost tracking. |
| **Failure Path** | Saturated queue rejects with `QueueBackpressureError` (HTTP 429), specifying `retryAfterMs` and reason. |
| **Retry Path** | Exponential backoff delay with randomized jitter; hysteresis state avoids flapping during queue drainage. |
| **Authorization Path** | `CRITICAL` priority jobs and `MAINTAINER` / `OWNER` / `SYSTEM` roles bypass standard backpressure into reserved emergency headroom. |

## Operational Edge Cases & Recovery

- **Worker Stall / Queue Spike**: If workers stall and active depth reaches 100%, external enqueues fail fast. Workers continue processing without OOM crash.
- **Hysteresis Recovery**: As workers drain the backlog below the low watermark (50%), the controller automatically re-opens admission.
- **Deadlock Avoidance**: Critical system maintenance jobs are guaranteed admission within emergency headroom (up to 120%), ensuring the system can heal itself even under total load saturation.
