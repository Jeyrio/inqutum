# Lifecycle-aware archival and restoration (#197)

Invoices are archived and restored through explicit rules, not a hidden flag.

- Module: `backend/src/domain/invoice-archival.ts`
- Routes (admin token): `GET /api/ops/invoices/:id/archive` (eligibility), `GET /api/ops/invoices/:id/history`, `POST /api/ops/invoices/:id/archive`, `POST /api/ops/invoices/:id/restore`
- Archive and restore require signed approvals (`invoice.archive`, `invoice.restore`; see `SIGNED_APPROVALS.md`).
- Tests: `cd backend && node --import tsx --test tests/invoice-archival.test.ts tests/ops-protected-routes.test.ts`

## Lifecycle

```
ACTIVE --archive--> ARCHIVED --restore--> ACTIVE
```

Archival is a layer over the invoice. **The invoice status (PAID / EXPIRED /
CANCELLED) is never rewritten**, so receipts, proofs, disputes and audit events
that point at the invoice keep resolving, and `GET /ops/invoices/:id/history`
returns the invoice together with its archive record.

## Eligibility

| Code | Rule |
|------|------|
| `NOT_TERMINAL` | only `PAID`, `EXPIRED`, `CANCELLED` can be archived |
| `TOO_RECENT` | the terminal state must be ≥ 30 days old (`minAgeDays`); measured from `settledAt`/`paidAt`, `cancelledAt` or `expiresAt` |
| `OPEN_DISPUTE` | no `OPEN`/`INVESTIGATING`/`REOPENED` dispute may reference the invoice |
| `ALREADY_ARCHIVED` | archiving twice is refused |

`GET …/archive` reports *all* failing rules at once. A denied archive returns
`409` with the first code and every denial in the error.

## Restore

Restore returns the record to the status it was archived from. It is refused
(`STATE_CHANGED_SINCE_ARCHIVE`) if the invoice's status or version moved while
archived, so a restore can never resurrect stale state. Restoring an invoice
that is not archived is `NOT_ARCHIVED`.

Both transitions need an actor and a reason (≥ 10 characters), are appended to
the record's history, and emit `INVOICE_ARCHIVED` / `INVOICE_RESTORED` audit
events carrying the references captured at archive time (disputes, etc.).

## Limits

The archive registry is held in process memory (like the other ops services),
so there is **no database migration**. Archive state does not survive a restart
and is not shared between instances; the invoice itself is unaffected. Moving
the registry to a table is a straightforward follow-up behind the same service
interface.
