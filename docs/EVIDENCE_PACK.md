# Testnet evidence pack

The public demo needs a set of real, verifiable Stellar **Testnet** transactions
showing the verification flow end to end. This document covers how that evidence
is produced and refreshed.

## Why it is generated, not hand-written

SDF periodically wipes Testnet. Any transaction hash recorded by hand eventually
stops resolving in the explorer, so a checked-in "evidence pack" silently rots
and the demo ends up showing dead links at exactly the moment a reviewer tries
to verify it.

The pack is therefore produced from live Testnet by
[`scripts/generate-evidence-pack.ts`](../scripts/generate-evidence-pack.ts).

## Regenerating

From the `backend` directory (the Stellar SDK is installed there):

```bash
cd backend
npm run evidence:pack
```

The script:

1. creates fresh keypairs and funds them via
   [friendbot](https://friendbot.stellar.org/) — no secrets or funded accounts of
   your own are needed;
2. waits for the accounts to become usable on Horizon;
3. creates the issued asset the asset scenario pays with;
4. pays one real invoice per scenario, each with a **unique memo**;
5. verifies every payment the way the product verifies it (successful
   transaction, correct destination, correct amount, memo present);
6. writes:
   - `evidence/evidence-pack.json` — the versioned machine-readable pack,
   - `evidence/EVIDENCE.generated.md` — the reviewer-facing sheet with explorer
     links.

It exits non-zero if any scenario fails verification, so a broken pack cannot be
published by accident.

### Scenarios covered

| Scenario | What it demonstrates |
| --- | --- |
| `xlm-payment` | Native XLM payment, memo on the transaction |
| `issued-asset-payment` | Payment in a Stellar-issued asset (`asset_code` + `asset_issuer`) |
| `memo-variant` | A second memo shape, proving the memo is what ties a payment to an invoice |

## Refreshing after a Testnet reset

A reset invalidates every recorded hash. When that happens:

1. **Confirm the reset.** Open any explorer link from
   `evidence/EVIDENCE.generated.md`; a 404/expired-transaction page means the
   pack is dead.
2. **Regenerate.**
   ```bash
   cd backend && npm run evidence:pack
   ```
3. **Verify freshness.**
   ```bash
   cd backend && npm run evidence:check
   ```
   This exits non-zero when the pack is missing, older than 30 days, captured on
   the wrong network, missing a required scenario, or containing an unverified
   entry.
4. **Redeploy the demo** so the public surface shows the new pack, and update
   [`EVIDENCE.md`](../EVIDENCE.md) (the hand-authored checklist) to point at the
   generated sheet and record the new source revision.

## Keeping the demo from serving stale evidence

`npm run evidence:check` is the guard. Run it:

- in CI on a schedule (weekly is enough given the 30-day window), and
- as a pre-deploy step for the public demo.

When it fails, the demo should be treated as unverified rather than quietly
showing the old pack — either regenerate or take the demo down. Wiring this into
a workflow is deliberately left to the maintainers; the script exits with a
non-zero status and an actionable message either way.

## Pack format

```jsonc
{
  "version": 1,                  // bump when the shape changes
  "network": "TESTNET",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "ledgerAtCapture": 4242424,    // fingerprint of the Testnet instance used
  "generatedAt": "2026-09-27T01:30:00.000Z",
  "entries": [
    {
      "scenario": "xlm-payment",
      "invoiceId": "evidence-xlm-payment",
      "memo": "EVIDA1B2C3D4",
      "asset": "XLM",
      "amount": "12.5000000",
      "sellerPublicKey": "G…",
      "payerPublicKey": "G…",
      "paymentTxHash": "…",
      "ledger": 4242425,
      "verified": true,
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/…",
      "capturedAt": "2026-09-27T01:30:00.000Z"
    }
  ]
}
```

`ledgerAtCapture` is what makes a Testnet reset detectable even before a link
404s: if the live ledger is far below the captured one, the network was reset
and the pack must be regenerated.

The throwaway testnet accounts in the pack carry no value. Secrets are never
required and never written.

Related: [`EVIDENCE.md`](../EVIDENCE.md) · [`docs/VERIFY.md`](VERIFY.md) ·
[`docs/RUNBOOK.md`](RUNBOOK.md)
