# Dry-run policy evaluator

`POST /api/ops/policy/dry-run` evaluates a proposed [business policy](POLICY.md)
against every stored invoice. It writes nothing. The response gives
dataset-wide totals and one page of the affected records.
Code: `backend/src/domain/policy-dry-run.ts`.

A record is **affected** when the current policy allows it and the proposed
policy denies it. Both decisions come from the same `evaluateInvoiceRequest()`
the policy module exposes, so the preview cannot disagree with enforcement.
Relaxations never count as affected.

## Request

```http
POST /api/ops/policy/dry-run
Authorization: Bearer <JOBS_ADMIN_TOKEN>
Content-Type: application/json

{ "proposedPolicy": { "maxAmount": 500, "allowedAssets": ["XLM"] }, "previewLimit": 25, "cursor": null }
```

| Field | Rule |
| --- | --- |
| `minAmount`, `maxAmount` | Positive, at most 7 decimals (one stroop = 0.0000001), at most 922337203685.4775807 (int64 stroops). |
| `minExpiryDays`, `maxExpiryDays`, `defaultExpiryDays` | Whole days, at least 1. |
| `allowedAssets` | Up to 100 Stellar asset codes (1–12 characters of `a-z A-Z 0-9`). Uppercased and de-duplicated, like `loadPolicy()`. `[]` means any asset. |
| merged result | `minAmount <= maxAmount` and `minExpiryDays <= defaultExpiryDays <= maxExpiryDays`. |
| `previewLimit` | Clamped to 1–100. Default 25. |
| `cursor` | `preview.nextCursor` from the previous page of the **same** proposal. |

Validation is strict. An unknown field (a typo such as `maxAmmount`), an empty
proposal or an inconsistent range returns 400 `INVALID_POLICY_PROPOSAL` and
lists every issue. A lenient check would return a false "no impact" instead.
Validation runs before any record is read.

## Response (`data`)

```json
{
  "dryRun": true,
  "proposalHash": "q3l…",
  "changes": [{ "field": "maxAmount", "from": 1000000000, "to": 500 }],
  "summary": {
    "totalEvaluated": 120,
    "totalAffected": 4,
    "affectedByStatus": { "PENDING": 2, "PAID": 1, "EXPIRED": 0, "CANCELLED": 1 },
    "affectedByRule": { "AMOUNT_TOO_HIGH": 4 },
    "pendingAtRisk": 2,
    "pendingVolumeAtRisk": { "XLM": "600.0000000", "USDC:GA…ISSUER": "700.0000000" },
    "sellersWithPendingAtRisk": 2
  },
  "preview": { "records": [{ "invoiceId": "…", "status": "PENDING", "asset": "XLM", "proposedOutcome": "AMOUNT_TOO_HIGH", "reason": "Amount must be at most 500.", "…": "…" }], "limit": 25, "hasMore": false, "nextCursor": null }
}
```

- **Totals cover the whole dataset** and are identical on every page.
  `preview.records` holds one page, newest first (`createdAt`, then `id`).
- **Volume is summed in integer stroops**, so `0.1 + 0.2` is `"0.3000000"`. It
  is keyed by asset identity: `XLM`, or `CODE:ISSUER`. Two `USDC` assets from
  different issuers are different assets and are never merged.
- **Expiry rules** use each invoice's original payment window,
  `round((expiresAt - createdAt) / 1 day)`.

## Paging and retries

- Follow `preview.nextCursor` until it is `null`. Each affected record appears
  exactly once. `hasMore` is always `nextCursor !== null`.
- A cursor is bound to `proposalHash`, a fingerprint of (current, proposed)
  policy. Sending it with a different proposal, or after the environment policy
  changed, returns 400 `INVALID_CURSOR`; restart from the first page. A tampered
  cursor returns the same error.
- Retrying a request with the same body and cursor returns the same page while
  the data is unchanged. The evaluation is pure, so retrying is always safe.
- Records created while you page sort ahead of the cursor and do not appear on
  later pages. Totals reflect the data at each request.

## Failure modes

| Situation | Response |
| --- | --- |
| No / wrong admin token | 401 `UNAUTHORIZED`; no `JOBS_ADMIN_TOKEN` configured → 403 |
| Invalid proposal | 400 `INVALID_POLICY_PROPOSAL` |
| Bad or foreign cursor | 400 `INVALID_CURSOR` |
| Storage cannot enumerate invoices | 503 `DRY_RUN_UNAVAILABLE`. The route fails closed; an empty dataset would falsely read as "no impact". |
| Storage read fails | Passed to the server error handler, which classifies the error (normally 500). Never reported as zero affected. |

## Rollback and relation to `/ops/policy/simulate`

A dry run changes nothing, so there is nothing to roll back. Applying a policy is
still an environment change (`POLICY_*` variables, see [POLICY.md](POLICY.md)).
Rolling it back means restoring the previous variables. Run the dry run for both
directions and keep both reports.

`POST /api/ops/policy/simulate` ([POLICY_SIMULATION_PREVIEW.md](POLICY_SIMULATION_PREVIEW.md))
is unchanged for existing callers. It returns every affected record in one
response and does not validate input. **Migration:** for new integrations, and
for large datasets, use the dry run. The simulate route will stay until its
callers have moved.

## Complexity

For N invoices, A allowed assets and preview size K:

- **Time:** one pass, O(N·A + N·log K) comparisons. Each preview insertion also
  moves up to K array elements, and K ≤ 100.
- **Extra space:** O(K + S + V) for S sellers and V asset identities at risk.
  The response stays bounded however many records are affected.

## Tests

```bash
cd backend && node --import tsx --test tests/policy-dry-run.test.ts
```
