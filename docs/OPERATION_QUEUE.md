# Conflict-Aware Offline and Multi-Tab Operation Queue (#265)

## Overview
Inqutum provides a resilient, conflict-aware operation queue designed for distributed browser clients, offline operation, and multi-tab workflows. When sellers create, update, or cancel invoices in high-latency or intermittent connectivity environments, queued work persists locally and synchronizes across active tabs without race conditions or silent overwrites.

## Key Invariants
1. **Durable Persistence Across Disconnects**:
   - Queued operations serialize to local storage (`inqutum_operation_queue_v1`).
   - Mutations in flight survive unexpected tab crashes, browser restarts, or network disruptions.
2. **Optimistic Version & Concurrency Protection**:
   - Every mutation records its `baseVersion` and `baseStatus`.
   - Before executing against authoritative storage truth, the queue verifies that the server-side version has not drifted.
   - If a concurrent actor or background reconciliation job modified the entity, a `VERSION_MISMATCH` conflict is flagged.
3. **Terminal State Immutability**:
   - Once an invoice enters a terminal state (`PAID`, `CANCELLED`, `EXPIRED`), conflicting pending mutations are blocked and categorized with `TERMINAL_STATUS_CONFLICT`.
4. **Multi-Tab Cross-Synchronization**:
   - Active tabs coordinate over a dedicated `BroadcastChannel` (`inqutum_operation_queue_sync`).
   - Mutations in Tab A immediately notify Tab B, preventing duplicate execution and providing real-time UI synchronization.

## Deterministic Conflict Resolution Choices
When a conflict is detected, the operation transitions to `CONFLICT` status with structured diagnostic details (`expected` vs `actual` state). The operator or UI is presented with deterministic, non-destructive resolution actions:

| Action | Behavior | Invariant Guarantee |
|---|---|---|
| `RETRY_WITH_LATEST` | Re-anchors the operation's `baseVersion` and `baseStatus` to match the latest authoritative state and transitions to `QUEUED`. | Prevents stale replay; re-evaluates business constraints before execution. |
| `DISCARD` | Marks the operation as `DISCARDED` and detaches it from the active processing pipeline. | User-confirmed drop of stale intent; zero side-effects. |
| `FORCE_APPLY` | Re-queues the operation with the latest target version to attempt forced overwrite (when permitted by seller policy). | Explicit operator override; maintains audit record of intent. |

## Operational Edge Cases & Failure Modes

### 1. Network Disconnect During In-Flight Execution
- **Symptom**: An operation is marked `IN_FLIGHT` when the user closes the tab or loses connection.
- **Handling**: Upon next reload or reconnect, the queue restores `IN_FLIGHT` operations back to `QUEUED` status and re-evaluates conflict preconditions against authoritative storage truth.

### 2. Multi-Tab Split-Brain Mutation
- **Symptom**: User has the same invoice open in Tab 1 and Tab 2. Tab 1 cancels the invoice while Tab 2 submits an amount update.
- **Handling**: Tab 1's cancellation commits first, transitioning the invoice to `CANCELLED` and advancing its version. When Tab 2 attempts execution, `evaluateConflict` flags `TERMINAL_STATUS_CONFLICT`. Tab 2's executor aborts without mutating storage.

### 3. Exhausted Retries on Transient Failures
- **Symptom**: Network or downstream service is intermittently unavailable.
- **Handling**: Each operation tracks its retry count. After `maxRetries` (default: 3), status transitions to `FAILED` with explicit error logging, alerting the operator for manual remediation or retry.

## Rollback & Recovery Procedures
- **Rollback Conflicted Operations**: Call `queue.resolveConflict(opId, 'DISCARD')` to safely discard queued operations without mutating database state.
- **Emergency Queue Purge**: Call `queue.clearCompleted()` or clear the local storage key `inqutum_operation_queue_v1` to reset client state to storage truth.
