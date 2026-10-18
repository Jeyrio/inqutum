# Cryptographic Verification for Imported External Evidence (#277)

## Overview

The External Evidence Verification Engine (`backend/src/security/external-evidence-verifier.ts`) establishes zero-trust cryptographic validation for incoming payment attestations, cross-network transaction proofs, and partner oracle settlements imported into Inqutum.

## Architecture & Principles

1. **RFC 8785 JSON Canonicalization**:
   - All evidence payloads are canonicalized prior to hashing, guaranteeing deterministic SHA-256 digests across diverse runtime environments, JSON key serialization orders, and whitespace differences.

2. **Dual Signature Primitives**:
   - **Ed25519**: High-performance, Edwards-curve public key digital signature algorithm for external blockchain oracles and decentralized signers.
   - **HMAC-SHA256**: Symmetric secret-based message authentication code for authenticated partner API integrations.

3. **Temporal Freshness & Replay Defense**:
   - **Max Age Window (default 10m)**: Rejects stale evidence replay.
   - **Clock-Skew Tolerance (default 1m)**: Guards against premature future timestamps.
   - **Digest Replay Cache**: Prevents double-processing of identical proofs while idempotently returning valid cached verification receipts on network retries.

4. **Signer Identity Trust Store**:
   - Maintains an allow-list of authorized key identifiers, cryptographic algorithms, and revocation status.
   - Unrecognized or revoked keys are rejected immediately with HTTP 403.

## Paths Verified

| Path | Behavior |
|------|----------|
| **Normal Path** | Cryptographically valid envelopes from authorized signers produce a verifiable `VerificationReceipt` with canonical digest and timestamp. |
| **Failure Path** | 1-bit payload tampering, invalid signatures, expired timestamps, or skewed future dates trigger `EvidenceVerificationError` (`INVALID_SIGNATURE`, `EVIDENCE_EXPIRED`, `EVIDENCE_POST_DATED`). |
| **Retry Path** | Duplicate submissions within the replay window return identical cached receipts with `replayed: true` for idempotent operation. |
| **Authorization Path** | Unregistered or revoked signers are blocked with `UNTRUSTED_SIGNER` or `REVOKED_SIGNER_KEY` (HTTP 403). |
