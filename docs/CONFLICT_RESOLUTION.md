# Deterministic Conflict Resolver for Multi-Client Edits (#284)

## Overview & Goal
In multi-device, multi-tab, or offline-queued environments, concurrent updates to an invoice can cause race conditions and version divergences. The Deterministic Conflict Resolver provides a 3-way merge engine that merges non-overlapping field edits cleanly, detects direct collisions, enforces strict immutability on financial settlement parameters, and resolves collisions using deterministic tie-breaking strategies.

---

## 3-Way Merge Architecture

The resolver evaluates three states:
1. **$V_{base}$ (Base Version)**: The invoice snapshot observed by the client when the edit session began.
2. **$V_{server}$ (Server Truth)**: The live authoritative invoice state currently stored in backend storage.
3. **$V_{client}$ (Client Edit)**: The incoming patch/update payload submitted by the client.

```
       [Base Version V_base]
            /        \
           /          \
 [Server Truth V_server]  [Client Edit V_client]
           \          /
            \        /
    [Deterministic 3-Way Merge]
                 |
      [Merged Invoice V_new]
```

### Field Classification

| Category | Fields | Behavior on Edit |
|---|---|---|
| **Immutable Financial & Settlement** | `id`, `amount`, `assetCode`, `assetIssuer`, `memo`, `sellerPublicKey`, `paymentTxHash`, `payerPublicKey`, `paidAt` | Strictly immutable. Any attempt to modify raises `ImmutableFieldConflictError` (HTTP 400). |
| **Terminal Status** | Invoices where `status` is `PAID`, `CANCELLED`, or `EXPIRED` | Strictly read-only. Edits rejected with `TerminalStatusConflictError` (HTTP 409). |
| **Editable Metadata & Details** | `description`, `customerName`, `customerEmail`, `sellerName`, `sellerEmail`, `metadata`, `expiresAt` | Evaluated field-by-field via 3-way merge. |

---

## Resolution Strategies

1. **`AUTO_MERGE` (Default)**:
   - Non-overlapping edits to distinct fields merge cleanly without data loss.
   - Convergent identical edits adopt the shared value.
   - Collisions on scalar fields are resolved deterministically:
     - The higher timestamp wins (`clientTimestamp > serverTimestamp`).
     - If timestamps match, tie-breaks deterministically using actor ID.
   - Collisions on JSON `metadata` objects trigger recursive subkey merging.
2. **`SERVER_WINS`**:
   - Preserves authoritative server truth on field collisions.
3. **`CLIENT_WINS`**:
   - Overwrites colliding fields with client payload (requires authorized role).
4. **`STRICT`**:
   - Rejects any direct collision, returning an unresolvable conflict report with field-by-field diffs for manual operator intervention.

---

## Operational Edge Cases & Recovery / Rollback Behavior

| Operational Scenario | Failure Mode / Behavior | Recovery & Rollback Path |
|---|---|---|
| **Concurrent invoice payment during edit** | Server status transitions to `PAID` while client was editing description. | Resolver rejects edit with `TerminalStatusConflictError`. Client operation queue discards edit and reloads payment receipt. |
| **Nested metadata collision in strict mode** | Both sessions concurrently altered conflicting subkeys in `metadata`. | Resolver returns `resolved: false` with detailed `unresolvedFields`. The client UI displays a side-by-side conflict dialog. |
| **Tampered financial fields** | Client script attempts to alter `amount` or `assetCode`. | Fails immediately with `ImmutableFieldConflictError`. Transaction aborted, audit event recorded. |
| **Unauthorized role edit** | Actor possessing only `VIEWER` role submits an edit payload. | Rejected with `UnauthorizedEditError` (HTTP 403). No state change occurs. |
| **Optimistic write race during persistence** | Server version increments again between merge calculation and DB commit. | Handler retries the 3-way merge against the newly incremented server version up to 3 times before failing closed. |

---

## Complexity Analysis
- **Time Complexity**: $O(F)$ where $F$ is the number of edited fields ($O(1)$ amortized lookups via Set/Map).
- **Space Complexity**: $O(F)$ to construct the merged result and resolution report.
