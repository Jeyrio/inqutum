# ADR 001: Verification Contract Versioning and Change Management Process

## Status
Accepted

## Context
The payment verification contract determines whether a Stellar transaction satisfies an invoice (`memo`, `destination`, `amount`, `asset`, `network`). Verification logic exists in five key call sites across the backend and frontend:

1. `backend/src/services/payment-verification.ts` (Canonical verifier authority)
2. `backend/src/server-mvp.ts` (MVP in-memory server)
3. `backend/src/routes/invoice.handlers.ts` (Postgres invoice route handler)
4. `backend/src/services/stellar.service.ts` (Stellar verification service)
5. `frontend/lib/verification.js` (Client-side mirror for UX pre-checks)

Because the frontend and backend deploy independently, a change in verification rules without a synchronized change-management process could cause disagreement between client pre-checks and server settlement.

## Decision

### 1. Non-Authoritative Client Mirror
The frontend mirror (`frontend/lib/verification.js`) is strictly advisory for immediate UX feedback. The backend verifier (`backend/src/services/payment-verification.ts`) is the sole canonical authority for invoice settlement state transitions.

### 2. Version Identifier Alignment (`VERIFICATION_CONTRACT_VERSION`)
A shared version identifier constant `VERIFICATION_CONTRACT_VERSION = '1.0.0'` is present across all five call sites. Whenever verification semantics change:
- `VERIFICATION_CONTRACT_VERSION` must be bumped across all five call sites in the same commit/PR.
- The version string is included in verification audit telemetry to aid historical debugging.

### 3. Deploy Sequence & Backward Compatibility
1. **Backend First**: Backend changes MUST ship before or alongside frontend bundle updates.
2. **Backward Compatibility**: Backend verification must remain backward-compatible with in-flight transactions created under prior contract versions.
3. **Feature Flags**: Additive or sensitive rule changes should be guarded by runtime feature flags (e.g. `paymentAmountTolerance`).

## Historical Example: Preventing Contract Drift

### Scenario: Adding ±1 Stroop Amount Tolerance
Suppose the project adds amount tolerance for rounding differences.

1. **Without Process**: Frontend mirror is updated to accept ±1 stroop before the backend is deployed. A client sends payment with 1 stroop difference. The frontend pre-check passes and shows "Payment Valid", but the server rejects it with `AMOUNT_MISMATCH`, confusing the client.
2. **With Process**:
   - The contract version is bumped to `1.1.0`.
   - The backend verifier is updated behind feature flag `paymentAmountTolerance` and deployed first.
   - The frontend mirror is updated next. Both client and server agree on version `1.1.0`.
