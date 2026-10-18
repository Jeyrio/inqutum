# Cross-device concurrency and conflict handling

Quittance uses optimistic concurrency control to prevent silent data loss when
multiple tabs, devices, or API clients modify the same invoice concurrently.

## How it works

Every invoice carries a `version` counter (integer, starting at 1). Each
successful state change (cancel, mark-as-paid) increments the version. Clients
include the expected version in their request; the server rejects the operation
with HTTP 409 if the version has changed since the client last read it.

```
Client A reads invoice (version: 1)
Client B reads invoice (version: 1)
Client A cancels  --> succeeds, version becomes 2
Client B cancels  --> 409 Conflict (expected 1, current 2)
```

## Client usage

### Sending the version

Include the version in one of two ways:

1. **Request body** (preferred): `{ "version": 1 }`
2. **If-Match header**: `If-Match: 1`

Both `POST /api/invoices/:id/cancel` and `POST /api/invoices/:id/verify`
accept the version.

### Reading the version

The version is returned in:
- The response body: `data.version`
- The `ETag` response header on `GET /api/invoices/:id`

### Handling conflicts

When the server returns HTTP 409:

```json
{
  "success": false,
  "error": "Invoice was modified by another session (current version: 2, attempted: 1). Please refresh and try again.",
  "code": "CONFLICT",
  "category": "LIFECYCLE",
  "retryable": true,
  "recoveryAction": "Refresh the invoice to get the latest version, then retry the operation."
}
```

The client should:
1. Re-fetch the invoice to get the latest state and version.
2. Show the user what changed (if applicable).
3. Let the user decide whether to retry the operation.

### Backward compatibility

Clients that do not send a version are allowed through without a version check.
This ensures old clients continue to work during rollout. Once all clients are
updated, the version can be made required.

## Database

The `invoices` table has a `version INTEGER NOT NULL DEFAULT 1` column. The
convergence migration in `db/schema.sql` adds the column to existing databases:

```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
```

## Tests

```bash
cd backend
node --import tsx --test tests/concurrency.test.ts
```
