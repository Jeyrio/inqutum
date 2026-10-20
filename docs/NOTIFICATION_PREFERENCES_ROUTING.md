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

### 3. Category classification (Issue #193)

Each preference category is exactly one of these, exported from
`backend/src/notifications/notification-preference.ts`:

| Category | Class | Types |
|----------|-------|-------|
| `invoice_lifecycle` | mandatory | `invoice.paid`, `invoice.expired`, `invoice.cancelled` |
| `payment_recovery` | mandatory | `payment.rejected`, `recovery.failure` |
| `security_alert` | mandatory | `security.alert` |
| `payment_reminder` | optional | `invoice.reminder` |
| `marketing_digest` | optional (off by default) | `marketing.digest`, `account.tip` |

`MANDATORY_NOTIFICATION_CATEGORIES`, `OPTIONAL_NOTIFICATION_CATEGORIES` and
`isMandatoryCategory()` are the source of truth. A recipient may still store
`false` for a mandatory category (existing clients do). It is persisted as
written, but routing ignores it and records `MANDATORY_OVERRIDE`. A request that
did this is accepted rather than rejected, so older clients keep working, and the
opt-out stays visible in the audit trail instead of being silently dropped.

## Public APIs

- `GET /api/notifications/preferences?recipient=<StellarPublicKey>`: Read durable preferences (returns defaults if unconfigured). The response also lists `mandatoryCategories`.
- `PUT /api/notifications/preferences`: Update channel (`in_app`, `email`) and category preferences. **Requires a credential** (see below).
- `GET /api/notifications/routing-audit?recipient=<StellarPublicKey>`: Read immutable audit log of routing decisions (delivered vs. suppressed vs. mandatory override).

### Who may change preferences

Changing preferences is the one notification write that can silence someone
else's alerts, so `PUT` is guarded by the `notification:preferences:write`
permission (`shared/access-control.ts`):

| Caller | Result |
|--------|--------|
| No credential, malformed or expired token | `401 UNAUTHENTICATED` |
| Wallet session for the `recipient` | `200` |
| Wallet session for a different wallet | `403 FORBIDDEN` |
| Maintainer bearer (`MAINTAINER_API_TOKENS`) | `200`, attributed to the maintainer |
| Service bearer (`SERVICE_API_TOKENS`) | `403 FORBIDDEN` |

Reads (`GET` preferences, routing audit, the feed) keep the existing
recipient-scoped model unchanged.

### Validation

The body is `{ recipient, channels?, categories? }`. Everything except
`recipient` is parsed with `notificationPreferencePatchSchema` (strict Zod).
Unknown keys (`emial`, `reminders`, `sms`), non-booleans (`"false"`) and an
empty patch are `400 INVALID_NOTIFICATION_PREFERENCES` with the field-level
reason in the message, and nothing is stored. `NotificationService.savePreferences`
re-validates, so in-process callers cannot store unknown keys either.

```bash
# Opt out of payment reminders (own wallet session)
curl -X PUT "$API/notifications/preferences" \
  -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' \
  -d '{"recipient":"G...","categories":{"payment_reminder":false}}'
# → 200 { "success": true, "data": { "recipient": "G...", "channels": {...},
#        "categories": { "payment_reminder": false, ... },
#        "mandatoryCategories": ["invoice_lifecycle","payment_recovery","security_alert"] } }

# A typo is refused instead of looking like a successful opt-out
curl -X PUT ... -d '{"recipient":"G...","categories":{"reminders":false}}'
# → 400 { "success": false,
#        "error": "Notification preference update is invalid: categories: Unrecognized key(s) in object: 'reminders'",
#        "code": "INVALID_NOTIFICATION_PREFERENCES", "timestamp": "..." }
```

### Preference-change audit

Every accepted edit writes a `NOTIFICATION_PREFERENCES_UPDATED` event to the
hash-chained audit trail (`scope.entityType: 'notification_preferences'`,
`entityId: <recipient>`). It records the actor (`seller` with the wallet, or
`maintainer` with the token fingerprint subject), the before and after
channels and categories, the request correlation id, and
`metadata.overriddenMandatoryCategories`: the mandatory categories now
switched off whose alerts will still be delivered. Refused edits (401/403/400)
write nothing.

Together with the routing audit, this answers both "who turned this off?" and
"was a critical alert delivered anyway?".

## Operational Edge Cases & Failure Modes

1. **Unregistered / Cold Recipient**: Default preferences (`in_app: true`, `email: true`, essential categories enabled, marketing disabled) are materialized deterministically without throwing errors.
2. **Channel Starvation (User sets `in_app: false, email: false`)**: Mandatory alerts automatically fall back to delivering in-app with `MANDATORY_OVERRIDE` to ensure auditability and prevent silent loss of funds recovery.
3. **Replay Storms / Idempotency**: All notifications maintain deterministic `dedupKey`s. Replayed lifecycle events (e.g. repeated payment verification calls, or every invoice read re-syncing its status) are deduplicated *before* routing, so each event is routed and audited exactly once. Previously every replay added a routing record pointing at a notification id that was never stored.
5. **Opt-out of a mandatory category**: accepted and stored. The response's `mandatoryCategories` tells the client those alerts still arrive, the preference-change audit names them, and each alert's routing record says `MANDATORY_OVERRIDE`.
6. **Session expires mid-edit**: `401`. The client must re-authenticate, and nothing is half-applied, because a patch is validated in full before it is stored.
7. **Maintainer edits on a participant's behalf**: allowed (support case) and attributed to the maintainer subject, never to the participant.
4. **PII Isolation**: Notifications and routing audit records store only entity IDs, amounts, assets, and error codes; customer PII (names, emails) is never stored in notifications.

## Rollback & Recovery Procedures

- **Rolling back the #193 write guard**: there is no data migration to undo. Removing `authenticate()`/`requirePermission('notification:preferences:write')` from the `PUT` route restores the previous open behaviour. Stored preferences are unchanged either way. Clients that never sent a token started receiving `401` with #193, so roll back only if such a client cannot be updated.
- **Deployment**: `PUT` requires wallet sessions, so `AUTH_SESSION_SECRET` must be set (it already is wherever invoices are created). Without it, wallet tokens resolve to `sessions_unavailable` and the route answers `401`.

- **Rollback**: If preference routing needs to be disabled, the default fallback produces `evaluateNotificationRouting` returning deliver for all supported events.
- **Data Recovery**: In-app stores can be cleared or re-synced via `syncInvoiceNotifications(invoice)` directly from authoritative invoice state without data loss.
