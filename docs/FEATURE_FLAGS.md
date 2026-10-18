# Feature flags

Risky server behaviour ships behind a typed flag so it can be staged, compared
and switched off without shipping code. Definitions live in
`backend/src/config/feature-flags.ts`.

## Rules

- Each flag has a `safeDefault`, which is always the lower-risk behaviour. If
  the variable is unset, empty or unparseable (`yes`, `enabled`, typos), the
  flag uses that default.
- Accepted values: `true` / `1` / `on` and `false` / `0` / `off`
  (case-insensitive).
- Flags are checked **on the server** at the point of the sensitive decision.
  The client never sends or sees a flag that changes what it is allowed to do.
- Flags are read from the environment on every check. Changing one needs a
  process restart (`render.yaml` / Vercel env), not a rebuild.
- A maintainer can also override a flag at runtime, without a restart, through
  `PUT /api/ops/config/feature-flags/:flag`. The override needs a capability
  token and is audited (see [ADMIN_CONFIG_AUDIT.md](ADMIN_CONFIG_AUDIT.md)). It
  is process-local and lost on restart. The environment stays the durable value.
- `GET /api/health` reports the effective state under `features`.
- When a rollout is finished, delete the flag and the losing code path.

## Flags

| Flag | Env var | Default | Effect when on |
|------|---------|---------|----------------|
| `paymentAmountTolerance` | `FEATURE_PAYMENT_AMOUNT_TOLERANCE` | off | `POST /api/invoices/:id/verify` accepts a payment within ±1 stroop of the invoice amount (rounding between wallets and Horizon). Off requires an exact stroop match. |

## Rollout: `paymentAmountTolerance`

1. **Stage.** Set `FEATURE_PAYMENT_AMOUNT_TOLERANCE=true` on a testnet/preview
   deployment only, and restart.
2. **Verify.**
   - `curl -s $API/api/health | jq .features` shows
     `{"paymentAmountTolerance": true}`.
   - Verify a payment sent 0.0000001 over the invoice amount. It settles.
     A 0.0000002 difference still fails with `AMOUNT_MISMATCH`.
   - Compare `AMOUNT_MISMATCH` counts on `GET /api/observability/metrics`
     before and after.
3. **Promote.** Set the same variable in production and restart. Watch
   `AMOUNT_MISMATCH` and paid-invoice counts for a day.

## Emergency rollback

Without a restart: mint a `config.feature_flag.set` capability and send
`{"enabled": false, …}` to `PUT /api/ops/config/feature-flags/paymentAmountTolerance`
([ADMIN_CONFIG_AUDIT.md](ADMIN_CONFIG_AUDIT.md)). Then make it durable:

Set `FEATURE_PAYMENT_AMOUNT_TOLERANCE=false`, or delete the variable, and
restart the service. Confirm `features.paymentAmountTolerance` is `false` on
`/api/health`. No migration or data change is involved. Invoices already
settled under the tolerance stay `PAID`. Their `paymentTxHash` points to the
exact on-chain amount on Horizon.

## Adding a flag

1. Add an entry to `FEATURE_FLAGS` with a `safeDefault` that keeps today's
   behaviour.
2. Check it with `isFeatureEnabled('name')` in the server code that owns the
   decision.
3. Test both states (see `backend/tests/feature-flags.test.ts`) and add the
   variable to `env.example.txt`, `env.mvp.example` and `render.yaml`.
4. Add a row and a rollout section to this file.
