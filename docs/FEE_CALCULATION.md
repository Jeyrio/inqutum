# Deterministic fee calculation (#198)

One module owns fee math and explains every line.

- Module: `backend/src/domain/fee-calculation.ts`
- Quote route: `POST /api/fees/quote` with `{ "amount": "200", "assetCode": "USDC" }`
- Config: `FEE_SCHEDULE_JSON` (unset = **no platform fee**, so existing deployments behave exactly as before)
- Tests: `cd backend && node --import tsx --test tests/fee-calculation.test.ts`

## Rules

- No floating point. Amounts are `bigint` minor units at the asset's precision
  (default 7 decimals, max 7) and formatted back to decimal strings.
- Each `PERCENT` line is rounded on its own (`HALF_UP` default, `FLOOR`, `CEIL`),
  so the printed lines always sum to the printed total.
- `minimumFee` adds a visible `MINIMUM_FEE_ADJUSTMENT` line when the lines fall
  short of the floor.
- `net = gross − fee`. A fee larger than the amount is `FEE_EXCEEDS_AMOUNT`.
- No clock, no randomness: the same `(schedule, amount, asset)` gives the same
  breakdown and `fingerprint` (SHA-256 of the canonical breakdown).

## Schedule

```json
{
  "version": "2026-10",
  "minimumFee": "0.5",
  "lines": [
    { "code": "PLATFORM", "label": "Platform fee", "kind": "PERCENT", "basisPoints": 125, "rounding": "HALF_UP" },
    { "code": "PROCESSING", "label": "Processing", "kind": "FLAT", "amount": "0.25" }
  ]
}
```

Codes are `UPPER_SNAKE_CASE` and unique. A malformed schedule is a 500
`INVALID_FEE_SCHEDULE` (an operator error, not a caller error).

## Breakdown

```json
{
  "breakdownVersion": 1, "scheduleVersion": "2026-10", "assetCode": "USDC", "precision": 7,
  "grossAmount": "200.0000000",
  "lines": [{ "code": "PLATFORM", "kind": "PERCENT", "amount": "2.5000000",
    "explanation": "1.25% (125 bp) of 200.0000000 USDC, rounded half up to 7 decimals", "label": "Platform fee" }],
  "totalFee": "2.7500000", "netAmount": "197.2500000", "fingerprint": "…"
}
```

Errors (400): `INVALID_AMOUNT`, `INVALID_ASSET_PRECISION`, `AMOUNT_PRECISION_EXCEEDED`
(more decimals than the asset allows, e.g. `1.00000001` on a 7-decimal asset),
`FEE_EXCEEDS_AMOUNT`.

## Matching stored settlements

Persist `toSettlementFeeRecord(breakdown)` with the settlement and check later
with `verifyFeeBreakdown(recomputed, stored)`. It compares amounts as minor
units (`"2.75"` equals `"2.7500000"`), plus `scheduleVersion` and `fingerprint`
when stored, and returns the names of the fields that differ.

## Not included

The quote endpoint and module are available, but invoice creation and
`verify` do not yet charge or store fees: the default schedule is zero and no
settlement column exists today. Storing the record on settlement is the next
step and needs a schema change, which this change deliberately avoids.
