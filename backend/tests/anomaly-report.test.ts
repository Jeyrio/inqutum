/**
 * Anomaly detection report (#195): normal baseline, spike, repeated failure and
 * suspicious actor scenarios from fixtures, plus false-positive mitigations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { auditEventsToActivity, buildAnomalyReport, severityForRatio, type AnomalyReport } from '../src/ops/anomaly-report';
import {
  HOUR,
  T0,
  noisyWorker,
  normalBaseline,
  rec,
  repeatedFailure,
  resetFixtureIds,
  suspiciousActor,
  volumeSpike,
} from './fixtures/anomaly-activity.fixture';

const signals = (r: AnomalyReport) => r.findings.map((f) => f.signal).sort();

describe('anomaly report', () => {
  it('finds nothing in a normal baseline', () => {
    resetFixtureIds();
    const report = buildAnomalyReport(normalBaseline());
    assert.equal(report.summary.total, 0);
    assert.deepEqual(report.findings, []);
    assert.equal(report.generatedFor.records, 72);
  });

  it('flags a volume spike against the resource\'s own history', () => {
    resetFixtureIds();
    const report = buildAnomalyReport(volumeSpike());
    const spike = report.findings.filter((f) => f.signal === 'VOLUME_SPIKE');
    assert.equal(spike.length, 1);
    assert.equal(spike[0].resource, 'system:invoices');
    assert.equal(spike[0].windowStart, new Date(T0 + 12 * HOUR).toISOString());
    assert.equal(spike[0].observed, 63); // 60 injected + 3 baseline events in that hour
    assert.equal(spike[0].baseline, 3);
    assert.ok(spike[0].threshold >= 20 && spike[0].observed >= spike[0].threshold);
    assert.ok(spike[0].actors.length >= 12);
    assert.equal(spike[0].evidence.length, 10);
    assert.equal(report.bySeverity[spike[0].severity].includes(spike[0]), true);
  });

  it('flags repeated failures by one actor on one resource', () => {
    resetFixtureIds();
    const report = buildAnomalyReport(repeatedFailure());
    const f = report.findings.filter((x) => x.signal === 'REPEATED_FAILURE');
    assert.equal(f.length, 1);
    assert.deepEqual([f[0].actors, f[0].resource, f[0].observed], [['client-x'], 'invoice:inv-42', 7]);
    assert.match(f[0].explanation, /7 consecutive failures by client-x/);
    assert.equal(report.findings.some((x) => x.signal === 'VOLUME_SPIKE'), false);
  });

  it('does not count failures that a success interrupts', () => {
    resetFixtureIds();
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(rec(i * 60_000, 'client-y', 'invoice:inv-1', 'PAYMENT_VERIFY_REJECTED', i % 4 === 3 ? 'success' : 'failure'));
    assert.equal(buildAnomalyReport(rows).findings.some((f) => f.signal === 'REPEATED_FAILURE'), false);
  });

  it('flags a suspicious actor by burst timing and resource fan-out', () => {
    resetFixtureIds();
    const report = buildAnomalyReport(suspiciousActor());
    assert.deepEqual(signals(report), ['ACTOR_FANOUT', 'TIMING_BURST']);
    const fanout = report.findings.find((f) => f.signal === 'ACTOR_FANOUT')!;
    assert.deepEqual([fanout.actors, fanout.resource], [['scraper-1'], 'actor:scraper-1']);
    assert.equal(fanout.observed, 14);
    const burst = report.findings.find((f) => f.signal === 'TIMING_BURST')!;
    assert.deepEqual([burst.resource, burst.observed], ['invoice:inv-100', 9]);
  });

  it('flags the same action repeated by one actor', () => {
    resetFixtureIds();
    const rows = Array.from({ length: 12 }, (_, i) => rec(i * 240_000, 'bot-7', 'invoice:inv-9', 'INVOICE_READ'));
    const report = buildAnomalyReport(rows);
    assert.deepEqual(signals(report), ['ACTOR_REPETITION']);
  });

  it('groups by severity and by affected resource, worst first', () => {
    resetFixtureIds();
    const rows = [...volumeSpike(), ...repeatedFailure().filter((r) => r.actor === 'client-x'), ...suspiciousActor().filter((r) => r.actor === 'scraper-1')];
    const report = buildAnomalyReport(rows);
    assert.equal(report.summary.total, report.findings.length);
    assert.equal(report.summary.critical + report.summary.high + report.summary.medium + report.summary.low, report.summary.total);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    for (let i = 1; i < report.findings.length; i++) {
      assert.ok(rank[report.findings[i - 1].severity] <= rank[report.findings[i].severity]);
    }
    for (let i = 1; i < report.byResource.length; i++) {
      assert.ok(rank[report.byResource[i - 1].worstSeverity] <= rank[report.byResource[i].worstSeverity]);
    }
    assert.ok(report.byResource.some((g) => g.resource === 'invoice:inv-42' && g.findings.length === 1));
  });

  it('is deterministic and independent of input order', () => {
    resetFixtureIds();
    const rows = volumeSpike();
    const a = buildAnomalyReport(rows);
    const b = buildAnomalyReport([...rows].reverse());
    assert.deepEqual(a, b);
    assert.deepEqual(a.findings.map((f) => f.id), buildAnomalyReport(rows).findings.map((f) => f.id));
  });

  it('does not mutate its input', () => {
    resetFixtureIds();
    const rows = volumeSpike();
    const copy = structuredClone(rows);
    buildAnomalyReport(rows);
    assert.deepEqual(rows, copy);
  });
});

describe('false-positive mitigation', () => {
  it('does not judge spikes without enough history', () => {
    resetFixtureIds();
    const rows = Array.from({ length: 40 }, (_, i) => rec(i * 1000, `u${i % 10}`, 'system:invoices'));
    assert.equal(buildAnomalyReport(rows).findings.some((f) => f.signal === 'VOLUME_SPIKE'), false);
  });

  it('ignores known automation actors and reports how much it ignored', () => {
    resetFixtureIds();
    assert.equal(buildAnomalyReport(noisyWorker()).findings.some((f) => f.signal === 'VOLUME_SPIKE'), true);
    const report = buildAnomalyReport(noisyWorker(), { ignoreActors: ['system'] });
    assert.equal(report.summary.total, 0);
    assert.deepEqual(report.ignoredActors, { system: 120 });
  });

  it('suppresses with a stated reason, reports the suppression, and lets it lapse', () => {
    resetFixtureIds();
    const rows = volumeSpike();
    const lastTs = rows.map((r) => r.timestamp).sort().at(-1)!;
    const suppression = { signal: 'VOLUME_SPIKE' as const, resource: 'system:invoices', reason: 'Quarterly bulk import', until: new Date(Date.parse(lastTs) + HOUR).toISOString() };

    const active = buildAnomalyReport(rows, { suppressions: [suppression] });
    assert.equal(active.findings.some((f) => f.signal === 'VOLUME_SPIKE'), false);
    assert.deepEqual(active.suppressed, [{ signal: 'VOLUME_SPIKE', resource: 'system:invoices', reason: 'Quarterly bulk import', count: 1 }]);

    const lapsed = buildAnomalyReport(rows, { suppressions: [suppression], now: new Date(Date.parse(lastTs) + 2 * HOUR) });
    assert.equal(lapsed.findings.some((f) => f.signal === 'VOLUME_SPIKE'), true);
    assert.deepEqual(lapsed.suppressed, []);

    const noReason = buildAnomalyReport(rows, { suppressions: [{ ...suppression, reason: ' ' }] });
    assert.equal(noReason.findings.some((f) => f.signal === 'VOLUME_SPIKE'), true);
  });

  it('keeps quiet resources quiet: a handful of events is never a spike', () => {
    resetFixtureIds();
    const rows = [...Array.from({ length: 10 }, (_, h) => rec(h * HOUR, 'a', 'invoice:quiet')), ...Array.from({ length: 12 }, (_, i) => rec(11 * HOUR + i * 60_000, 'b', 'invoice:quiet'))];
    assert.equal(buildAnomalyReport(rows).findings.some((f) => f.signal === 'VOLUME_SPIKE'), false);
  });

  it('skips records with unparseable timestamps instead of failing', () => {
    resetFixtureIds();
    const bad = { ...rec(0, 'a', 'x'), timestamp: 'not-a-date' };
    assert.equal(buildAnomalyReport([bad]).generatedFor.records, 0);
  });

  it('scales severity with how far past the threshold the signal is', () => {
    assert.deepEqual([1, 1.5, 2.5, 4].map(severityForRatio), ['low', 'medium', 'high', 'critical']);
  });
});

describe('audit event adapter', () => {
  it('normalizes audit events and detects failures from action or outcome', () => {
    const base = { timestamp: '2026-10-20T00:00:00.000Z', actor: { type: 'maintainer' as const, id: 'm1' }, scope: { entityType: 'invoice' as const, entityId: 'inv-1' } };
    const out = auditEventsToActivity([
      { ...base, id: '1', action: 'INVOICE_CREATED' },
      { ...base, id: '2', action: 'IMPERSONATION_ACTION_BLOCKED' },
      { ...base, id: '3', action: 'MAINTAINER_ACTION', metadata: { outcome: 'failed' } },
    ]);
    assert.deepEqual(out.map((r) => r.outcome), ['success', 'failure', 'failure']);
    assert.equal(out[0].resource, 'invoice:inv-1');
    assert.equal(out[0].actor, 'm1');
  });
});
