import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPENDENCY_MATRIX,
  capabilityStatus,
  classifyFailure,
  evaluateDependency,
  redactError,
  runDependencyChecks,
  validateMatrix,
  type DependencyId,
} from '../src/ops/dependency-degradation';

const FIXED = () => new Date('2026-10-16T00:00:00.000Z');

describe('dependency degradation matrix', () => {
  it('documents failure modes, fallbacks and a runbook for every critical dependency', () => {
    const ids = DEPENDENCY_MATRIX.map((d) => d.id).sort();
    assert.deepEqual(ids, ['email_provider', 'postgres', 'redis_queue', 'stellar_horizon']);
    assert.deepEqual(validateMatrix(), []);
  });

  it('validateMatrix flags leaky messages and wrong status codes', () => {
    const bad = [{
      ...DEPENDENCY_MATRIX[0],
      fallbacks: [{ capability: 'payment.verify' as const, mode: 'refuse' as const, httpStatus: 202 as const, code: 'X', userMessage: 'Error: ECONNREFUSED https://horizon' }],
    }];
    const problems = validateMatrix(bad);
    assert.ok(problems.some((p) => p.includes('leaks internals')));
    assert.ok(problems.some((p) => p.includes('refuse must be 503')));
  });

  it('classifies known failure signatures', () => {
    assert.equal(classifyFailure('stellar_horizon', 'Request failed with status 429'), 'HORIZON_RATE_LIMITED');
    assert.equal(classifyFailure('postgres', 'cannot execute INSERT in a read-only transaction'), 'DB_READ_ONLY');
    assert.equal(classifyFailure('redis_queue', 'READONLY You can\'t write against a read only replica'), 'QUEUE_READONLY');
    assert.equal(classifyFailure('email_provider', '535 authentication failed'), 'EMAIL_AUTH');
    assert.equal(classifyFailure('postgres', 'something odd'), 'UNCLASSIFIED');
  });

  it('marks slow but working dependencies degraded, not down', () => {
    const s = evaluateDependency('postgres', { ok: true, latencyMs: 5000 });
    assert.equal(s.state, 'degraded');
    assert.deepEqual(s.affectedCapabilities, []);
  });

  it('redacts credentials from probe errors', () => {
    const seed = 'S' + 'A'.repeat(55);
    const out = redactError(`connect postgres://app:hunter2@db:5432 failed password=abc ${seed}`);
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('abc'));
    assert.ok(!out.includes(seed));
  });

  it('treats a hung probe as down and missing probes as unknown', async () => {
    const report = await runDependencyChecks(
      { stellar_horizon: () => new Promise(() => {}), postgres: async () => ({ ok: true, latencyMs: 3 }) },
      { timeoutMs: 20, now: FIXED }
    );
    const by = Object.fromEntries(report.dependencies.map((d) => [d.id, d]));
    assert.equal(by.stellar_horizon.state, 'down');
    assert.equal(by.stellar_horizon.failureMode, 'HORIZON_TIMEOUT');
    assert.equal(by.postgres.state, 'healthy');
    assert.equal(by.redis_queue.state, 'unknown');
    assert.equal(report.overall, 'down');
  });

  it('a throwing probe is down with a classified failure mode', async () => {
    const report = await runDependencyChecks({ redis_queue: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:6379'); } }, { now: FIXED });
    const redis = report.dependencies.find((d) => d.id === 'redis_queue')!;
    assert.equal(redis.state, 'down');
    assert.equal(redis.failureMode, 'QUEUE_UNREACHABLE');
    assert.deepEqual(redis.affectedCapabilities.sort(), ['job.enqueue', 'notification.send']);
  });

  describe('user-safe fallback decisions', () => {
    const reportWith = async (down: DependencyId[]) =>
      runDependencyChecks(
        Object.fromEntries(DEPENDENCY_MATRIX.map((d) => [d.id, async () => (down.includes(d.id) ? { ok: false, error: 'ECONNREFUSED' } : { ok: true, latencyMs: 1 })])),
        { now: FIXED }
      );

    it('everything allowed when healthy', async () => {
      const r = await reportWith([]);
      assert.equal(capabilityStatus(r, 'payment.verify').allowed, true);
    });

    it('Horizon down defers verification (202) and never claims payment', async () => {
      const d = capabilityStatus(await reportWith(['stellar_horizon']), 'payment.verify');
      assert.equal(d.allowed, false);
      assert.equal(d.fallback?.mode, 'defer');
      assert.equal(d.fallback?.httpStatus, 202);
      assert.match(d.fallback!.userMessage, /unchanged/);
    });

    it('refuse beats defer when Postgres and Horizon are both down', async () => {
      const d = capabilityStatus(await reportWith(['stellar_horizon', 'postgres']), 'payment.verify');
      assert.equal(d.fallback?.mode, 'refuse');
      assert.equal(d.fallback?.httpStatus, 503);
      assert.equal(d.fallback?.dependency, 'postgres');
      assert.equal(d.fallback?.retryAfterSeconds, 15);
    });

    it('email outage does not block invoice creation', async () => {
      const r = await reportWith(['email_provider']);
      assert.equal(capabilityStatus(r, 'invoice.create').allowed, true);
      assert.equal(capabilityStatus(r, 'notification.send').fallback?.code, 'EMAIL_DEFERRED');
    });
  });
});
