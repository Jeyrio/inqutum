# Policy Simulation Preview

## Overview
In financial infrastructure, committing sudden business policy changes (such as lowering invoice caps, raising minimums, altering expiry windows, or removing supported Stellar assets) without prior simulation risks breaking in-flight transactions, stranding pending invoices, and alienating merchants.

The **Policy Simulation Preview** engine (Issue #267) allows maintainers to dry-run proposed business policy changes against live pending and stored invoice state prior to deployment.

> For validated proposals, expiry rules and bounded, paginated previews on large
> datasets, use the dry-run evaluator: [POLICY_DRY_RUN.md](POLICY_DRY_RUN.md).

## Simulation Capabilities

1. **Affected Records Preview**: Identifies specific stored invoices that were compliant under the current policy but would become non-compliant under the proposed policy.
2. **Affected Merchant Scoping**: Correlates impact to specific seller public keys and computes total balance volume at risk per asset.
3. **Rollback Constraints & Risk Level**: Classifies overall operational risk (`NONE`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) and generates explicit rollback and grandfathering guidance.
4. **Read-Only Invariant**: The simulation operates strictly on immutable snapshots with zero writes or database side effects.

## API Usage

Maintainers can trigger a policy simulation via the admin-scoped endpoint:

```http
POST /api/ops/policy/simulate
Authorization: Bearer <JOBS_ADMIN_TOKEN>
Content-Type: application/json

{
  "proposedPolicy": {
    "maxAmount": 500,
    "allowedAssets": ["XLM"]
  }
}
```

### Example Response:

```json
{
  "success": true,
  "data": {
    "riskLevel": "HIGH",
    "totalRecordsEvaluated": 120,
    "totalAffectedRecords": 4,
    "totalAffectedSellers": 2,
    "expectedSideEffects": {
      "pendingInvoicesAtRisk": 3,
      "volumeAtRiskByAsset": { "USDC": 1500, "XLM": 650 },
      "newlyDisallowedAssets": ["USDC"],
      "summary": "3 active pending invoice(s) across 2 seller(s) will become non-compliant."
    },
    "rollbackConstraints": [
      {
        "id": "PENDING_INVOICE_INVARIANCE",
        "severity": "WARNING",
        "description": "3 currently pending invoice(s) will fail policy compliance...",
        "reversible": false,
        "recommendedMitigation": "Enforce policy transition using a grandfathering cut-off timestamp (created_at >= migration_time)."
      }
    ]
  }
}
```

## Operational Edge Cases & Failure Modes

- **Unsettled Transactions in Deprecated Assets**: When removing an asset from `allowedAssets`, the simulation explicitly calculates the unpaid volume at risk and warns against cutover without a grace period.
- **Irreversible Cutover Failure**: If an operator commits a policy restriction without grandfathering, existing checkout pages for pending invoices fail verification.
- **Rollback Procedure**: Policy updates in Inqutum are managed via environment configuration variables (`POLICY_MIN_INVOICE_AMOUNT`, `POLICY_MAX_INVOICE_AMOUNT`, `POLICY_ALLOWED_ASSETS`). Rolling back requires restoring the prior environment variables; if invoices were expired prematurely during the window, recovery jobs can inspect the simulation audit log to identify affected records for seller notification.
