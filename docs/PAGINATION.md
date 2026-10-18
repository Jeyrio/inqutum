# Invoice list pagination and filtering

`GET /api/invoices` returns a seller's invoices newest first. The ordering is
**total and deterministic**: `created_at` (millisecond precision) descending,
then `id` descending, so two invoices created in the same millisecond still
have a fixed order. Both storage backends (in-memory and Postgres) use the
same ordering, via `backend/src/storage/invoice-cursor.ts`.

## Query parameters

| Param | Meaning |
|-------|---------|
| `sellerPublicKey` | Required. Only this wallet's invoices are ever returned. |
| `status` | Optional, case-insensitive: `PENDING`, `PAID`, `EXPIRED`, `CANCELLED`. Anything else returns `400 INVALID_STATUS`. |
| `limit` | Page size, default 50, clamped to 1–200. Non-numeric or negative values use the default. The effective value is echoed in `pagination.limit`. |
| `cursor` | `pagination.nextCursor` from the previous response. When present, `offset` is ignored. |
| `offset` | Legacy. Kept for old clients but **unstable**: see below. |

Response `pagination`:

```json
{ "limit": 50, "offset": 0, "total": 50, "nextCursor": "MjAyNi0w…", "hasMore": true }
```

`total` is the number of rows on this page. `nextCursor` is `null` on the last
page, and `hasMore` is always `nextCursor !== null`. Cursors are opaque
(base64url of `createdAt|id`). A malformed or edited cursor returns
`400 INVALID_CURSOR` (`category: VALIDATION`, `retryable: false`), and the client
should restart from the first page. An unknown `status` returns
`400 INVALID_STATUS` with the same classification.

**Limit bounds (migration note).** Before this bound, `limit=0` returned an
empty page with `hasMore: true` and no cursor, and `limit` had no upper bound.
Clients that ask for more than 200 now get 200 rows, with `hasMore` and
`nextCursor` set. Cursor clients need no change. Legacy offset clients must
advance `offset` by the number of rows returned (or `pagination.limit`), not by
the limit they requested. The dashboard requests 50 and is unaffected. Cursor payloads are strictly validated: bounded to 512 characters,
restricted to standard base64url characters, validated for strict ISO-8601
millisecond timestamp round-tripping and valid UUID format.

## Why cursors instead of offsets

With `offset`, every insert, cancel or expiry that moves a row across a page
boundary shifts the rest of the list. The client then sees a row twice or never
sees it. A cursor names the last row the client saw, and the next page is
"everything strictly older than that row". This means:

| Change while paging | Offset | Cursor |
|---|---|---|
| New invoice created | earlier row repeated on the next page | new row is ahead of the cursor, next page unaffected |
| Row already shown is deleted | next row skipped | unaffected, even if the deleted row *is* the cursor |
| Row leaves a `status` filter (e.g. cancelled, expired) | next row skipped | unaffected |

New invoices created mid-pagination are **not** appended to later pages. The
dashboard picks them up on its next full reload (filter change, reconnect or
retry).

## Hidden, deleted and restricted records

- **Other wallets' invoices** are filtered in the storage query itself
  (`seller_public_key = $1`). Passing a cursor taken from another wallet's list
  only sets a position. It never widens the result set.
- **Expired** invoices are transitioned lazily before every list read, so the
  `PENDING` filter never returns an invoice that is past `expires_at`.
- **Cancelled and expired** invoices stay in history. They are only hidden when
  a `status` filter excludes them.
- **Hard-deleted** rows (not exposed by the API, but possible via SQL or
  retention jobs) disappear without disturbing cursor positions.

The dashboard sends the same uppercase `status` the API validates. Its
"Load more" button follows `nextCursor`, and a filter or wallet switch discards
any in-flight page.

## Tests

```bash
cd backend
npm test                                    # cursor suite runs on both backends (fake Postgres)
node --import tsx --test tests/invoice-cursor.test.ts # cursor encode/decode & edge-case contract tests
node --import tsx --test tests/pagination-authorization-contract.test.ts # HTTP contract: paging, filters, wallet scope, admin boundary
DATABASE_URL=postgres://… npm run test:pg   # same-millisecond ties + inserts on real Postgres
```
