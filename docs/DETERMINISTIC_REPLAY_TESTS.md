# Deterministic Replay Tests for Concurrent Writes and Retries (#274)

## Overview

The Deterministic Replay Engine (`backend/src/concurrency/deterministic-replay-engine.ts`) provides a reproducible testing harness for high-concurrency races, optimistic concurrency version conflicts, network failures, and duplicate retry requests in Inqutum.

## Key Capabilities

1. **Seeded PRNG Scheduling (Mulberry32)**:
   - High concurrency race conditions are notoriously non-deterministic when driven by standard thread schedulers. By driving the execution sequence and simulated network timing with a seeded PRNG, any race scenario can be reproduced bit-for-bit simply by supplying the identical seed.

2. **Optimistic Concurrency Control (OCC)**:
   - Evaluates version-matching constraints (`expectedVersion === actualVersion`).
   - Conflicting concurrent edits are flagged with deterministic conflict traces, ensuring that data is never silently overwritten.

3. **Idempotency & Retry Defense**:
   - Maintains an idempotency key journal.
   - Retried requests following network drops or timeouts produce `IDEMPOTENT_HIT` responses and preserve state convergence without duplicate executions.

4. **Zero-Trust Authorization Under Concurrency Races**:
   - Unauthorized write attempts interleaved in concurrent batches are rejected immediately with `UNAUTHORIZED`, guaranteeing they cannot corrupt or modify state even when racing with legitimate operations.

## Paths Verified

| Path | Behavior |
|------|----------|
| **Normal Path** | Concurrent operations from valid roles execute in deterministic interleaved order and produce identical convergence under the same seed. |
| **Failure Path** | Stale-version concurrent writes encounter `CONFLICT` steps and fail safely. |
| **Retry Path** | Dropped connections (`NETWORK_ERROR`) retried with identical `idempotencyKey` are recognized and returned without side-effect duplication. |
| **Authorization Path** | Concurrent unauthorized mutation requests are rejected without modifying resource state. |
