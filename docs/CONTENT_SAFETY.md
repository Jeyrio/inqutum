# Untrusted content and external URLs

Anything a user, payer or configuration value controls is treated as hostile.
Code: `backend/src/security/content-safety.ts`, `frontend/lib/safe-content.js`.

## Policy

| Kind | Rule | Outcome |
| --- | --- | --- |
| Plain-text fields (description, customer/seller/payer name) | Tags, HTML comments, control, zero-width and bidi-override characters removed; NFC-normalised | **Stripped** at the API boundary; empty results are dropped |
| Emails | Conservative allow-list (no quotes, `?`, `&`, `%`, whitespace, markup) | **Rejected** (`400` / `INVALID_PAYER_EMAIL`) |
| External URLs | `https` only (`http` for local dev config), no embedded credentials, no control characters | **Rejected**, or a safe fallback link |
| Output | Always escaped again where HTML is built by hand | **Escaped** |

`<` immediately followed by a letter, `/`, `!` or `?` counts as markup and is
removed even if unterminated (`a<b` becomes `a`). `a < b` is kept. This
favours safety over preserving rare literal `<x` text.

## Rendering locations audited

| Location | Risk | Fix |
| --- | --- | --- |
| Invoice/payer text shown in React pages | XSS | React escapes; input is also stripped at the API |
| `lib/export.ts` receipt window (`document.write`) | XSS if an escape is missed | Shared `escapeHtml` (now also escapes `` ` ``), plus a `Content-Security-Policy` meta tag that blocks scripts and external loads |
| `lib/export.ts` CSV download | Broken quoting; formula injection (`=HYPERLINK(...)`) | Shared `csvCell`: doubled quotes, `'` prefix on `= + - @ \t \r` |
| `lib/export.ts` email share | `mailto:` header/recipient injection (`?bcc=`, `,`) | `buildMailtoUrl` accepts one plain address, encodes subject/body |
| Explorer links (`getExplorerTransactionUrl`, wallet menu) | Link built from untrusted hash/key | Only 64-hex hashes / valid `G…` keys build a deep link; otherwise the explorer home. Wallet link opens with `noopener,noreferrer` |
| Payment links (`FRONTEND_URL`) | Scheme/credential injection into QR and links | Only the validated origin is used, else `http://localhost:3000` |
| Backend CSV export (`docs/EXPORTS.md`) | Formula injection | Same `'` prefix rule |

External `<a target="_blank">` links already carried `rel="noopener noreferrer"`.

## Headers

API (both servers): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; …`,
`Cross-Origin-Resource-Policy: same-site`, `Permissions-Policy`, and no `X-Powered-By`.

Frontend (`next.config.js`): adds `X-Frame-Options: DENY`, `Permissions-Policy`
and a CSP limited to `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`.
Script/style sources are intentionally not restricted here because Next.js
injects inline scripts; a nonce-based CSP would be the follow-up.

## Behaviour changes to know about

- Descriptions and names containing markup are stored without it.
- Payer emails must now match the conservative pattern (previously any
  `x@y.z` without whitespace).
- `getExplorerTransactionUrl` returns the explorer home for a malformed hash.
- `shareInvoiceByEmail` throws `Client email address is not valid` for an
  address that fails the mailto check.
