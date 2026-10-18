# Activity timeline

`backend/src/domain/activity-timeline.ts` turns the invoice audit trail into a
timeline a seller can see, keeping maintainer only events out.

## Visibility

| Event | Visibility | Fields shown |
| ----- | ---------- | ------------ |
| `INVOICE_CREATED` | public | `amount`, `assetCode` |
| `PAYMENT_CONFIRMED` | public | `txHash`, `amount` |
| `INVOICE_CANCELLED` | public | none |
| `INVOICE_EXPIRED` | public | none |
| `PAYMENT_RECEIVED_AFTER_CANCEL` | public | `txHash` |
| `PAYMENT_RECEIVED_AFTER_EXPIRY` | public | `txHash` |
| `PAYMENT_REJECTED`, `PARTIAL_PAYMENT` | maintainer | not shown |
| anything else | maintainer | not shown |

A viewer sees an event only when it is public and the invoice belongs to their
wallet. Events on deleted or restricted invoices, or on invoices that no longer
exist, are dropped. Event data is filtered to the listed fields, so new fields
added to the audit trail are not exposed by default. To publish a new event
type, add it to `TIMELINE_EVENT_RULES`.

## Ordering and paging

Entries are newest first, with the event id breaking ties. Pages are cursor
based (`limit` 1 to 100, default 20). The cursor encodes the last entry's
time and id, so new events do not shift later pages. A malformed cursor throws
`InvalidTimelineCursorError`.

Each entry links to `/invoice/:id`.

## Tests

```bash
cd backend && node --import tsx --test tests/activity-timeline.test.ts
```
