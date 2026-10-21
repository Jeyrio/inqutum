# Signed administrative action approvals (#196)

High-impact maintainer actions run only with valid, unused, signed approvals.

- Module: `backend/src/ops/signed-approval.ts`
- Routes: `POST /api/ops/signed-approvals` (issue), plus the protected routes that consume them
- Enable: set `SIGNED_APPROVAL_SECRET` (16+ chars, ideally 32+, separate from other secrets). Unset → `403 SIGNED_APPROVALS_DISABLED`; protected routes fail closed.
- Tests: `cd backend && node --import tsx --test tests/signed-approval.test.ts tests/ops-protected-routes.test.ts`

This sits next to `maintainer-approval.ts` (long-lived intent → approve →
execute workflow with receipts). Use that for a tracked request; use this to
gate a single call with portable proof of approval.

## Protected actions

| Action | Signers | Max approval lifetime |
|--------|---------|-----------------------|
| `invoice.cancel` | 1 | 30 min |
| `invoice.archive` | 1 | 30 min |
| `invoice.restore` | 1 | 30 min |
| `job.requeue_dead` | 1 | 15 min |
| `config.change` | 2 | 15 min |
| `ownership.transfer` | 2 | 60 min |

Actions needing 2 signers are the multi-step confirmation: two *different*
maintainers must each issue an approval. Add actions in `PROTECTED_ACTIONS`.

## Approval document

```json
{
  "id": "uuid (single use)",
  "action": "invoice.archive", "target": "inv-123", "paramsHash": "sha256 of canonical params",
  "actor": "alice",        // the only maintainer who may execute with it
  "signer": "bob",         // who approved; never the actor
  "reason": "Quarterly cleanup (min 10 chars)",
  "issuedAt": "…", "expiresAt": "…",
  "signature": "HMAC-SHA256 over the canonical fields above"
}
```

## Flow

```bash
# bob approves alice's archive (admin token identifies the caller to the route)
curl -X POST $API/ops/signed-approvals -H "Authorization: Bearer $ADMIN" \
  -d '{"action":"invoice.archive","target":"inv-123","actor":"alice","signer":"bob","reason":"Quarterly cleanup of settled invoices"}'

# alice executes, presenting the approval
curl -X POST $API/ops/invoices/inv-123/archive -H "Authorization: Bearer $ADMIN" \
  -d '{"actor":"alice","reason":"Quarterly cleanup of settled invoices","approvals":[{…approval…}]}'
```

## Verification order and errors

| Code | HTTP | Meaning |
|------|------|---------|
| `APPROVAL_REQUIRED` | 403 | none presented, or fewer distinct signers than the action needs |
| `APPROVAL_SIGNATURE_INVALID` | 403 | forged, edited or signed with another secret |
| `APPROVAL_ACTION_MISMATCH` / `_TARGET_MISMATCH` / `_PARAMS_MISMATCH` | 403 | approved for something else |
| `APPROVAL_ACTOR_MISMATCH` | 403 | presented by someone other than the named actor |
| `APPROVAL_EXPIRED` | 410 | past `expiresAt` |
| `APPROVAL_SELF_SIGNED` | 403 | signer equals actor |
| `APPROVAL_DUPLICATE_SIGNER` | 403 | the same signer twice in a multi-step action |
| `APPROVAL_REPLAYED` | 409 | already used |

All approvals are checked before any is consumed, so a rejected request burns
nothing. Once checked, approvals are burned *before* the executor runs, and
stay burned if the executor fails: retry needs a fresh approval. Every
issue/reject/execute is written to the audit trail (`APPROVAL_ISSUED`,
`APPROVAL_REJECTED`, `PROTECTED_ACTION_EXECUTED`, `PROTECTED_ACTION_FAILED`).

## Trust model and limits

- The route authenticates `signer` with the admin bearer token; the HMAC proves
  the server issued the approval and nothing was edited afterwards. It does not
  by itself prove *which human* held the token — per-maintainer credentials are
  a separate concern.
- Used-approval tracking is in memory. Run a single API process, or inject a
  shared `ApprovalUseStore`, otherwise a replay could succeed against a second
  instance. A restart forgets used ids, but approvals are short-lived and
  expired ones are rejected regardless.
- Rotate `SIGNED_APPROVAL_SECRET` to invalidate every outstanding approval.
