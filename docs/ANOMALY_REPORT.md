# Anomaly detection report (#195)

A read-only report that surfaces unusual volume, timing and actor behaviour
from the audit trail before it turns into an incident or abuse.

- Module: `backend/src/ops/anomaly-report.ts` (pure; no clock, no writes)
- Route: `GET /api/ops/anomalies?hours=24` (admin bearer token, same as `/api/ops/*`)
- Fixtures: `backend/tests/fixtures/anomaly-activity.fixture.ts`
- Tests: `cd backend && node --import tsx --test tests/anomaly-report.test.ts tests/ops-protected-routes.test.ts`

The report never changes state. Identical input yields an identical report, in
the same order, with the same finding ids, regardless of input ordering.

## Signals

| Signal | Fires when | Default threshold |
|--------|------------|-------------------|
| `VOLUME_SPIKE` | a resource's hourly event count is far above the rest of its own history | max(20, 5 × median, median + 6 × 1.4826 × MAD), needs 6 other hourly buckets |
| `TIMING_BURST` | one actor sends many events to one resource within seconds | 8 events in 10 s |
| `ACTOR_REPETITION` | one actor repeats the same action on one resource | 12 times in 1 h |
| `ACTOR_FANOUT` | one actor touches many distinct resources in a short window | 10 resources in 10 min |
| `REPEATED_FAILURE` | one actor fails again and again against one resource (a success resets the run) | 5 consecutive failures |

Failures are read from the audit trail: an action name containing `BLOCKED`,
`REJECTED`, `FAILED` or `DENIED`, or `metadata.outcome` of `failed`/`rejected`/
`denied`/`blocked`.

## Output

```json
{
  "generatedFor": { "from": "...", "to": "...", "records": 118 },
  "summary": { "critical": 1, "high": 0, "medium": 1, "low": 0, "total": 2 },
  "findings": [{
    "id": "9f1c…", "signal": "REPEATED_FAILURE", "severity": "medium",
    "resource": "invoice:inv-42", "actors": ["client-x"],
    "observed": 7, "threshold": 5, "baseline": null,
    "windowStart": "…", "windowEnd": "…",
    "explanation": "7 consecutive failures by client-x against invoice:inv-42.",
    "triage": "Read the failure reasons on the evidence events…",
    "evidence": ["evt-00073", "…"]
  }],
  "bySeverity": { "critical": [], "high": [], "medium": [], "low": [] },
  "byResource": [{ "resource": "invoice:inv-42", "worstSeverity": "medium", "findings": [] }],
  "suppressed": [],
  "ignoredActors": {}
}
```

Severity is the ratio `observed / threshold`: below 1.5 `low`, 1.5 `medium`,
2.5 `high`, 4 `critical`. `evidence` holds up to 10 audit event ids to look up
in `GET /api/audit`.

## Triage

1. **Start at the top.** Work `critical` then `high`; `byResource` shows which
   resources are hit by several signals at once, which is the strongest hint.
2. **Open the evidence events** and answer: who (one actor or many), what
   (same action or different), and was it expected (import, deploy, month end)?
3. **Match by signal.**
   - `VOLUME_SPIKE` with many actors: usually real demand or an integration
     change. With one actor: treat like a burst.
   - `TIMING_BURST` / `ACTOR_REPETITION`: a script or retry loop. Confirm rate
     limits applied; contact the owner if it is a person.
   - `ACTOR_FANOUT`: possible enumeration. Check the actor was authorized for
     every resource touched; consider revoking the session.
   - `REPEATED_FAILURE`: read the failure reasons. Permission or validation
     errors mean a broken client; payment-verification rejections against
     someone else's invoice mean probing.
4. **Record the outcome.** Benign and recurring: add a suppression (below).
   Not benign: follow `docs/RUNBOOK.md` and use the normal maintainer actions
   (freeze window, impersonation end, invoice cancel via signed approval).

## False-positive mitigation

- **Absolute minimums.** No signal fires on a handful of events, however large
  the ratio. A quiet resource going from 1 to 12 events/hour is not a spike.
- **Robust baseline.** Spikes compare to the median and MAD of the *other*
  hourly buckets of the same resource, so a past spike does not hide a new one
  and one outlier does not inflate the baseline.
- **Enough history.** Spikes are not judged until a resource has 6 other
  hourly buckets (including empty hours).
- **Windowed repetition.** Repeating an action is only suspicious inside a
  window; a seller creating invoices all day is not flagged.
- **Automation allow-list.** `ignoreActors` drops known workers and monitors
  (e.g. `system`). The report returns `ignoredActors` with the count dropped, so
  the exclusion is visible.
- **Time-boxed, reasoned suppressions.** `{ signal, resource | "*", reason, until }`.
  A suppression without a reason, or past `until`, is inert. Suppressed findings
  are counted in `suppressed`, never silently discarded.
- **Tuning, not guessing.** Every threshold is an option
  (`createOpsRouter({ anomaly: { spikeMinCount: 40 } })`). Change one at a time
  and re-run against the fixtures.

## Limitations

The report reads the in-process audit store, which is bounded and cleared on
restart; it is a triage aid, not a long-term analytics system. Resources are
audit scopes (`invoice:<id>`, `system:<id>`), so activity that is not audited
is invisible to it.
