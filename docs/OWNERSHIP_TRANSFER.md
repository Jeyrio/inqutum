# Safe Ownership Transfer with Pending Acceptance and Expiry (#300)

## Overview & Goal
Instantaneous single-step ownership reassignment exposes accounts and organizations to severe risks: typographical destination errors, lost key access, or social engineering immediately lead to permanent account lockout. The Safe Ownership Transfer module implements an industry-standard two-step transfer pattern with cryptographic token gating, pending acceptance, and automated time-based expiry.

---

## Transfer Handshake Lifecycle

```
[Current Owner] -- initiateTransfer() --> [Status: PENDING_ACCEPTANCE]
                                                  |
                 +--------------------------------+-------------------------------+
                 |                                |                               |
                 v (TTL Exceeded)                 v (Owner Cancels)               v (Nominee Rejects)
        [Status: EXPIRED]                [Status: CANCELLED]             [Status: REJECTED]
                 |                                |                               |
                 +--------------------------------+-------------------------------+
                                                  |
                                                  v (Nominee Accepts within TTL)
                                         [Status: ACCEPTED]
                                                  |
                                         (Atomic Role Swap:
                                          Nominee -> OWNER
                                          Original Owner -> ADMIN)
```

---

## Security Guarantees & Invariants

1. **Two-Step Authorization**:
   - Only the verified current `OWNER` can initiate or cancel an ownership transfer.
   - Only the nominated `targetOwnerId` can accept or decline the transfer.
2. **Self-Transfer Guard**:
   - Initiators cannot nominate their own address.
3. **Time-Bounded Expiration**:
   - Transfers carry an explicit `expiresAt` timestamp (default: 48 hours).
   - Once expired, acceptance calls are rejected with `OwnershipTransferExpiredError` (HTTP 410).
4. **Single Active Pending Transfer**:
   - Resources can have at most one active `PENDING_ACCEPTANCE` transfer at a time.
5. **Atomic Role Reassignment & Demotion**:
   - Upon acceptance, the nominee is promoted to `OWNER`.
   - The original owner is atomically reassigned to `ADMIN` (or configured post-transfer role), preventing orphaned accounts.

---

## Operational Edge Cases & Recovery / Rollback Behavior

| Operational Scenario | Impact / System Behavior | Recovery & Rollback Path |
|---|---|---|
| **Owner accidentally nominates wrong wallet address** | Transfer is in `PENDING_ACCEPTANCE` state. Nominee does not possess key to accept. | Current owner executes `cancelTransfer(transferId)`. State transitions to `CANCELLED`. Ownership remains uninterrupted with current owner. |
| **Nominee is unresponsive / abandons invitation** | Transfer remains pending until TTL expires. | Service evaluates expiry lazily. After 48h, transfer transitions to `EXPIRED`. Active pending slot clears, allowing owner to re-initiate. |
| **Nominee declines transfer** | Nominee calls `rejectTransfer(transferId)`. | State transitions to `REJECTED`. Owner is notified via audit trail, ownership remains unchanged. |
| **Unauthorized actor attempts acceptance** | Attacker intercepts transfer ID and attempts `acceptTransfer()`. | Rejected with `UnauthorizedAcceptorError` (HTTP 403). Transfer remains pending for genuine nominee. |
| **Database or network failure during acceptance** | Acceptance transaction fails mid-flight. | Handshake is atomic in-transaction; rolls back completely to `PENDING_ACCEPTANCE`. Nominee can safely retry acceptance. |

---

## Complexity Analysis
- **Time Complexity**: $O(1)$ for initiate, accept, cancel, reject, and lookup operations.
- **Space Complexity**: $O(T)$ where $T$ is the number of transfer records.
