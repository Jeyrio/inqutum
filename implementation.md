# Implementation Specification & Architecture: Issues #18, #10, #9, #20

This document outlines the technical design, threat models, time and space complexity, and step-by-step implementation for issues #18, #10, #9, and #20 in `Parcel-Protocol/inqutum`.

---

## Issue #18: Preventing Double-Processing when Marking an Invoice PAID Concurrently

### 1. Problem Statement & Root Cause
When marking an invoice `PAID`, a state transition race condition can occur if two verification requests for the same invoice execute concurrently (e.g. user page refresh + wallet extension completion callback). In async environments (or Node event loop yields during Horizon fetch), both requests can read the invoice as `PENDING`, perform on-chain verification, and attempt to write the `PAID` state.

Without atomic guards:
- A second concurrent request could overwrite the `payment_tx_hash`, `paid_at`, or `payer_name/email`.
- One-time side effects (audit log, email delivery, proof generation, notifications) would execute twice.

### 2. Architectural Design & Concurrency Strategy

#### PostgreSQL Path (Atomic Conditional UPDATE)
We execute a strict, single-statement atomic transition using `UPDATE`:
```sql
UPDATE invoices
SET status = 'PAID',
    payment_tx_hash = $2,
    payer_public_key = $3,
    paid_at = NOW(),
    payer_name = $4,
    payer_email = $5,
    version = version + 1
WHERE id = $1
  AND status = 'PENDING'
  AND expires_at > NOW()
RETURNING *;
```
- **Atomicity Guard**: Postgres acquires a row-level write lock (`X` lock) during the `UPDATE`. Exactly one concurrent transaction succeeds in updating `status` from `'PENDING'` to `'PAID'` (returning 1 row). The second transaction finds `status = 'PAID'` (or affected row count `0`) and fails.
- **Side-Effect Gating**: Side effects (audit events, email notifications) execute **only** when `UPDATE` returns a modified row.

#### In-Memory (MVP) Path (Keyed Mutex Lock)
Even in a single-threaded Node.js process, `await stellar.getTransaction(...)` yields execution to the event loop. To prevent interleaving across async verification calls for the same invoice ID:
- An in-memory keyed `InvoiceLockManager` standardizes an async mutex per `invoiceId`.
- **Lock Acquisition**: `const release = await lockManager.acquire(invoiceId);` before verification.
- **Lock Release**: Guaranteed via `finally { release(); }`.
- **State Check**: Post-lock acquisition, re-verifying `invoice.status === 'PENDING'` ensures idempotent rejection if a concurrent request completed during lock acquisition or Horizon fetch.

### 3. Complexity Analysis
- **Time Complexity**:
  - Postgres: $O(1)$ row lookup & update via Primary Key index on `invoices.id`.
  - In-Memory: $O(1)$ Map lookup for invoice lock queue.
- **Space Complexity**:
  - $O(K)$ space where $K$ is the number of active concurrent locks (automatically cleaned up when queues empty).

---

## Issue #10: Unify Verification Logic into a Single Shared Module Across Call Sites

### 1. Architectural Audit & Current State
An audit of payment verification across the codebase reveals:
1. `backend/src/services/payment-verification.ts`: The primary server verification core (`verifyHorizonPayment`).
2. `backend/src/services/stellar.service.ts`: Delegates `verifyPayment` directly to `payment-verification.ts`.
3. `backend/src/routes/invoice.handlers.ts`: Imports and invokes `verifyHorizonPayment` and `checkTxHash` directly.
4. `frontend/lib/verification.js`: Client mirror for fast pre-checks and shared recovery guidance.

### 2. Isomorphic Core Architecture
To ensure zero divergence across Node.js and browser environments:
- **Separation of Concerns**: Pure validation rules (`txHash`, `payerInfo`, `memo`, `destination`, `amount`, `asset`, `network`) depend only on standard JS types/utilities without server-only DB adapters or heavy Node modules.
- **Shared Module**: `frontend/lib/verification.js` acts as an isomorphic pure JS mirror sharing exact verification error codes (`VERIFICATION_MESSAGES`), regex definitions, and check order matching `backend/src/services/payment-verification.ts`.
- **Automated Parity Test**: `backend/tests/payment-verification.test.ts` imports both `payment-verification.ts` and `frontend/lib/verification.js` to assert key-for-key and message-for-message equivalence.

---

## Issue #9: Network Passphrase Guard Against Cross-Network Replay / Spoofing

### 1. Threat Model & Security Audit

| Vector | Threat Description | Mitigating Guard |
|---|---|---|
| **Client Spoofing** | Attacker submits a testnet transaction hash to a mainnet invoice passing `network: "PUBLIC"` in request body. | Backend ignores client-supplied `network` parameter for ledger queries. Server queries Horizon endpoint determined strictly by server configuration (`STELLAR_HORIZON_URL` / `STELLAR_NETWORK`). |
| **Cross-Network Replay** | Same transaction hash existing on testnet and mainnet (or private net). | Verification fetches transaction details from the server's configured Horizon server and verifies matching network passphrase / server context. |
| **Frontend Authority** | Client-side script attempts to set `status = PAID` locally. | Frontend `verification.js` is strictly non-authoritative (UX pre-check only). Only the server endpoint `/api/invoices/:id/verify` can transition state. |

### 2. Enforcement Details
- **Server Authority**: Server-side `verifyHorizonPayment` verifies `expected.network === network` if provided, and queries the authoritative server Horizon client configured with `STELLAR_NETWORK` (`TESTNET` or `PUBLIC`).
- **Client Mirror Role**: `frontend/lib/verification.js` documents explicitly that it is UX-only.

---

## Issue #20: Freighter Network Mismatch Detection Between Wallet and App

### 1. UX & Pre-Flight Verification Architecture
When a user interacts with Freighter (connecting wallet, building payment transaction, or switching networks mid-session):

1. **Pre-flight Network Check**: Before building or prompting a transaction signature in `sendPayment` (`frontend/lib/stellar.ts`), query Freighter's `getNetwork()` or `getNetworkDetails()`.
2. **Network Comparison**: Compare Freighter's network passphrase (`Test Stellar Network ; February 2015` vs `Public Global Stellar Network ; September 2015` or network name `TESTNET`/`PUBLIC`) against the application's expected network `NEXT_PUBLIC_STELLAR_NETWORK`.
3. **Actionable Prompting**: If a mismatch occurs:
   - Interrupt transaction generation immediately before signature request.
   - Return a clear error: `"Freighter wallet network (e.g. TESTNET) does not match required invoice network (PUBLIC). Please switch networks in Freighter to continue."`

### 2. Mid-Session Network Switch Handling
- `frontend/components/WalletConnect.tsx` and `frontend/components/PaymentButton.tsx` verify network alignment prior to transaction build.

---

## Verification & Test Plan

1. **Concurrent Verification Test**: Run concurrency harness simulating 10 parallel `POST /api/invoices/:id/verify` calls for a single invoice.
   - Assert `200 OK` on exactly 1 response.
   - Assert `400` / `INVOICE_ALREADY_PAID` on remaining 9.
   - Assert side effect (notification / email log) executed exactly once.
2. **Cross-Network Replay Test**: Submit testnet tx hash against mainnet invoice expected configuration. Assert rejection with `NETWORK_MISMATCH`.
3. **Freighter Network Test**: Mock Freighter returning `TESTNET` when app expects `PUBLIC`. Assert error caught prior to transaction construction.
