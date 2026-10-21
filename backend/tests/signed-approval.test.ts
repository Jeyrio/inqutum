/**
 * Signed administrative action approvals (#196): valid approval, expired
 * approval, wrong actor, replayed approval, plus multi-step confirmation and
 * the other ways an approval can fail to match the action it is used for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTECTED_ACTIONS,
  SignedApprovalError,
  SignedApprovalService,
  hashParams,
  signedApprovalServiceFromEnv,
  type ApprovalAuditRecord,
  type SignedApproval,
} from '../src/ops/signed-approval';

const SECRET = 'test-secret-with-enough-length';
const REASON = 'Seller asked for this in ticket 4412';
const START = Date.parse('2026-10-21T10:00:00.000Z');

function setup() {
  let nowMs = START;
  const audit: ApprovalAuditRecord[] = [];
  const service = new SignedApprovalService({ secret: SECRET, now: () => new Date(nowMs), onAudit: (r) => audit.push(r) });
  return { service, audit, advance: (ms: number) => (nowMs += ms) };
}

async function fails(p: Promise<unknown> | (() => unknown), code: string, status?: number) {
  await assert.rejects(Promise.resolve().then(typeof p === 'function' ? p : () => p), (e: unknown) => {
    assert.ok(e instanceof SignedApprovalError, `expected SignedApprovalError, got ${e}`);
    assert.equal(e.code, code);
    if (status) assert.equal(e.httpStatus, status);
    return true;
  });
}

const cancel = (approvals: SignedApproval[] | undefined, over: Record<string, unknown> = {}) => ({
  action: 'invoice.cancel',
  target: 'inv-1',
  actor: 'alice',
  params: { expectedVersion: 2 },
  approvals,
  ...over,
});

const approve = (service: SignedApprovalService, over: Record<string, unknown> = {}) =>
  service.issue({ action: 'invoice.cancel', target: 'inv-1', actor: 'alice', signer: 'bob', reason: REASON, params: { expectedVersion: 2 }, ...over } as any);

describe('signed approvals', () => {
  it('runs the protected action with a valid approval and records the audit trail', async () => {
    const { service, audit } = setup();
    const a = approve(service);
    assert.equal(a.paramsHash, hashParams({ expectedVersion: 2 }));
    const result = await service.runProtected(cancel([a]), () => 'cancelled');
    assert.equal(result, 'cancelled');
    assert.deepEqual(audit.map((r) => r.type), ['APPROVAL_ISSUED', 'APPROVAL_CONSUMED', 'PROTECTED_ACTION_EXECUTED']);
    assert.deepEqual(audit[2].signers, ['bob']);
  });

  it('fails without any approval and never runs the executor', async () => {
    const { service, audit } = setup();
    let ran = false;
    for (const approvals of [undefined, []]) {
      await fails(service.runProtected(cancel(approvals), () => (ran = true)), 'APPROVAL_REQUIRED', 403);
    }
    assert.equal(ran, false);
    assert.equal(audit.filter((r) => r.type === 'APPROVAL_REJECTED').length, 2);
  });

  it('rejects an expired approval', async () => {
    const { service, advance } = setup();
    const a = approve(service, { ttlMs: 60_000 });
    advance(60_000);
    await fails(service.runProtected(cancel([a]), () => 'x'), 'APPROVAL_EXPIRED', 410);
  });

  it('rejects an approval presented by the wrong actor', async () => {
    const { service } = setup();
    const a = approve(service);
    await fails(service.runProtected(cancel([a], { actor: 'mallory' }), () => 'x'), 'APPROVAL_ACTOR_MISMATCH', 403);
    // and it was not burned by the failed attempt
    assert.equal(await service.runProtected(cancel([a]), () => 'ok'), 'ok');
  });

  it('rejects a replayed approval', async () => {
    const { service } = setup();
    const a = approve(service);
    await service.runProtected(cancel([a]), () => 'first');
    await fails(service.runProtected(cancel([a]), () => 'second'), 'APPROVAL_REPLAYED', 409);
  });

  it('does not let concurrent calls share one approval', async () => {
    const { service } = setup();
    const a = approve(service);
    const results = await Promise.allSettled([
      service.runProtected(cancel([a]), async () => 'a'),
      service.runProtected(cancel([a]), async () => 'b'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  });

  it('burns the approval even when the executor fails', async () => {
    const { service, audit } = setup();
    const a = approve(service);
    await assert.rejects(service.runProtected(cancel([a]), () => { throw new Error('storage down'); }), /storage down/);
    assert.equal(audit.at(-1)?.type, 'PROTECTED_ACTION_FAILED');
    await fails(service.runProtected(cancel([a]), () => 'retry'), 'APPROVAL_REPLAYED');
  });

  it('rejects approvals for a different action, target or parameters', async () => {
    const { service } = setup();
    const a = approve(service);
    await fails(service.runProtected(cancel([a], { action: 'invoice.archive' }), () => 'x'), 'APPROVAL_ACTION_MISMATCH');
    await fails(service.runProtected(cancel([a], { target: 'inv-2' }), () => 'x'), 'APPROVAL_TARGET_MISMATCH');
    await fails(service.runProtected(cancel([a], { params: { expectedVersion: 3 } }), () => 'x'), 'APPROVAL_PARAMS_MISMATCH');
  });

  it('rejects tampered, forged and foreign-secret approvals', async () => {
    const { service } = setup();
    const a = approve(service);
    await fails(service.runProtected(cancel([{ ...a, target: 'inv-2' }], { target: 'inv-2' }), () => 'x'), 'APPROVAL_SIGNATURE_INVALID');
    await fails(service.runProtected(cancel([{ ...a, signer: 'carol' }]), () => 'x'), 'APPROVAL_SIGNATURE_INVALID');
    await fails(service.runProtected(cancel([{ ...a, expiresAt: '2099-01-01T00:00:00.000Z' }]), () => 'x'), 'APPROVAL_SIGNATURE_INVALID');
    await fails(service.runProtected(cancel([{ ...a, signature: '' }]), () => 'x'), 'APPROVAL_SIGNATURE_INVALID');
    await fails(service.runProtected(cancel([{} as SignedApproval]), () => 'x'), 'APPROVAL_SIGNATURE_INVALID');
    const other = new SignedApprovalService({ secret: 'another-secret-long-enough', now: () => new Date(START) });
    await fails(service.runProtected(cancel([approve(other)]), () => 'x'), 'APPROVAL_SIGNATURE_INVALID');
  });

  it('forbids self-approval', async () => {
    const { service } = setup();
    assert.throws(() => approve(service, { signer: 'alice' }), (e: unknown) => (e as SignedApprovalError).code === 'APPROVAL_SELF_SIGNED');
  });

  it('requires distinct signers for multi-step actions', async () => {
    const { service } = setup();
    const op = (approvals: SignedApproval[]) => ({ action: 'config.change', target: 'FEATURE_X', actor: 'alice', params: { v: 1 }, approvals });
    const issue = (signer: string) => service.issue({ action: 'config.change', target: 'FEATURE_X', actor: 'alice', signer, reason: REASON, params: { v: 1 } });
    assert.equal(PROTECTED_ACTIONS['config.change'].requiredSigners, 2);

    const bob1 = issue('bob');
    await fails(service.runProtected(op([bob1]), () => 'x'), 'APPROVAL_REQUIRED');
    await fails(service.runProtected(op([bob1, issue('bob')]), () => 'x'), 'APPROVAL_DUPLICATE_SIGNER');
    // none of the above burned bob1
    assert.equal(await service.runProtected(op([bob1, issue('carol')]), () => 'both'), 'both');
  });

  it('validates issue input', () => {
    const { service } = setup();
    for (const bad of [
      { action: 'nope' },
      { target: ' ' },
      { reason: 'short' },
      { ttlMs: 0 },
      { ttlMs: 24 * 3_600_000 },
    ]) {
      assert.throws(() => approve(service, bad), SignedApprovalError);
    }
  });

  it('prunes burned ids once their approvals can no longer be presented', async () => {
    const { service, advance } = setup();
    const store = (service as any).store;
    const a = approve(service, { ttlMs: 60_000 });
    await service.runProtected(cancel([a]), () => 'x');
    advance(61_000);
    assert.equal(store.prune(new Date(START + 61_000)), 1);
    await fails(service.runProtected(cancel([a]), () => 'x'), 'APPROVAL_EXPIRED');
  });

  it('survives a throwing audit sink', async () => {
    const service = new SignedApprovalService({ secret: SECRET, onAudit: () => { throw new Error('sink'); } });
    const a = service.issue({ action: 'invoice.cancel', target: 'inv-1', actor: 'alice', signer: 'bob', reason: REASON });
    assert.equal(await service.runProtected({ action: 'invoice.cancel', target: 'inv-1', actor: 'alice', approvals: [a] }, () => 'ok'), 'ok');
  });

  it('is only enabled with a long enough secret', () => {
    assert.equal(signedApprovalServiceFromEnv({}), null);
    assert.equal(signedApprovalServiceFromEnv({ SIGNED_APPROVAL_SECRET: 'short' }), null);
    assert.ok(signedApprovalServiceFromEnv({ SIGNED_APPROVAL_SECRET: SECRET }));
    assert.throws(() => new SignedApprovalService({ secret: 'short' }));
  });
});
