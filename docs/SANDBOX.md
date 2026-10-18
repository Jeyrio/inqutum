# Sandbox mode

Sandbox mode swaps Horizon for a fake with fixed responses, so contributors
can exercise payment verification without network access, wallets or
credentials.

## Setup

```bash
cd backend
INQUTUM_SANDBOX=true node --import tsx --test tests/sandbox.test.ts
```

No `.env` is needed. `assertSandboxSafe()` refuses to run when
`STELLAR_NETWORK=PUBLIC` or when `SELLER_SECRET_KEY` is set.

## Adapter

`backend/src/sandbox/adapters.ts`: `SandboxHorizon` has `getTransaction` and
`verifyPayment` with the same shape as `StellarService`, backed by the
fixtures. Verification runs through the real `verifyHorizonPayment`, so
results match production rules.

## Scenarios

`backend/src/sandbox/fixtures.ts` holds one invoice (`SANDBOX_INVOICE`) and a
transaction per scenario:

| Scenario | Tx hash | Result |
| -------- | ------- | ------ |
| `success` | `1` x 64 | verified |
| `memo_mismatch` | `2` x 64 | `MEMO_MISMATCH` |
| `underpaid` | `3` x 64 | `AMOUNT_MISMATCH` |
| `wrong_destination` | `4` x 64 | `DESTINATION_MISMATCH` |
| `not_found` | `5` x 64 | `TRANSACTION_NOT_FOUND` |

## Limitations

- Only the transactions above exist; any other hash is not found.
- Streaming (`streamPayments`) and account lookups are not simulated.
- The sandbox does not start a server by itself. Tests and scripts wire the
  adapters in directly.
