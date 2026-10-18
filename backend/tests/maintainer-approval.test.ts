import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalError, MaintainerApprovalService, type IntentReceipt } from '../src/ops/maintainer-approval';

const SECRET = 'test-secret-0123456789abcdef';

function service(clock = { t: new Date('2026-10-16T12:00:00.000Z').getTime() }) {
  const sink: IntentReceipt[] = [];
  const svc = new MaintainerApprovalService({ secret: SECRET, now: () => new Date(clock.t), onReceipt: (r) => sink.push(r) });
  return { svc, sink, clock };
}

const REASON = 'Customer requested cancellation via support ticket #42';

async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    assert.ok(err instanceof ApprovalError, String(err));
    assert.equal((err as ApprovalError).code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

describe('maintainer approval flow', () => {
  it('rejects unknown actions and missing reasons', async () => {
    const { svc } = service();
    await rejects(() => svc.requestIntent({ action: 'db.drop', target: 'x', reason: REASON, requestedBy: 'alice' }), 'UNKNOWN_ACTION');
    await rejects(() => svc.requestIntent({ action: 'invoice.cancel', target: 'x', reason: 'short', requestedBy: 'alice' }), 'REASON_REQUIRED');
  });

  it('requires a second approver who is not the requester', async () => {
    const { svc } = service();
    svc.registerExecutor('invoice.cancel', async () => ({ ok: true }));
    const intent = svc.requestIntent({ action: 'invoice.cancel', target: 'inv-1', reason: REASON, requestedBy: 'alice' });
    await rejects(svc.execute(intent.id, { executedBy: 'alice', confirmation: intent.confirmationPhrase }), 'APPROVAL_REQUIRED');
    await rejects(() => svc.approve(intent.id, 'alice'), 'SELF_APPROVAL');
    svc.approve(intent.id, 'bob');
    const receipt = await svc.execute(intent.id, { executedBy: 'alice', confirmation: 'invoice.cancel inv-1' });
    assert.equal(receipt.outcome, 'succeeded');
    assert.equal(receipt.approvedBy, 'bob');
    assert.deepEqual(receipt.result, { ok: true });
    assert.equal(svc.verifyReceipt(receipt), true);
  });

  it('requires the exact confirmation phrase and unchanged params', async () => {
    const { svc } = service();
    svc.registerExecutor('job.requeue_dead', async () => 'ok');
    const intent = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-1', reason: REASON, requestedBy: 'alice', params: { a: 1 } });
    await rejects(svc.execute(intent.id, { executedBy: 'alice', confirmation: 'yes' }), 'CONFIRMATION_MISMATCH');
    await rejects(svc.execute(intent.id, { executedBy: 'alice', confirmation: intent.confirmationPhrase, params: { a: 2 } }), 'PARAMS_CHANGED');
    const r = await svc.execute(intent.id, { executedBy: 'alice', confirmation: intent.confirmationPhrase, params: { a: 1 } });
    assert.equal(r.outcome, 'succeeded');
  });

  it('intents are single use, including under concurrent execution', async () => {
    const { svc } = service();
    let runs = 0;
    svc.registerExecutor('job.requeue_dead', async () => { runs++; await new Promise((r) => setTimeout(r, 5)); });
    const intent = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-1', reason: REASON, requestedBy: 'alice' });
    const input = { executedBy: 'alice', confirmation: intent.confirmationPhrase };
    const results = await Promise.allSettled([svc.execute(intent.id, input), svc.execute(intent.id, input)]);
    assert.equal(runs, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    await rejects(svc.execute(intent.id, input), 'INVALID_STATE');
  });

  it('failed executions produce a reviewable receipt with a redacted error', async () => {
    const { svc, sink } = service();
    svc.registerExecutor('job.requeue_dead', async () => { throw new Error('redis://u:hunter2@cache down token=xyz'); });
    const intent = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-9', reason: REASON, requestedBy: 'alice' });
    const r = await svc.execute(intent.id, { executedBy: 'alice', confirmation: intent.confirmationPhrase });
    assert.equal(r.outcome, 'failed');
    assert.ok(r.error && !r.error.includes('hunter2') && !r.error.includes('xyz'));
    assert.equal(svc.getIntent(intent.id)?.status, 'failed');
    assert.equal(sink.length, 1);
    assert.deepEqual(svc.listReceipts({ outcome: 'failed' }).map((x) => x.id), [r.id]);
  });

  it('expired intents cannot execute and leave an expired receipt', async () => {
    const { svc, clock } = service();
    svc.registerExecutor('job.requeue_dead', async () => 'ok');
    const intent = svc.requestIntent({ action: 'job.requeue_dead', target: 'job-1', reason: REASON, requestedBy: 'alice' });
    clock.t += 16 * 60_000;
    await rejects(svc.execute(intent.id, { executedBy: 'alice', confirmation: intent.confirmationPhrase }), 'INTENT_EXPIRED');
    assert.equal(svc.listReceipts({ outcome: 'expired' }).length, 1);
  });

  it('rejection produces a receipt', async () => {
    const { svc } = service();
    const intent = svc.requestIntent({ action: 'invoice.cancel', target: 'inv-2', reason: REASON, requestedBy: 'alice' });
    const r = svc.reject(intent.id, 'bob', 'not enough evidence');
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.executedBy, 'bob');
  });

  it('detects tampered intents, receipts, and chain gaps', async () => {
    const { svc } = service();
    svc.registerExecutor('job.requeue_dead', async () => 'ok');
    const receipts: IntentReceipt[] = [];
    for (const t of ['a', 'b', 'c']) {
      const i = svc.requestIntent({ action: 'job.requeue_dead', target: t, reason: REASON, requestedBy: 'alice' });
      receipts.push(await svc.execute(i.id, { executedBy: 'alice', confirmation: i.confirmationPhrase }));
    }
    assert.equal(svc.verifyReceiptChain(), -1);
    assert.equal(svc.verifyReceipt({ ...receipts[1], target: 'z' }), false);
    assert.equal(svc.verifyReceiptChain([receipts[0], receipts[2]]), 1);

    const other = new MaintainerApprovalService({ secret: 'another-secret-abcdefghij' });
    assert.equal(other.verifyReceipt(receipts[0]), false);

    const i = svc.requestIntent({ action: 'job.requeue_dead', target: 'x', reason: REASON, requestedBy: 'alice', params: { n: 1 } });
    const internal = (svc as any).intents.get(i.id);
    internal.params = { n: 2 };
    await rejects(svc.execute(i.id, { executedBy: 'alice', confirmation: i.confirmationPhrase }), 'INTENT_TAMPERED');
  });

  it('refuses to start with a weak secret', () => {
    assert.throws(() => new MaintainerApprovalService({ secret: 'short' }));
  });
});
