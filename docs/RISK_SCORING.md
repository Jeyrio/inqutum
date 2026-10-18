# Explainable risk scoring for high-impact actions

High-impact maintainer actions (`invoice.cancel`, `job.requeue_dead`) go through
the signed intent flow in `backend/src/ops/maintainer-approval.ts`. Since issue
#312, every intent is scored when it is declared
(`backend/src/ops/risk-scoring.ts`). The score is explained factor by factor,
and the score decides how much authorization the action needs.

## Factors

All behavioural factors count events inside a sliding window (default 10 minutes).

| Code | Measures | Allowance | Weight |
|------|----------|-----------|--------|
| `ACTION_BASELINE` | Inherent impact | n/a | 25 for two-person actions, 10 otherwise |
| `REQUESTER_VELOCITY` | Intents declared by the same maintainer | 5 | +10 each beyond the allowance, max 40 |
| `TARGET_REPETITION` | Intents against the same target, from any maintainer | 1 | +15 each beyond the allowance, max 30 |
| `RECENT_FAILURES` | The requester's intents that failed or were rejected | 0 | +10 each, max 30 |

The score is the sum of the factors, capped at 100. The assessment lists only
factors with a non-zero weight, each with `observed`, `allowance` and a
readable `detail`.

## Levels and enforcement

| Level | Score | Effect |
|-------|-------|--------|
| `low` | 0–29 | Normal flow |
| `elevated` | 30–49 | Normal flow. The approver sees the factors. |
| `high` | 50–79 | A second, different maintainer must approve, even for single-approver actions (`APPROVAL_REQUIRED`, then `SELF_APPROVAL` for the requester). |
| `critical` | ≥ 80 | Refused with `403 RISK_BLOCKED`. The intent is stored as `rejected`, and a signed `rejected` receipt records the score and factor codes. |

The caps make it impossible for a single behavioural factor to block on its
own: velocity alone tops out at `high`. A block needs at least two independent
signals, for example repeated attempts on one target plus peer rejections.

## Where the assessment appears

- `POST /api/ops/intents` and `GET /api/ops/intents`: `data.risk`.
- Every receipt (`GET /api/ops/receipts`): `risk`, inside the signed payload.
- The audit event `MAINTAINER_ACTION`: `metadata.riskScore`, `riskLevel`, `riskFactors`.

The assessment is part of the intent's HMAC payload. Editing the score, level
or `requiresSecondApprover` after declaration fails verification
(`INTENT_TAMPERED`).

## Normal, failure, retry and authorization paths

- **Normal:** a first intent scores its baseline only, which is `low`.
- **Retry:** each failed execution and each rejection counts against the
  requester, and each retry counts against the target. A retry storm on one
  job goes low → low → elevated → high, at which point a second approver is required.
- **Failure:** a refused intent is recorded too. Retrying while blocked keeps
  the score high, so the block lasts until a full window (10 minutes) passes
  with no new attempts.
- **Authorization:** escalation never weakens existing rules. Two-person
  actions still need approval at every level, and self-approval is always refused.

## Operational edge cases

- **Process restart:** history is in memory, like the intents themselves, so a
  restart resets all scores to their baselines. Receipts already forwarded to
  the audit store keep the scores they recorded.
- **Multiple API instances:** each instance scores its own traffic. Run
  maintainer actions against one instance, or pass a shared-store scorer with
  the same `assess` / `recordIntent` / `recordFailure` methods via the `risk` option.
- **Shared maintainer IDs:** velocity is keyed by `requestedBy`. Distinct
  maintainers should use distinct IDs.
- **Clock jumps:** the scorer uses the service clock (`now`). A backwards jump
  briefly keeps events in the window longer. Nothing is lost.

## Complexity

Each key (requester, target) keeps a queue of timestamps capped at 64 entries.
Weights saturate long before the cap, so trimming is lossless for scoring.
Pruning, scoring and recording are O(1) per call (bounded by the cap). Memory
is O(active keys × 64). Emptied keys are deleted when touched, and a full
sweep runs every 1,000 records, keeping stale-key cleanup amortised O(1).

## Rollback and compatibility

`intent.risk` and `receipt.risk` are new fields. Existing fields and error
codes are unchanged. Construct the service with `risk: null` to restore the
pre-#312 behaviour exactly: no scoring, `risk: null` on intents and receipts.
Receipts signed before the change verify unchanged, because the field is
absent from their payload.
