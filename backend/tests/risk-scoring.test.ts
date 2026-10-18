import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalError, MaintainerApprovalService } from '../src/ops/maintainer-approval';
import { RiskScorer, riskLevelFor, RISK_POLICY_VERSION } from '../src/ops/risk-scoring';

const SECRET = 'test-secret-0123456789abcdef';
const REASON = 'Customer requested cancellation via support ticket #42';
const WINDOW_MS = 10 * 60_000;

function setup() {
  const clock = { t: new Date('2026-10-17T12:00:00.000Z').getTime() };
  const svc = new MaintainerApprovalService({ secret: SECRET, now: () => new Date(clock.t) });
  return { svc, clock };
}

async function rejects(p: Promise<unknown> | (() => unknown), code: string): Promise<ApprovalError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    assert.ok(err instanceof ApprovalError, String(err));
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}`);
}

describe('risk scoring for high-impact actions (#312)', () => {
  it('maps scores onto levels at the documented boundaries', () => {
    assert.equal(riskLevelFor(0), 'low');
    assert.equal(riskLevelFor(29), 'low');
    assert.equal(riskLevelFor(30), 'elevated');
    assert.equal(riskLevelFor(49), 'elevated');
    assert.equal(riskLevelFor(50), 'high');
    assert.equal(riskLevelFor(79), 'high');
    assert.equal(riskLevelFor(80), 'critical');
    assert.equal(riskLevelFor(100), 'critical');
  });

  it('normal path: a first intent is low risk and explains its only factor', () => {
    const { svc } = setup();
    const single = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-1', reason: REASON, requestedBy: 'alice' });
    assert.equal(single.risk?.policyVersion, RISK_POLICY_VERSION);
    assert.equal(single.risk?.score, 10);
    assert.equal(single.risk?.level, 'low');
    assert.equal(single.risk?.requiresSecondApprover, false);
    assert.deepEqual(single.risk?.factors.map((f) => f.code), ['ACTION_BASELINE']);
    assert.match(single.risk!.factors[0].detail, /single-approver/);

    const twoPerson = svc.requestIntent({ action: 'invoice.cancel', target: 'inv-1', reason: REASON, requestedBy: 'carol' });
    assert.equal(twoPerson.risk?.score, 25);
    assert.match(twoPerson.risk!.factors[0].detail, /two-person/);
  });

  it('authorization path: high velocity forces a second approver on a single-approver action', async () => {
    const { svc } = setup();
    svc.registerExecutor('job.requeue_dead', async () => 'ok');
    for (let i = 0; i < 9; i++) {
      svc.requestIntent({ action: 'job.requeue_dead', target: `job-${i}`, reason: REASON, requestedBy: 'alice' });
    }
    const intent = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-9', reason: REASON, requestedBy: 'alice' });
    assert.equal(intent.risk?.level, 'high');
    assert.equal(intent.risk?.score, 50);
    const velocity = intent.risk!.factors.find((f) => f.code === 'REQUESTER_VELOCITY');
    assert.deepEqual({ observed: velocity?.observed, allowance: velocity?.allowance, weight: velocity?.weight }, { observed: 9, allowance: 5, weight: 40 });

    const input = { executedBy: 'alice', confirmation: intent.confirmationPhrase };
    await rejects(svc.execute(intent.id, input), 'APPROVAL_REQUIRED');
    await rejects(() => svc.approve(intent.id, 'alice'), 'SELF_APPROVAL');
    svc.approve(intent.id, 'bob');
    const receipt = await svc.execute(intent.id, input);
    assert.equal(receipt.outcome, 'succeeded');
    assert.equal(receipt.risk?.level, 'high');
    assert.equal(svc.verifyReceipt(receipt), true);
  });

  it('failure path: combined signals block the intent with a signed, reviewable receipt', async () => {
    const { svc } = setup();
    const levels: string[] = [];
    for (let i = 0; i < 3; i++) {
      const intent = svc.requestIntent({ action: 'invoice.cancel', target: 'inv-1', reason: REASON, requestedBy: 'alice' });
      levels.push(intent.risk!.level);
      svc.reject(intent.id, 'bob', 'no supporting evidence');
    }
    assert.deepEqual(levels, ['low', 'elevated', 'high']);

    const err = await rejects(
      () => svc.requestIntent({ action: 'invoice.cancel', target: 'inv-1', reason: REASON, requestedBy: 'alice' }),
      'RISK_BLOCKED'
    );
    assert.equal(err.httpStatus, 403);
    assert.match(err.message, /TARGET_REPETITION/);
    assert.match(err.message, /RECENT_FAILURES/);

    const refused = svc.listIntents({ status: 'rejected' }).find((i) => i.risk?.blocked);
    assert.ok(refused, 'refused intent stays reviewable');
    assert.equal(refused.risk?.score, 85);
    const [receipt] = svc.listReceipts({ intentId: refused.id });
    assert.equal(receipt.outcome, 'rejected');
    assert.equal(receipt.risk?.level, 'critical');
    assert.match(receipt.error ?? '', /risk policy risk-v1/);
    assert.equal(svc.verifyReceiptChain(), -1);
    await rejects(() => svc.approve(refused.id, 'bob'), 'INVALID_STATE');
  });

  it('retry path: a retry storm escalates, and the window cools down', async () => {
    const { svc, clock } = setup();
    svc.registerExecutor('job.requeue_dead', async () => {
      throw new Error('job store unavailable');
    });
    const levels: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const intent = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-7', reason: REASON, requestedBy: 'alice' });
      levels.push(intent.risk!.level);
      const receipt = await svc.execute(intent.id, { executedBy: 'alice', confirmation: intent.confirmationPhrase });
      assert.equal(receipt.outcome, 'failed');
    }
    assert.deepEqual(levels, ['low', 'low', 'elevated']);

    const fourth = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-7', reason: REASON, requestedBy: 'alice' });
    assert.equal(fourth.risk?.level, 'high');
    await rejects(svc.execute(fourth.id, { executedBy: 'alice', confirmation: fourth.confirmationPhrase }), 'APPROVAL_REQUIRED');

    clock.t += WINDOW_MS + 1;
    const cooled = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-7', reason: REASON, requestedBy: 'alice' });
    assert.equal(cooled.risk?.level, 'low');
    assert.deepEqual(cooled.risk?.factors.map((f) => f.code), ['ACTION_BASELINE']);
  });

  it('binds the assessment into the intent signature', async () => {
    const { svc } = setup();
    svc.registerExecutor('invoice.cancel', async () => 'ok');
    const intent = svc.requestIntent({ action: 'invoice.cancel', target: 'inv-3', reason: REASON, requestedBy: 'alice' });
    const internal = (svc as any).intents.get(intent.id);
    internal.risk = { ...internal.risk, requiresSecondApprover: false, score: 0, level: 'low' };
    await rejects(() => svc.approve(intent.id, 'bob'), 'INTENT_TAMPERED');
  });

  it('preserves the pre-scoring contract when scoring is disabled', async () => {
    const svc = new MaintainerApprovalService({ secret: SECRET, risk: null });
    svc.registerExecutor('job.requeue_dead', async () => 'ok');
    let last;
    for (let i = 0; i < 20; i++) {
      last = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-1', reason: REASON, requestedBy: 'alice' });
    }
    assert.equal(last!.risk, null);
    const receipt = await svc.execute(last!.id, { executedBy: 'alice', confirmation: last!.confirmationPhrase });
    assert.equal(receipt.outcome, 'succeeded');
    assert.equal(receipt.risk, null);
  });

  it('keeps memory bounded per key and sweeps stale keys', () => {
    const clock = { t: 0 };
    const scorer = new RiskScorer({ now: () => new Date(clock.t), windowMs: 1_000, maxEventsPerKey: 3, sweepEvery: 4 });
    for (let i = 0; i < 10; i++) scorer.recordIntent('alice', 'job-1');
    const capped = scorer.assess({ action: 'job.requeue_dead', requiresSecondApprover: false, requestedBy: 'alice', target: 'job-1' });
    assert.equal(capped.factors.find((f) => f.code === 'TARGET_REPETITION')?.observed, 3);

    const fresh = new RiskScorer({ now: () => new Date(clock.t), windowMs: 1_000, sweepEvery: 4 });
    for (const key of ['a', 'b', 'c']) fresh.recordIntent(key, `${key}-target`);
    assert.equal(fresh.trackedKeys, 6);
    clock.t = 2_000;
    fresh.recordIntent('z', 'z-target');
    assert.equal(fresh.trackedKeys, 2);
  });
});
