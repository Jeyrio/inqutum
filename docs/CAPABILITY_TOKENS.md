# Capability tokens for sensitive actions

The admin bearer token (`JOBS_ADMIN_TOKEN`) is long lived and shared. A
**sensitive action** also requires a capability: a signed, short-lived,
single-use grant for one action on one target, minted for a named maintainer.
Code: `backend/src/security/capability-tokens.ts`.

## Configure

| Variable | Requirement |
| --- | --- |
| `CAPABILITY_TOKEN_SECRET` | At least 32 characters (RFC 2104 discourages HMAC-SHA256 keys shorter than the 32-byte hash output). Separate from every other secret. Unset or too short → capability routes return `403 CAPABILITIES_DISABLED`. |

Generate one with `openssl rand -base64 48`.

## Sensitive actions

| Action | Target | Default TTL | Max TTL | Consumed by |
| --- | --- | --- | --- | --- |
| `config.feature_flag.set` | flag name | 5 min | 15 min | `PUT /api/ops/config/feature-flags/:flag` |

## Flow

```bash
# 1. Mint (admin bearer). ttlSeconds is optional.
curl -sX POST $API/api/ops/capabilities \
  -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"action":"config.feature_flag.set","target":"paymentAmountTolerance","subject":"alice","ttlSeconds":120}'
# → 201 {"data":{"token":"qcap.v1.…","capabilityId":"…","expiresAt":"…"}}

# 2. Use it once, alongside the admin bearer.
curl -sX PUT $API/api/ops/config/feature-flags/paymentAmountTolerance \
  -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" -H "X-Capability-Token: $CAP" \
  -H 'content-type: application/json' \
  -d '{"enabled":false,"reason":"Incident 42: exact-match only","expectedVersion":0}'
```

Issuing records a `CAPABILITY_ISSUED` audit event with the `capabilityId`,
never the token. The consuming action records the same `capabilityId` in its
event `metadata`. To link issuance and use, query
`GET /api/audit/events?action=CAPABILITY_ISSUED` and `?action=CONFIG_CHANGED`
and match `metadata.capabilityId`; the endpoint has no metadata filter.

## Token format and checks

`qcap.v1.<base64url(claims)>.<base64url(HMAC-SHA256(secret, "qcap.v1.<claims>"))>`

Claims: `typ`, `v`, `id`, `action`, `target`, `subject`, `iat`, `exp` (epoch ms).

Checks run in a fixed order, and the first failure is reported:

| Order | Check | Code | HTTP |
| --- | --- | --- | --- |
| 1 | Header present | `CAPABILITY_REQUIRED` | 401 |
| 2 | Shape: prefix, 4 parts, base64url, at most 1024 chars | `CAPABILITY_MALFORMED` | 401 |
| 3 | Signature (constant-time), **before** the claims are parsed | `CAPABILITY_INVALID` | 401 |
| 4 | Claims shape; `iat` at most 30 s in the future | `CAPABILITY_INVALID` | 401 |
| 5 | `now < exp` | `CAPABILITY_EXPIRED` | 401 |
| 6 | Action and target match the route | `CAPABILITY_SCOPE_MISMATCH` | 403 |
| 7 | Not in flight | `CAPABILITY_IN_USE` | 409 |
| 8 | Not already used | `CAPABILITY_ALREADY_USED` | 409 |
| 9 | Ledger has room | `CAPABILITY_LEDGER_FULL` | 503 |

These choices follow RFC 8725 (JWT Best Current Practices):

- The version prefix fixes the algorithm, so there is no `alg` header to downgrade.
- An explicit `typ` and a dedicated key prevent cross-token confusion.
- Scope plays the role of an audience.

## Retries and single use

`use()` reserves the id, runs the action, then:

- **Success** commits. The id stays burned until `exp`, and a replay gets 409 `CAPABILITY_ALREADY_USED`.
- **Failure** of any kind (validation 400, version conflict 409, audit outage 503, a thrown error) releases the reservation. Retry with the **same** token.
- **A concurrent duplicate** gets 409 `CAPABILITY_IN_USE`. Wait for the first request to finish.

If the response to a successful call is lost, the retry returns 409
`CAPABILITY_ALREADY_USED`. Confirm the outcome with `GET /api/ops/config`, or
search `GET /api/audit/events?action=CONFIG_CHANGED` for your `capabilityId`.

## Operational edge cases

- **Revoke all outstanding tokens:** rotate `CAPABILITY_TOKEN_SECRET` and
  restart. Every token signed with the old key fails with 401 `CAPABILITY_INVALID`.
  There is no per-token revocation; short TTLs are the mitigation.
- **Restart:** the used-id ledger is in memory, and so are the config overrides
  and their version (see [ADMIN_CONFIG_AUDIT.md](ADMIN_CONFIG_AUDIT.md)). A
  captured request can therefore be replayed once after a restart, within the
  token's remaining TTL (≤ 15 min). It can only redo the exact change the token
  was minted for, on the same target, and it writes new evidence. A replay with
  any other `expectedVersion` is rejected with 409 `CONFIG_VERSION_CONFLICT`.
  To rule this out, rotate the secret as part of the restart.
- **Several instances:** the ledger is per process. Route `/api/ops/*` to one
  instance, or keep TTLs short. Clocks may differ by up to 30 s.
- **Ledger full:** the service refuses (503) instead of evicting, because
  evicting a used id would make it replayable. Entries free themselves at `exp`.
  Memory is bounded by `ledgerCapacity` (default 10 000).

## Complexity

Issuing is O(1) and stores nothing. Verifying is O(L) in the token length
(≤ 1024). Reserving is amortised O(1); an O(capacity) sweep of expired ids runs
only when the ledger is full. Space is O(live used or reserved ids).

## Tests

```bash
cd backend
node --import tsx --test tests/capability-tokens.test.ts tests/admin-config-audit.test.ts
```
