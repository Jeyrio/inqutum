# Sensitive-Content Boundary Verification (#266)

## Context & Objectives
Inqutum processes invoice generation, crypto payment verification, merchant financial exports, and webhook notifications. To guarantee system resilience and customer privacy, strict boundary controls prevent untrusted content from executing, escaping sandboxes, leaking private fields, or bypassing allow-lists across four distinct channels:
1. **Rendering** (HTML UI, payment pages, receipt PDFs, email templates)
2. **Downloads** (CSV invoice reports, JSON artifacts)
3. **Webhooks** (Inbound event verification, outbound SSRF filtering, payload minimization)
4. **Exports** (Multi-tenant authorization, schema allow-listing, PII containment)

---

## 1. Rendering Boundaries
- **HTML & Script Tag Neutralization**:
  All user-supplied text (invoice descriptions, memos, customer notes) is sanitized via `sanitizePlainText` and encoded using `escapeHtml` / `escapeHtmlAttribute`.
  - Nested tag payloads (`<<script>script>`) cannot re-form after normalization.
  - Active event handlers (`onerror=`, `onload=`, `onclick=`) are neutralized by transforming opening tags into inert HTML entities (`&lt;` / `&gt;`).
- **Template Delimiter Injection**:
  Client name and description validators (`validateClientName`, `validateNotesOrDescription`) actively reject server-side and client-side template syntax: `{{...}}`, `${...}`, `<%...%>`, `#{...}`.
- **Email & Header Protection**:
  `sanitizeEmailHeader` strips C0/C1 control characters and CRLF sequences (`\r`, `\n`), completely preventing SMTP header splitting and Bcc injection attacks.
- **Strict Content Security Policy (CSP)**:
  Generated print/receipt windows execute under:
  ```text
  default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'
  ```
  Even if raw markup were somehow introduced, scripts cannot execute, and form/base hijacking is blocked by the browser engine.

---

## 2. Downloads & File Boundaries
- **Spreadsheet Formula Injection (CSV Injection)**:
  Whenever spreadsheet cells are emitted (`csvCell` in `backend/src/exports/export-service.ts` and `frontend/lib/safe-content.js`), any string beginning with formula triggers (`=`, `+`, `-`, `@`, `\t`, `\r`) is automatically prefixed with a single quote (`'`). This renders the value as a literal string in Excel, Google Sheets, and LibreOffice, eliminating remote code execution via DDE or `=HYPERLINK` payloads.
- **Content-Type & nosniff Enforcing**:
  File download responses declare explicit MIME types (`text/csv; charset=utf-8`, `application/json; charset=utf-8`) with `X-Content-Type-Options: nosniff` to prevent browser MIME-confusion attacks.

---

## 3. Webhooks Boundaries
- **SSRF Prevention & Destination Allow-Listing**:
  `validateWebhookDestinationUrl` enforces that outbound webhooks only send traffic to public HTTPS targets:
  - Blocks loopback addresses: `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`.
  - Blocks AWS/GCP cloud metadata endpoints: `169.254.169.254`, `metadata.google.internal`.
  - Blocks RFC 1918 private subnets: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
  - Blocks embedded credentials (`https://user:pass@domain.com`).
- **Private Field Stripping**:
  `sanitizeWebhookPayload` enforces `DEFAULT_WEBHOOK_ALLOWLIST`. Internal properties (such as database identifiers, private signing keys, bearer tokens, and connection strings) are stripped before serialization.
- **Cryptographic Signature & Replay Prevention**:
  Inbound webhooks require valid `X-Webhook-Signature` HMAC-SHA256 headers evaluated with timing-safe comparison (`timingSafeEqual`) and a bounded timestamp tolerance window (300 seconds).

---

## 4. Exports Boundaries
- **Allow-List Enforcement**:
  `ExportService` strictly emits fields declared in `EXPORT_FIELDS`. Database columns containing sensitive internal data (e.g., version counters, admin annotations, internal payer records) are omitted by design.
- **Multi-Tenant Isolation**:
  Export artifacts are strictly scoped to the authenticated requester wallet. Accessing an artifact owned by another seller yields a clean 404 (`state: 'not_found'`), identical to non-existent IDs, preventing user enumeration or cross-tenant data leaks.

---

## Operational Edge Cases & Failure Modes

| Edge Case | Impact | Remediation / Recovery |
|---|---|---|
| Merchant specifies internal IP as webhook target | SSRF risk to cloud infrastructure | Rejected by `validateWebhookDestinationUrl`; merchant is notified with HTTP 400. |
| Customer name contains spreadsheet formula | Formula execution upon merchant export | Neutralized with leading apostrophe; merchant sees raw text safely. |
| Malicious merchant injects `<script>` into description | Potential Stored XSS | Stripped during input validation; escaped on rendering; blocked by CSP. |
| Expired export artifact accessed | Outdated financial report | Service automatically purges expired artifacts (>24h) and returns HTTP 410. |
