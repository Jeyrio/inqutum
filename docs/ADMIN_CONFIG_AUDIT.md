# Audit evidence for administrative configuration changes

Administrative configuration is set through environment variables, and an
environment change leaves nothing in the audit trail.
`backend/src/config/admin-config.ts` is the one place configuration can change
at runtime, and every change it applies produces audit evidence. Today it covers
runtime overrides of the existing [feature flags](FEATURE_FLAGS.md), which are
already evaluated on every check.

## Endpoints (Postgres server, `/api/ops/*`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/ops/config` | admin | Version, plus each flag's effective value, `source` (`override` or `environment`) and `override`. |
| `PUT` | `/api/ops/config/feature-flags/:flag` | admin + `X-Capability-Token` ([capabilities](CAPABILITY_TOKENS.md), action `config.feature_flag.set`, target = flag) | Set (`true`/`false`) or clear (`null`) an override. |

Request body:

```json
{ "enabled": false, "reason": "Incident 42: exact-match only", "expectedVersion": 3 }
```

- `enabled` is required and must be `true`, `false` or `null`.
- `reason` must be 10–500 characters.
- `expectedVersion` is the `version` from `GET /api/ops/config`.

## The evidence

Each applied change appends one `CONFIG_CHANGED` event to the hash-chained audit
store (`previousHash`, `hash`; check with `auditStore.verifyChain()`):

| Field | Content |
| --- | --- |
| `actor` | `{ type: 'maintainer', id: <capability subject>, ip, userAgent }`. Comes from the capability, not the request body. |
| `scope` | `{ entityType: 'config', entityId: 'featureFlags.<flag>' }` |
| `reason` | The maintainer's justification. |
| `beforeState` / `afterState` | `{ enabled, source, override, configVersion }` |
| `metadata` | `{ configKey, envVar, change: 'override_set' \| 'override_cleared', capabilityId }` |
| `correlationId` | Same as the HTTP response's `correlationId`. |

Query it with `GET /api/audit/events?action=CONFIG_CHANGED&entityId=featureFlags.paymentAmountTolerance`
or export it with `GET /api/audit/export?action=CONFIG_CHANGED&format=csv`.

## Guarantees

- **Evidence first.** The event is written before the override is applied. If
  the audit store throws, the change is not applied: 503
  `CONFIG_AUDIT_UNAVAILABLE` (retryable). A change never exists without evidence.
- **No lost updates.** A stale `expectedVersion` returns 409
  `CONFIG_VERSION_CONFLICT`. Re-read the config, then retry.
- **No-ops are silent.** A request that changes nothing returns
  `changed: false`. The version does not move and no event is written.
- **Immediate effect.** `isFeatureEnabled()` reads the override on its next
  call, and `GET /api/health` reports the effective value under `features`.

## Failure and retry paths

| Situation | Response | Capability | What to do |
| --- | --- | --- | --- |
| Invalid body | 400 `INVALID_CONFIG_CHANGE` | released | Fix the body and retry with the same token. |
| Unknown flag | 404 `UNKNOWN_FEATURE_FLAG` | released | Use a name from `GET /api/ops/config`. |
| Version moved | 409 `CONFIG_VERSION_CONFLICT` | released | Re-read the version and retry with the same token. |
| Audit store down | 503 `CONFIG_AUDIT_UNAVAILABLE` | released | Retry. Nothing was applied. |
| Response lost after success | retry → 409 `CAPABILITY_ALREADY_USED` | used | Confirm with `GET /api/ops/config` (version advanced) or find your `capabilityId` in the audit events. |
| Missing admin token / capability / wrong scope | 401 / 401 / 403 | not reserved | See [CAPABILITY_TOKENS.md](CAPABILITY_TOKENS.md). |

## Rollback

Rollback is a forward change, so history is never rewritten:

1. `PUT …/feature-flags/<flag>` with `{"enabled": null, …}` clears the override,
   and the environment value applies again. Alternatively, set the previous value
   explicitly.
2. Confirm `source: "environment"` on `GET /api/ops/config` and the expected
   value on `GET /api/health`.
3. Both the change and its rollback stay in the audit trail.

## Operational edge cases

- **Restart or redeploy:** overrides and the version are process-local and reset
  to the environment and `0`. To make a change permanent, set the env var (see
  [FEATURE_FLAGS.md](FEATURE_FLAGS.md)), deploy, then clear the override.
- **Several instances:** each instance holds its own overrides. Send the change
  to every instance, or change the env var instead. Serverless deployments keep
  no override between invocations; use env vars there.
- **Durability of evidence:** the audit store is in memory and bounded (5 000
  events) on both servers. Export the `CONFIG_CHANGED` events (`/api/audit/export`)
  to retain them beyond a restart.
- **Who can read the evidence:** `/api/audit/*` has no auth (see "Known gap" in
  [API_CONTRACTS.md](API_CONTRACTS.md)). The evidence holds no secrets: secret
  values are never configuration that this service changes, and audit payloads
  are sanitised.

## Complexity

A change is O(1) plus one O(1) audit append. `GET /api/ops/config` is O(F) for
F declared flags. Space is O(F) overrides.

## Tests

```bash
cd backend && node --import tsx --test tests/admin-config-audit.test.ts
```
