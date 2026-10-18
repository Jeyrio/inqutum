# Business rule policy

Limits that sellers run into are defined once in
`backend/src/domain/policy.ts` and evaluated there. The create invoice schema
reads its amount cap from it.

## Rules and defaults

| Rule | Default | Env override | Denial code |
| ---- | ------- | ------------ | ----------- |
| Minimum invoice amount | `0.0000001` (one stroop) | `POLICY_MIN_INVOICE_AMOUNT` | `AMOUNT_TOO_LOW` |
| Maximum invoice amount (inclusive) | `1000000000` | `POLICY_MAX_INVOICE_AMOUNT` | `AMOUNT_TOO_HIGH` |
| Accepted assets | any | `POLICY_ALLOWED_ASSETS` (comma separated) | `ASSET_NOT_ALLOWED` |
| Expiry window (whole days) | same as `invoice-expiry.ts` | none | `EXPIRY_OUT_OF_RANGE` |

`loadPolicy()` applies the overrides. An unset, non numeric or non positive
value falls back to the default rather than disabling the rule.

## Using it

```ts
const decision = evaluateInvoiceRequest({ amount, assetCode, expiresInDays }, loadPolicy());
if (!decision.allowed) return res.status(400).json({ success: false, code: decision.code, error: decision.message });
```

Denials return a stable `code` and a message that is safe to show a user. The
first failing rule wins, in the order amount, asset, expiry.

## Boundaries

Amounts at exactly the minimum and maximum are allowed. Fractional expiry days
are rejected.

## Tests

```bash
cd backend && node --import tsx --test tests/policy.test.ts
```
