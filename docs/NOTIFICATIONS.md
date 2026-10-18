# Notifications

Sellers are notified about invoice lifecycle events that need attention.
Code: `backend/src/notifications/`, `backend/src/routes/notification.routes.ts`.

## Events

| Type | Severity | Trigger |
| --- | --- | --- |
| `invoice.paid` | success | Payment verified (verify or simulate) |
| `invoice.expired` | warning | A pending invoice expired unpaid |
| `invoice.cancelled` | info | Seller cancelled the invoice |
| `payment.rejected` | critical | A payment for the invoice was rejected in a way the seller can act on (wrong amount, asset, memo, destination, network, or no payment operation). The message explains the recovery path |

Payer-side mistakes (bad hash, malformed email) do not notify the seller.

## Recipients and privacy

The recipient is the invoice's `sellerPublicKey`, the same wallet identity the
invoice routes scope by. Notifications carry only invoice id, amount, asset and
memo. Customer and payer names/emails are never copied in. Another wallet
cannot read or mark a notification, and receives `404` (not `403`) so ids
cannot be probed.

> The API has no signed authentication today: like `GET /invoices`, the
> `recipient` is asserted by the caller. Notifications hold nothing beyond what
> the public payment page already shows, but bind `recipient` to an
> authenticated wallet session if/when one is added.

## Exactly-once delivery

Each event has a deterministic dedup key (`<invoiceId>:<type>`; rejections add
`<txHash>:<code>`). Emission is derived from the invoice's current state, so it
is safe to call on every read, request retry or replay: the second call returns
the existing notification. Because expiry happens inside storage, it is noticed
the first time the invoice is read afterwards.

## API

All routes take the wallet as `recipient` (query or JSON body).

| Route | Purpose |
| --- | --- |
| `GET /api/notifications?recipient=&unread=true&limit=&offset=` | Newest first; response includes the unread count |
| `GET /api/notifications/unread-count?recipient=` | Badge counter |
| `POST /api/notifications/:id/read` | Mark one read (idempotent) |
| `POST /api/notifications/read-all` | Mark all read |

`deepLink` is an app-relative path (`/invoice/<id>`) to the workflow.

## Storage and deployment

Storage is in-process memory, matching the audit trail: notifications are lost
on restart and are per-instance. Emission is idempotent, so a persistent store
can replace `MemoryNotificationStore` without changing callers. No migration or
new configuration is required.
