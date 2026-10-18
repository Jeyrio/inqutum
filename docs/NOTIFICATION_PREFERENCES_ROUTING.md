# Notification Preferences & Mandatory-Alert Routing Model

## Context & Architecture
In Inqutum, notifications alert sellers and operators to invoice lifecycle changes, payment recoveries, security anomalies, and optional reminders. Previously, notification delivery had no persistent preference model, meaning sellers could not choose channels or opt out of non-critical messages, while non-deliverability could silence urgent payment recovery operations.

This model (Issue #268) introduces durable per-recipient notification preferences with strict mandatory alert routing invariants.

## Classification Model

### 1. Mandatory Lifecycle & Security Alerts
Mandatory alerts cannot be muted or suppressed by user preferences. If a recipient disables all channels or categories, mandatory notifications are still accepted, stored in the auditable feed, and flagged with `mandatoryOverride: 'true'`:
- `invoice.paid` (verified settlement)
- `invoice.expired` (unpaid expiry requiring seller action)
- `invoice.cancelled` (cancellation audit)
- `payment.rejected` (recoverable payment rejection requiring remediation)
- `security.alert` (suspicious access or critical security warnings)
- `recovery.failure` (background job or reconciliation failure)

### 2. Optional Notifications
Optional notifications respect recipient preferences and active delivery channels:
- `invoice.reminder` (periodic reminder of pending invoice)
- `marketing.digest` (periodic summaries)
- `account.tip` (usage guidance)

When an optional notification is evaluated and the recipient has opted out of the category or disabled all delivery channels, the message is **suppressed** (`decision: 'SUPPRESSED'`, `reason: 'SUPPRESSED_BY_PREFERENCE'`). It is not inserted into the unread notification feed.

## Public APIs

- `GET /api/notifications/preferences?recipient=<StellarPublicKey>`: Read durable preferences (returns defaults if unconfigured).
- `PUT /api/notifications/preferences`: Update channel (`in_app`, `email`) and category preferences.
- `GET /api/notifications/routing-audit?recipient=<StellarPublicKey>`: Read immutable audit log of routing decisions (delivered vs. suppressed vs. mandatory override).

## Operational Edge Cases & Failure Modes

1. **Unregistered / Cold Recipient**: Default preferences (`in_app: true`, `email: true`, essential categories enabled, marketing disabled) are materialized deterministically without throwing errors.
2. **Channel Starvation (User sets `in_app: false, email: false`)**: Mandatory alerts automatically fall back to delivering in-app with `MANDATORY_OVERRIDE` to ensure auditability and prevent silent loss of funds recovery.
3. **Replay Storms / Idempotency**: All notifications maintain deterministic `dedupKey`s. Replayed lifecycle events (e.g. repeated payment verification calls) are deduplicated at the storage boundary.
4. **PII Isolation**: Notifications and routing audit records store only entity IDs, amounts, assets, and error codes; customer PII (names, emails) is never stored in notifications.

## Rollback & Recovery Procedures

- **Rollback**: If preference routing needs to be disabled, the default fallback produces `evaluateNotificationRouting` returning deliver for all supported events.
- **Data Recovery**: In-app stores can be cleared or re-synced via `syncInvoiceNotifications(invoice)` directly from authoritative invoice state without data loss.
