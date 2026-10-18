# State Invariant Checks Architecture (#280)

## Overview

The State Invariant Verification Engine (`backend/src/domain/state-invariants.ts`) enforces strict mathematical and security invariants across all balance, ownership, and entitlement state transitions in Inqutum. This guarantees data integrity, prevents double-spending, and enforces zero-trust authority boundaries.

## Invariant Categories

### 1. Balance Transitions
- **Conservation of Value**: In any internal transfer or payment settlement, total debited funds must strictly equal credited funds plus collected fees:
  $$\Delta \text{Balance}_{\text{source}} = \Delta \text{Balance}_{\text{dest}} + \text{Fee}$$
- **Minimum Reserve Protection**: Account balances cannot be drawn below required network reserves.
- **Precision Integrity**: Enforces 64-bit integer stroop representation (1 XLM = 10,000,000 stroops). Float or sub-stroop precision is rejected.
- **Settlement Completeness**: An invoice cannot transition to `PAID` unless recorded settled stroops $\ge$ invoice required stroops.

### 2. Ownership Transitions
- **Two-Step Handshake Protocol**: Current owner initiates nomination; nominated target must explicitly accept.
- **Single Active Owner**: Every managed entity has exactly one primary owner.
- **Self-Transfer Prohibition**: Initiator cannot nominate themselves as target owner.
- **TTL Expiry Enforced**: Unclaimed transfers expire automatically after a specified duration.
- **Unauthorized Interception Protection**: Non-nominated actors cannot accept or decline pending ownership transfers.

### 3. Entitlement & Privilege Transitions
- **Tenant Isolation**: Cross-tenant privilege delegation is blocked.
- **Privilege Ceiling**: No actor can grant a role higher than their own hierarchy tier (`SUPER_ADMIN` > `OWNER` > `ADMIN` > `COLLABORATOR` > `VIEWER`).
- **Self-Elevation Guard**: Callers cannot self-elevate permissions.

### 4. Lifecycle State Monotonicity
- Terminal states (`PAID`, `EXPIRED`, `CANCELLED`) are irreversible.
- Re-application of the same terminal state is handled idempotently without error.

## Paths Verified

| Path | Behavior |
|------|----------|
| **Normal Path** | Valid transfers, authorized role assignments, and monotonic status progressions execute cleanly. |
| **Failure Path** | Violations throw `InvariantViolationError` with specific error codes (`CONSERVATION_OF_VALUE_VIOLATED`, `PRIVILEGE_ESCALATION_FORBIDDEN`, `UNDERPAYMENT_SETTLEMENT_REJECTED`). |
| **Retry Path** | Idempotent duplicate transitions succeed safely without state corruption. |
| **Authorization Path** | Unprivileged actors and spoofed acceptor attempts are blocked with HTTP 403. |
