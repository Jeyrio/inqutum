/**
 * Expiring capability tokens for sensitive actions (#285).
 *
 * Normal, failure, retry and authorization paths of the token service. The
 * HTTP wiring (issue route + a consuming sensitive route) is exercised in
 * admin-config-audit.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  CapabilityError,
  CapabilityTokenService,
  SENSITIVE_ACTIONS,
  capabilityServiceFromEnv,
  type CapabilityScope,
} from '../src/security/capability-tokens';

const SECRET = 'capability-test-secret-0123456789abcdef';
const ACTION = 'config.feature_flag.set' as const;
const SCOPE: CapabilityScope = { action: ACTION, target: 'paymentAmountTolerance' };

function setup(start = Date.parse('2026-10-17T12:00:00.000Z'), ledgerCapacity?: number) {
  let nowMs = start;
  const service = new CapabilityTokenService({ secret: SECRET, now: () => new Date(nowMs), ledgerCapacity });
  return {
    service,
    advance: (ms: number) => (nowMs += ms),
    issue: (ttlMs?: number, target = SCOPE.target) =>
      service.issue({ action: ACTION, target, subject: 'maintainer-alice', ttlMs }).token,
  };
}

function rejects(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${err}`);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, status);
    return true;
  });
}

async function rejectsAsync(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${err}`);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, status);
    return true;
  });
}

describe('capability tokens — issuance (#285)', () => {
  it('issues a typed, versioned, scoped token with the action default TTL', () => {
    const { service } = setup();
    const { token, claims } = service.issue({ action: ACTION, target: 'paymentAmountTolerance', subject: 'maintainer-alice' });

    assert.match(token, /^qcap\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(claims.typ, 'qcap');
    assert.equal(claims.v, 1);
    assert.equal(claims.action, ACTION);
    assert.equal(claims.subject, 'maintainer-alice');
    assert.equal(claims.exp - claims.iat, SENSITIVE_ACTIONS[ACTION].defaultTtlMs);
    assert.ok(!token.includes(SECRET), 'the secret never appears in the token');
  });

  it('gives every capability a distinct single-use id', () => {
    const { service } = setup();
    const ids = new Set(Array.from({ length: 50 }, () => service.issue({ action: ACTION, target: 't', subject: 's' }).claims.id));
    assert.equal(ids.size, 50);
  });

  it('rejects unknown actions, missing scope fields and out-of-range TTLs', () => {
    const { service } = setup();
    rejects(() => service.issue({ action: 'invoice.delete_all', target: 't', subject: 's' }), 'UNKNOWN_CAPABILITY_ACTION', 400);
    for (const inherited of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
      rejects(() => service.issue({ action: inherited, target: 't', subject: 's', ttlMs: 60_000 }), 'UNKNOWN_CAPABILITY_ACTION', 400);
    }
    rejects(() => service.issue({ action: ACTION, target: '  ', subject: 's' }), 'CAPABILITY_REQUEST_INVALID', 400);
    rejects(() => service.issue({ action: ACTION, target: 't', subject: '' }), 'CAPABILITY_REQUEST_INVALID', 400);
    rejects(() => service.issue({ action: ACTION, target: 'x'.repeat(129), subject: 's' }), 'CAPABILITY_REQUEST_INVALID', 400);
    rejects(() => service.issue({ action: ACTION, target: 't', subject: 's', ttlMs: 999 }), 'CAPABILITY_REQUEST_INVALID', 400);
    rejects(() => service.issue({ action: ACTION, target: 't', subject: 's', ttlMs: SENSITIVE_ACTIONS[ACTION].maxTtlMs + 1 }), 'CAPABILITY_REQUEST_INVALID', 400);
    rejects(() => service.issue({ action: ACTION, target: 't', subject: 's', ttlMs: Number.NaN }), 'CAPABILITY_REQUEST_INVALID', 400);
  });

  it('refuses to start with a weak secret, and is disabled from env without one', () => {
    assert.throws(() => new CapabilityTokenService({ secret: 'short-secret' }), /at least 32 characters/);
    assert.equal(capabilityServiceFromEnv({}), null);
    assert.equal(capabilityServiceFromEnv({ CAPABILITY_TOKEN_SECRET: 'too-short' }), null);
    assert.ok(capabilityServiceFromEnv({ CAPABILITY_TOKEN_SECRET: SECRET }) instanceof CapabilityTokenService);
  });
});

describe('capability tokens — verification failures (#285)', () => {
  it('reports a missing token as CAPABILITY_REQUIRED (401)', () => {
    const { service } = setup();
    for (const missing of [undefined, null, '', '   ', 42]) {
      rejects(() => service.verify(missing, SCOPE), 'CAPABILITY_REQUIRED', 401);
    }
  });

  it('reports structurally invalid tokens as CAPABILITY_MALFORMED (401)', () => {
    const { service, issue } = setup();
    const [, , payload, sig] = issue().split('.');
    for (const bad of [
      'not-a-token',
      `jwt.v1.${payload}.${sig}`,
      `qcap.v2.${payload}.${sig}`,
      `qcap.v1.${payload}`,
      `qcap.v1.${payload}.${sig}.extra`,
      `qcap.v1.${payload}.si+g/=`,
      `qcap.v1.${'a'.repeat(1100)}.${sig}`,
    ]) {
      rejects(() => service.verify(bad, SCOPE), 'CAPABILITY_MALFORMED', 401);
    }
  });

  it('rejects a forged or edited token before trusting its claims', () => {
    const { service, issue } = setup();
    const [prefix, version, payload, sig] = issue().split('.');

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const widened = Buffer.from(JSON.stringify({ ...claims, target: 'anotherFlag', exp: claims.exp + 3_600_000 })).toString('base64url');
    rejects(() => service.verify(`${prefix}.${version}.${widened}.${sig}`, SCOPE), 'CAPABILITY_INVALID', 401);

    const otherKey = createHmac('sha256', 'a-different-secret-of-sufficient-len').update(`qcap.v1.${payload}`).digest('base64url');
    rejects(() => service.verify(`qcap.v1.${payload}.${otherKey}`, SCOPE), 'CAPABILITY_INVALID', 401);
  });

  it('expires exactly at exp and never before', () => {
    const { service, issue, advance } = setup();
    const token = issue(60_000);
    advance(59_999);
    assert.equal(service.verify(token, SCOPE).target, SCOPE.target);
    advance(1);
    rejects(() => service.verify(token, SCOPE), 'CAPABILITY_EXPIRED', 401);
  });

  it('rejects a token issued further in the future than the tolerated clock skew', () => {
    const start = Date.parse('2026-10-17T12:00:00.000Z');
    const ahead = new CapabilityTokenService({ secret: SECRET, now: () => new Date(start + 60_000) });
    const verifier = new CapabilityTokenService({ secret: SECRET, now: () => new Date(start) });
    const token = ahead.issue({ action: ACTION, target: SCOPE.target, subject: 's' }).token;
    rejects(() => verifier.verify(token, SCOPE), 'CAPABILITY_INVALID', 401);

    const slightlyAhead = new CapabilityTokenService({ secret: SECRET, now: () => new Date(start + 10_000) });
    const tolerated = slightlyAhead.issue({ action: ACTION, target: SCOPE.target, subject: 's' }).token;
    assert.equal(verifier.verify(tolerated, SCOPE).subject, 's');
  });
});

describe('capability tokens — authorization scope (#285)', () => {
  it('refuses a capability presented for another target or action (403)', () => {
    const { service, issue } = setup();
    const token = issue();
    rejects(() => service.verify(token, { action: ACTION, target: 'someOtherFlag' }), 'CAPABILITY_SCOPE_MISMATCH', 403);
    rejects(() => service.verify(token, { action: 'invoice.cancel' as any, target: SCOPE.target }), 'CAPABILITY_SCOPE_MISMATCH', 403);
  });

  it('does not run the action when authorization fails', async () => {
    const { service, issue } = setup();
    let ran = false;
    await rejectsAsync(service.use(issue(), { action: ACTION, target: 'x' }, () => (ran = true)), 'CAPABILITY_SCOPE_MISMATCH', 403);
    assert.equal(ran, false);
  });
});

describe('capability tokens — single use and retries (#285)', () => {
  it('runs the action once and then refuses replay with CAPABILITY_ALREADY_USED (409)', async () => {
    const { service, issue } = setup();
    const token = issue();
    let runs = 0;

    const claims = await service.use(token, SCOPE, (c) => (runs++, c));
    assert.equal(claims.subject, 'maintainer-alice');
    await rejectsAsync(service.use(token, SCOPE, () => runs++), 'CAPABILITY_ALREADY_USED', 409);
    assert.equal(runs, 1);
  });

  it('releases the capability when the action fails, so the same token can be retried', async () => {
    const { service, issue } = setup();
    const token = issue();

    await assert.rejects(service.use(token, SCOPE, () => { throw new Error('transient storage failure'); }), /transient/);
    assert.equal(await service.use(token, SCOPE, () => 'second attempt'), 'second attempt');
    await rejectsAsync(service.use(token, SCOPE, () => 'third'), 'CAPABILITY_ALREADY_USED', 409);
  });

  it('lets exactly one of two concurrent uses run; the other sees CAPABILITY_IN_USE', async () => {
    const { service, issue } = setup();
    const token = issue();
    let runs = 0;
    const slow = () => new Promise((resolve) => setTimeout(() => resolve(++runs), 20));

    const results = await Promise.allSettled([service.use(token, SCOPE, slow), service.use(token, SCOPE, slow)]);
    assert.equal(runs, 1);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((refused.reason as CapabilityError).code, 'CAPABILITY_IN_USE');
  });

  it('fails closed when the ledger is full of live capabilities, and recovers once they expire', async () => {
    const { service, issue, advance } = setup(undefined, 1);
    await service.use(issue(1_000), SCOPE, () => 'first');
    const second = issue(60_000);

    await rejectsAsync(service.use(second, SCOPE, () => 'blocked'), 'CAPABILITY_LEDGER_FULL', 503);
    advance(1_000);
    assert.equal(await service.use(second, SCOPE, () => 'after expiry'), 'after expiry');
  });
});
