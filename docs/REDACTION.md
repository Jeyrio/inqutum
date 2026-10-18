# Redaction Specification: Logs, Exports, and Error Responses

## Context & Objectives
Inqutum processes invoice lifecycle state, Stellar testnet/public blockchain verification, merchant exports, and audit logging. To maintain strict multi-tenant boundary isolation and prevent credential leakage, a unified redaction engine enforces zero-leakage guarantees across three critical boundaries:
1. **Logs**: Structured operational logs, correlation tracking, maintainer actions, and audit trail metadata.
2. **Exports**: Merchant JSON and CSV invoice exports, allow-listed schema enforcement, formula injection defense, and multi-tenant authorization.
3. **Error Responses**: HTTP error response payloads, error taxonomy mappings, verification failure envelopes, and uncaught exception handling.

---

## 1. Redaction Engine & Pattern Canonicalization

The redaction engine (`backend/src/security/redaction.ts`) applies deterministic regex filtering and recursive object traversal:

| Sensitive Target | Match Pattern | Redaction Result |
|---|---|---|
| Stellar Secret Seed | `\bS[A-Z0-9]{55}\b` | `S[REDACTED_SECRET_KEY]` |
| Bearer / Auth Token | `Bearer\s+([A-Za-z0-9\-._~+/]+=*)` | `Bearer [REDACTED_TOKEN]` |
| PEM Private Key | `-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]+-----END [A-Z ]*PRIVATE KEY-----` | `[REDACTED_PRIVATE_KEY]` |
| URL Credentials | `(:\/\/[^:/\s]+:)[^@\s]+(@)` | `postgres://user:[REDACTED]@host:port/db` |
| Key-Value Secrets | `((?:password\|secret\|apiKey\|api_secret\|auth_token)\s*[=:]\s*)[^\s,;&"']+` | `password=[REDACTED]`, `apiKey: [REDACTED]` |
| JSON Quoted Credentials | `"?(password\|secret\|apiKey\|api_secret\|auth_token)"?\s*:\s*"[^"]+"` | `"$1":"[REDACTED]"` |
| Object Property Keys | Keys containing `secret`, `password`, `authorization`, `privatekey`, `token`, `credential`, `apikey` | Value replaced with `'[REDACTED]'` |

### Public Value Preservation
Redaction rules strictly preserve public identifiers necessary for blockchain auditing and operations:
- Stellar public keys (`G...`, 56 base32 characters)
- Stellar transaction hashes (64-character hexadecimal)
- Invoice UUIDs, public memos, asset codes, and stroop precision amounts
- Correlation IDs (`x-correlation-id`) and canonical error taxonomy codes

---

## 2. Operational Path Analysis

### A. Normal Paths
- **Logs**: Successful operations (`invoice.create`, `invoice.verify_payment`, `invoice.get`) log latency, correlation ID, actor type, and sanitized metadata. Public keys and transaction hashes remain visible; secrets in metadata are scrubbed.
- **Exports**: Authorized sellers export their invoices in JSON or CSV format. Only fields in `EXPORT_FIELDS` are emitted. Personal identifiable information (customer/seller names and emails) is omitted by design. Free-text description and memo fields containing embedded secrets are redacted via `redactSensitiveText`. CSV formula triggers (`=`, `+`, `-`, `@`, `\t`, `\r`) are escaped via `csvCell`.
- **Error Responses**: Successful requests return HTTP 200/201 with standard API envelopes (`ApiSuccess<T>`) without sensitive information leakage.

### B. Failure Paths
- **Logs**: Unhandled exceptions, database query errors, and payment verification failures log error codes and sanitized error summaries. Error strings with connection strings (`postgres://user:pass@host`) or secret seeds are masked before reaching log storage.
- **Exports**: Invalid export requests (missing/invalid requester, invalid format, bad date filters) return 400 `INVALID_EXPORT_REQUEST`. Storage errors during generation return 500 `EXPORT_FAILED` with generic messages, preventing database credential leakage.
- **Error Responses**: `buildUserSafeErrorResponse`, `sendFailure`, and Express error middleware pass all error messages through `redactErrorMessage`. Stack traces and internal source paths (`/app/src/...`) are stripped, preventing internal architecture exposure.

### C. Retry Paths
- **Logs**: Retry loops (such as Horizon polling or background job retries) record attempt counts and backoff intervals without accumulating unredacted error stacks across attempts.
- **Exports**: Large exports subject to timeouts or client disconnects trigger `ExportCancelledError` without persisting partial artifacts. Subsequent retry requests with identical parameters produce clean, uncorrupted artifacts using stable keyset paging (`after` cursor).
- **Error Responses**: Retryable failures (`HORIZON_UNAVAILABLE` 503, `RATE_LIMITED` 429, `TRANSACTION_NOT_FOUND` 404, `EXPORT_TIMED_OUT` 503, `CONFLICT` 409) return `retryable: true` and actionable `recoveryAction` guidance with sanitized error messages.

### D. Authorization Paths
- **Logs**: Unauthorized operations (`UNAUTHORIZED_SELLER`, `EXPORT_FORBIDDEN`, `CORS_ORIGIN_DENIED`) log actor identity and target scope while redacting raw credentials or tokens present in headers or payloads.
- **Exports**: Cross-wallet export generation is rejected with 403 `EXPORT_FORBIDDEN`. Downloading an artifact belonging to another wallet yields 404 `EXPORT_NOT_FOUND` (indistinguishable from non-existent IDs), preventing tenant enumeration. Expired artifacts return 410 `EXPORT_EXPIRED` to the owner, but 404 to other wallets.
- **Error Responses**: Authorization failures return user-safe explanations without reflecting back secret credentials, bearer tokens, or sensitive payload details.

---

## 3. Operational Edge Cases

| Edge Case | Impact | Remediation / Defense |
|---|---|---|
| Multiline Stack Trace in Error Message | Risk of internal path and line number leakage | `buildUserSafeErrorResponse` detects newlines and falls back to taxonomy `userSafeMessage`. Single-line error sanitizers extract the primary message and scrub credentials. |
| Mixed Credential Formats in Free-Text | Multiple secrets in invoice descriptions (e.g., `seed=S... bearer token`) | `redactSensitiveText` applies multi-pass sequential replacement with negative lookahead to prevent redaction collision or clobbering. |
| CSV Injection Combined with Credential Leak | Exploit formula execution while exfiltrating credentials | `csvCell` prefixes formula triggers (`=, +, -, @, \t, \r`) with apostrophe `'`, and `toExportRecord` sanitizes description text before cell encoding. |
| Deeply Nested Metadata in Log Payloads | Objects with nested arrays containing credentials | `sanitizeObject` performs recursive traversal, checking own-properties and masking sensitive keys across all levels. |
| High-Volume Unmatched Path Flooding | Memory exhaustion via unbounded label cardinality | `sanitizeLabelValue` collapses UUID and hash path segments into `:id`, and `boundedIncrement` caps telemetry maps at 500 keys. |

---

## 4. Recovery & Rollback Behavior

- **Stateless Pipeline**: The redaction engine operates in-memory on strings, response envelopes, and telemetry events. No database schema changes or state migrations are introduced.
- **Zero In-Flight Residue**: Cancelled or timed-out exports discard uncommitted artifacts immediately (`this.artifacts.delete`), leaving no corrupt or partial data to recover or roll back.
- **Rollback Procedure**: In the event of an operational issue, rolling back to the previous commit is safe and immediate. Existing interfaces (`sanitizeForLogging`, `buildUserSafeErrorResponse`, `sendFailure`, `toExportRecord`) maintain backward-compatible function signatures.
- **Verification Command**:
  ```bash
  cd backend && node --import tsx --test tests/redaction.test.ts
  ```
