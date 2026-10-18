/**
 * Audit evidence for administrative configuration changes (#292), including
 * the capability-gated HTTP flow (#285) through the real ops router.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { AdminConfigError, AdminConfigService } from '../src/config/admin-config';
import { featureFlagOverrides, isFeatureEnabled } from '../src/config/feature-flags';
import { auditStore, type AuditEvent } from '../src/audit/audit-service';
import { CapabilityTokenService } from '../src/security/capability-tokens';
import { createOpsRouter } from '../src/routes/ops.routes';
import { correlationMiddleware } from '../src/observability/telemetry';

const FLAG = 'paymentAmountTolerance';
const REASON = 'Incident 42: disable tolerance while Horizon rounding is investigated';
const ADMIN = 'admin-config-audit-admin-token';
const SECRET = 'admin-config-audit-capability-secret-0123';

/** A private override layer so service tests never touch the process flags. */
function localOverrides() {
  const map = new Map<string, boolean>();
  return {
    get: (flag: string) => map.get(flag),
    set: (flag: string, value: boolean | null) => (value === null ? map.delete(flag) : map.set(flag, value)),
  } as typeof featureFlagOverrides;
}

const change = (service: AdminConfigService, overrides: Partial<Parameters<AdminConfigService['setFeatureFlag']>[0]> = {}) =>
  service.setFeatureFlag({
    flag: FLAG,
    enabled: true,
    reason: REASON,
    expectedVersion: service.snapshot().version,
    actorId: 'maintainer-alice',
    capabilityId: 'cap-1',
    correlationId: 'corr-1',
    ...overrides,
  });

function rejectsWith(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AdminConfigError);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, status);
    return true;
  });
}

describe('admin config — evidence for every change (#292)', () => {
  beforeEach(() => auditStore.clear());

  it('reports environment values, their source and version 0 before any change', () => {
    const service = new AdminConfigService({ overrides: localOverrides(), env: { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' } });
    const snapshot = service.snapshot();
    assert.equal(snapshot.version, 0);
    assert.deepEqual(snapshot.featureFlags.find((f) => f.flag === FLAG), {
      flag: FLAG,
      env: 'FEATURE_PAYMENT_AMOUNT_TOLERANCE',
      description: snapshot.featureFlags[0].description,
      effective: true,
      source: 'environment',
      override: null,
    });
  });

  it('records a hash-chained CONFIG_CHANGED event with actor, reason, before/after and capability id', () => {
    const service = new AdminConfigService({ overrides: localOverrides(), env: {} });
    const result = change(service);

    assert.equal(result.changed, true);
    assert.equal(result.version, 1);
    assert.equal(result.flag.effective, true);
    assert.equal(result.flag.source, 'override');

    const [event] = auditStore.queryEvents({ action: 'CONFIG_CHANGED' }).events;
    assert.equal(event.id, result.auditEventId);
    assert.equal(event.hash, result.auditEventHash);
    assert.deepEqual(event.actor, { type: 'maintainer', id: 'maintainer-alice', ip: undefined, userAgent: undefined });
    assert.deepEqual(event.scope, { entityType: 'config', entityId: `featureFlags.${FLAG}` });
    assert.equal(event.reason, REASON);
    assert.equal(event.correlationId, 'corr-1');
    assert.deepEqual(event.beforeState, { enabled: false, source: 'environment', override: null, configVersion: 0 });
    assert.deepEqual(event.afterState, { enabled: true, source: 'override', override: true, configVersion: 1 });
    // The capability id must survive log sanitisation (keys containing "token" are redacted).
    assert.deepEqual(event.metadata, {
      configKey: `featureFlags.${FLAG}`,
      envVar: 'FEATURE_PAYMENT_AMOUNT_TOLERANCE',
      change: 'override_set',
      capabilityId: 'cap-1',
    });
    assert.equal(auditStore.verifyChain().valid, true);
  });

  it('rolls back by clearing the override: a new forward version, the environment value applies again', () => {
    const service = new AdminConfigService({ overrides: localOverrides(), env: {} });
    change(service, { enabled: true });
    const rollback = change(service, { enabled: null, capabilityId: 'cap-2' });

    assert.equal(rollback.version, 2);
    assert.deepEqual(
      { effective: rollback.flag.effective, source: rollback.flag.source, override: rollback.flag.override },
      { effective: false, source: 'environment', override: null }
    );
    const events = auditStore.queryEvents({ action: 'CONFIG_CHANGED' }).events;
    assert.equal(events.length, 2, 'history is appended, never rewritten');
    assert.equal(events[0].metadata?.change, 'override_cleared');
  });

  it('treats a request that changes nothing as a no-op: no version bump and no event', () => {
    const service = new AdminConfigService({ overrides: localOverrides(), env: {} });
    change(service, { enabled: false });
    const noop = change(service, { enabled: false });

    assert.equal(noop.changed, false);
    assert.equal(noop.version, 1);
    assert.equal(noop.auditEventId, null);
    assert.equal(auditStore.queryEvents({ action: 'CONFIG_CHANGED' }).total, 1);
  });

  it('does not apply a change whose evidence cannot be written, and the retry succeeds', () => {
    let sinkUp = false;
    const overrides = localOverrides();
    const service = new AdminConfigService({
      overrides,
      env: {},
      recordAudit: (event) => {
        if (!sinkUp) throw new Error('audit store unavailable');
        return auditStore.recordEvent(event);
      },
    });

    rejectsWith(() => change(service), 'CONFIG_AUDIT_UNAVAILABLE', 503);
    assert.equal(overrides.get(FLAG), undefined, 'state is untouched');
    assert.equal(service.snapshot().version, 0);

    sinkUp = true;
    assert.equal(change(service).version, 1);
    assert.equal(overrides.get(FLAG), true);
  });

  it('refuses stale versions so concurrent maintainers cannot overwrite each other', () => {
    const service = new AdminConfigService({ overrides: localOverrides(), env: {} });
    change(service, { expectedVersion: 0 });
    rejectsWith(() => change(service, { enabled: false, expectedVersion: 0 }), 'CONFIG_VERSION_CONFLICT', 409);
    assert.equal(service.snapshot().featureFlags[0].effective, true);
  });

  it('validates the flag, value, reason and expected version', () => {
    const service = new AdminConfigService({ overrides: localOverrides(), env: {} });
    rejectsWith(() => change(service, { flag: 'noSuchFlag' }), 'UNKNOWN_FEATURE_FLAG', 404);
    rejectsWith(() => change(service, { flag: '__proto__' }), 'UNKNOWN_FEATURE_FLAG', 404);
    rejectsWith(() => change(service, { enabled: 'true' }), 'INVALID_CONFIG_CHANGE', 400);
    rejectsWith(() => change(service, { enabled: undefined }), 'INVALID_CONFIG_CHANGE', 400);
    rejectsWith(() => change(service, { reason: 'because' }), 'INVALID_CONFIG_CHANGE', 400);
    rejectsWith(() => change(service, { expectedVersion: '0' }), 'INVALID_CONFIG_CHANGE', 400);
    rejectsWith(() => change(service, { expectedVersion: -1 }), 'INVALID_CONFIG_CHANGE', 400);
    assert.equal(auditStore.size(), 0, 'rejected changes leave no evidence because nothing changed');
  });
});

describe('admin config — HTTP flow with capability tokens (#285, #292)', () => {
  let server: Server;
  let base: string;
  let config: AdminConfigService;
  let capabilities: CapabilityTokenService;
  let failAudit = false;

  before(async () => {
    capabilities = new CapabilityTokenService({ secret: SECRET });
    // Real process override layer: proves the change reaches isFeatureEnabled().
    config = new AdminConfigService({
      env: {},
      recordAudit: (event) => {
        if (failAudit) throw new Error('audit store unavailable');
        return auditStore.recordEvent(event);
      },
    });
    const app = express();
    app.use(correlationMiddleware());
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: {} as any, adminToken: ADMIN, approvals: null, capabilities, adminConfig: config }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    featureFlagOverrides.set(FLAG, null);
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => auditStore.clear());
  afterEach(() => (failAudit = false));

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mint = async (target = FLAG, subject = 'maintainer-alice') => {
    const res = await call('POST', '/ops/capabilities', { action: 'config.feature_flag.set', target, subject, ttlSeconds: 120 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data as { token: string; capabilityId: string; expiresAt: string };
  };

  const setFlag = (token: string | undefined, body: Record<string, unknown>, flag = FLAG) =>
    call('PUT', `/ops/config/feature-flags/${flag}`, body, token ? { 'x-capability-token': token } : {});

  it('issues a capability and records CAPABILITY_ISSUED evidence without the token itself', async () => {
    const issued = await mint();
    const [event] = auditStore.queryEvents({ action: 'CAPABILITY_ISSUED' }).events;

    assert.equal(event.actor.id, 'maintainer-alice');
    assert.equal(event.metadata?.capabilityId, issued.capabilityId);
    assert.ok(!JSON.stringify(event).includes(issued.token), 'the bearer token is never written to the audit trail');
  });

  it('changes a flag end to end: capability -> evidence -> effective immediately -> rollback', async () => {
    const version = (await call('GET', '/ops/config')).body.data.version;
    const issued = await mint();
    const res = await setFlag(issued.token, { enabled: true, reason: REASON, expectedVersion: version });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.changed, true);
    assert.equal(isFeatureEnabled(FLAG), true, 'verification reads the override on its next check');

    const [event] = auditStore.queryEvents({ action: 'CONFIG_CHANGED' }).events as AuditEvent[];
    assert.equal(event.actor.id, 'maintainer-alice', 'actor comes from the capability subject');
    assert.equal(event.metadata?.capabilityId, issued.capabilityId);
    assert.ok(res.body.correlationId && event.correlationId === res.body.correlationId);

    const rollback = await setFlag((await mint()).token, { enabled: null, reason: 'Rollback: incident 42 resolved', expectedVersion: version + 1 });
    assert.equal(rollback.status, 200);
    assert.equal(isFeatureEnabled(FLAG), false);
    assert.equal((await call('GET', '/ops/config')).body.data.version, version + 2);
  });

  it('refuses to reuse a capability once the change succeeded (409)', async () => {
    const { version } = (await call('GET', '/ops/config')).body.data;
    const { token } = await mint();
    assert.equal((await setFlag(token, { enabled: true, reason: REASON, expectedVersion: version })).status, 200);

    const replay = await setFlag(token, { enabled: false, reason: REASON, expectedVersion: version + 1 });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, 'CAPABILITY_ALREADY_USED');
    assert.equal(isFeatureEnabled(FLAG), true);
    featureFlagOverrides.set(FLAG, null);
  });

  it('keeps the capability usable after a failed attempt (audit outage, stale version, bad input)', async () => {
    const { version } = (await call('GET', '/ops/config')).body.data;
    const { token } = await mint();

    failAudit = true;
    const outage = await setFlag(token, { enabled: true, reason: REASON, expectedVersion: version });
    assert.equal(outage.status, 503);
    assert.equal(outage.body.code, 'CONFIG_AUDIT_UNAVAILABLE');
    assert.equal(isFeatureEnabled(FLAG), false, 'no evidence, no change');
    failAudit = false;

    const stale = await setFlag(token, { enabled: true, reason: REASON, expectedVersion: version + 7 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'CONFIG_VERSION_CONFLICT');

    const invalid = await setFlag(token, { enabled: 'yes', reason: REASON, expectedVersion: version });
    assert.equal(invalid.status, 400);

    const retried = await setFlag(token, { enabled: true, reason: REASON, expectedVersion: version });
    assert.equal(retried.status, 200, 'the same capability succeeds on retry');
    assert.equal(auditStore.queryEvents({ action: 'CONFIG_CHANGED' }).total, 1, 'exactly one change was evidenced');
    featureFlagOverrides.set(FLAG, null);
  });

  it('enforces the authorization boundary on every step', async () => {
    const { version } = (await call('GET', '/ops/config')).body.data;
    const body = { enabled: true, reason: REASON, expectedVersion: version };

    const noAdmin = await fetch(`${base}/ops/config/feature-flags/${FLAG}`, { method: 'PUT' });
    assert.equal(noAdmin.status, 401, 'the admin bearer is still required');

    const noCapability = await setFlag(undefined, body);
    assert.equal(noCapability.status, 401);
    assert.equal(noCapability.body.code, 'CAPABILITY_REQUIRED');

    const forged = await setFlag('qcap.v1.eyJ0eXAiOiJxY2FwIn0.forged-signature', body);
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, 'CAPABILITY_INVALID');

    const otherFlag = await mint('someOtherFlag');
    const wrongScope = await setFlag(otherFlag.token, body);
    assert.equal(wrongScope.status, 403);
    assert.equal(wrongScope.body.code, 'CAPABILITY_SCOPE_MISMATCH');

    const unknown = await setFlag(otherFlag.token, body, 'someOtherFlag');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'UNKNOWN_FEATURE_FLAG');

    const badIssue = await call('POST', '/ops/capabilities', { action: 'config.everything', target: FLAG, subject: 'x' });
    assert.equal(badIssue.status, 400);
    assert.equal(badIssue.body.code, 'UNKNOWN_CAPABILITY_ACTION');

    assert.equal(isFeatureEnabled(FLAG), false);
    assert.equal(auditStore.queryEvents({ action: 'CONFIG_CHANGED' }).total, 0);
  });

  it('disables capability routes (403) when no capability secret is configured', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: {} as any, adminToken: ADMIN, approvals: null, capabilities: null, adminConfig: config }));
    const disabled = app.listen(0);
    await new Promise((resolve) => disabled.once('listening', resolve));
    const url = `http://127.0.0.1:${(disabled.address() as AddressInfo).port}/api`;
    try {
      for (const [method, path] of [['POST', '/ops/capabilities'], ['PUT', `/ops/config/feature-flags/${FLAG}`]]) {
        const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}` } });
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as any).code, 'CAPABILITIES_DISABLED');
      }
      const read = await fetch(`${url}/ops/config`, { headers: { authorization: `Bearer ${ADMIN}` } });
      assert.equal(read.status, 200, 'reading configuration does not need a capability');
    } finally {
      await new Promise((resolve) => disabled.close(resolve));
    }
  });
});
