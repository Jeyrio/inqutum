/**
 * Recovery checkpoints around external side effects (#289).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  CheckpointInDoubtError,
  CheckpointInProgressError,
  CheckpointKeyReusedError,
  MemoryCheckpointStore,
  runWithCheckpoint,
} from '../src/recovery/side-effect-checkpoint';
import { EmailDeliveryService, emailFingerprint, type EmailTransport } from '../src/notifications/email-delivery';
import { EmailService, MemoryEmailTransport } from '../src/services/email.service';
import { createEmailRouter } from '../src/routes/email.routes';
import type { StoredInvoice } from '../src/storage/invoice-storage';

const T0 = new Date('2026-03-01T00:00:00.000Z');
const LATER = new Date(T0.getTime() + 10 * 60_000);
const noSleep = async () => {};

describe('runWithCheckpoint', () => {
  it('normal path: runs once and replays the stored result on retry', async () => {
    const store = new MemoryCheckpointStore();
    let calls = 0;
    const perform = async () => ({ id: `msg-${++calls}` });
    assert.deepEqual(await runWithCheckpoint(store, { key: 'k', effect: 'test' }, perform), { id: 'msg-1' });
    assert.deepEqual(await runWithCheckpoint(store, { key: 'k', effect: 'test' }, perform), { id: 'msg-1' });
    assert.equal(calls, 1);
    assert.equal((await store.get('k'))!.state, 'succeeded');
  });

  it('failure and retry path: a failed effect is recorded and may run again', async () => {
    const store = new MemoryCheckpointStore();
    await assert.rejects(
      runWithCheckpoint(store, { key: 'k', effect: 'test' }, async () => {
        throw new Error('provider 503');
      }),
      /provider 503/
    );
    assert.equal((await store.get('k'))!.error, 'provider 503');
    assert.equal(await runWithCheckpoint(store, { key: 'k', effect: 'test' }, async () => 'ok'), 'ok');
    assert.equal((await store.get('k'))!.attempt, 2);
  });

  it('refuses a concurrent run of the same key', async () => {
    const store = new MemoryCheckpointStore();
    let release!: () => void;
    const first = runWithCheckpoint(store, { key: 'k', effect: 'test' }, () => new Promise<string>((r) => (release = () => r('first'))));
    await assert.rejects(runWithCheckpoint(store, { key: 'k', effect: 'test' }, async () => 'second'), CheckpointInProgressError);
    release();
    assert.equal(await first, 'first');
  });

  it('crash recovery: a stale start with no reconcile becomes in_doubt and is never re-run', async () => {
    const store = new MemoryCheckpointStore();
    await store.claim('k', 'test', null, T0, T0); // a run that died before recording anything
    let calls = 0;
    const options = { key: 'k', effect: 'test', now: () => LATER, staleAfterMs: 60_000 };
    await assert.rejects(runWithCheckpoint(store, options, async () => ++calls), CheckpointInDoubtError);
    await assert.rejects(runWithCheckpoint(store, options, async () => ++calls), CheckpointInDoubtError);
    assert.equal(calls, 0);
    assert.equal((await store.get('k'))!.state, 'in_doubt');
  });

  it('crash recovery: reconcile settles a stale start either way', async () => {
    const store = new MemoryCheckpointStore();
    await store.claim('landed', 'test', null, T0, T0);
    await store.claim('lost', 'test', null, T0, T0);
    let calls = 0;
    const base = { effect: 'test', now: () => LATER, staleAfterMs: 60_000 };

    const landed = await runWithCheckpoint(
      store,
      { ...base, key: 'landed', reconcile: async () => ({ done: true as const, result: 'from-provider' }) },
      async () => `sent-${++calls}`
    );
    assert.equal(landed, 'from-provider');

    const lost = await runWithCheckpoint(store, { ...base, key: 'lost', reconcile: async () => ({ done: false as const }) }, async () => `sent-${++calls}`);
    assert.equal(lost, 'sent-1');
    assert.equal(calls, 1);
  });

  it('authorization path: a key reused for a different payload is refused, even after a failure', async () => {
    const store = new MemoryCheckpointStore();
    assert.equal(await runWithCheckpoint(store, { key: 'k', effect: 'test', fingerprint: 'a' }, async () => 'first'), 'first');
    await assert.rejects(runWithCheckpoint(store, { key: 'k', effect: 'test', fingerprint: 'b' }, async () => 'second'), CheckpointKeyReusedError);

    await assert.rejects(runWithCheckpoint(store, { key: 'f', effect: 'test', fingerprint: 'a' }, async () => { throw new Error('x'); }));
    await assert.rejects(runWithCheckpoint(store, { key: 'f', effect: 'test', fingerprint: 'b' }, async () => 'other'), CheckpointKeyReusedError);
  });

  it('a run that lost its claim cannot overwrite the newer attempt (fencing)', async () => {
    const store = new MemoryCheckpointStore();
    const first = await store.claim('k', 'test', null, T0, T0);
    await store.settle('k', first.checkpoint.attempt, 'failed', { error: 'x' }, T0);
    const second = await store.claim('k', 'test', null, T0, T0);
    assert.equal(await store.settle('k', first.checkpoint.attempt, 'succeeded', { result: 'zombie' }, T0), null);
    assert.equal((await store.settle('k', second.checkpoint.attempt, 'succeeded', { result: 'real' }, T0))!.result, 'real');
  });
});

describe('EmailDeliveryService checkpoints', () => {
  const MESSAGE = { to: 'client@example.com', subject: 'Invoice INV-1', text: 'Hi', idempotencyKey: 'invoice:INV-1' };
  const transport = (send: EmailTransport['send']): EmailTransport => ({ name: 'stub', send });

  it('sends a keyed message once even when the delivery log was lost', async () => {
    const checkpoints = new MemoryCheckpointStore();
    let sends = 0;
    const t = transport(async () => ({ providerMessageId: `prov-${++sends}` }));
    await new EmailDeliveryService({ transport: t, checkpoints, sleep: noSleep }).deliver(MESSAGE);
    // A fresh service (new delivery log) sharing the durable checkpoint store.
    const again = await new EmailDeliveryService({ transport: t, checkpoints, sleep: noSleep }).deliver(MESSAGE);
    assert.equal(sends, 1);
    assert.equal(again.ok, true);
    assert.equal(again.delivery?.providerMessageId, 'prov-1');
  });

  it('reports a concurrent duplicate as in_progress and a crashed send as in_doubt', async () => {
    const checkpoints = new MemoryCheckpointStore();
    let release!: () => void;
    const slow = transport(() => new Promise((resolve) => (release = () => resolve({ providerMessageId: 'p' }))));
    const service = new EmailDeliveryService({ transport: slow, checkpoints, sleep: noSleep });
    const first = service.deliver(MESSAGE);
    const duplicate = await service.deliver(MESSAGE);
    assert.equal(duplicate.category, 'in_progress');
    assert.equal(duplicate.retryable, true);
    release();
    assert.equal((await first).ok, true);

    const crashed = { ...MESSAGE, idempotencyKey: 'invoice:crashed' };
    await checkpoints.claim('email:invoice:crashed', 'email.send', emailFingerprint(crashed), new Date(0), new Date(0));
    const doubtful = await service.deliver(crashed);
    assert.equal(doubtful.category, 'in_doubt');
    assert.equal(doubtful.retryable, false);
  });

  it('fails closed when the checkpoint store is unreachable', async () => {
    let sends = 0;
    const broken = { claim: async () => { throw new Error('db down'); }, settle: async () => null, get: async () => null };
    const result = await new EmailDeliveryService({
      transport: transport(async () => ((sends += 1), {})),
      checkpoints: broken,
      sleep: noSleep,
    }).deliver(MESSAGE);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(sends, 0);
  });

  it('maps in_progress and in_doubt to 409 on POST /email/send', async () => {
    const checkpoints = new MemoryCheckpointStore();
    const body = { to: 'client@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'k-doubt' };
    await checkpoints.claim('email:k-doubt', 'email.send', emailFingerprint(body), new Date(0), new Date(0));
    const app = express();
    app.use(express.json());
    app.use('/api', createEmailRouter({ service: new EmailDeliveryService({ transport: transport(async () => ({})), checkpoints, sleep: noSleep }) }));
    const server = app.listen(0);
    try {
      const send = (payload: object) =>
        fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/email/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      const doubt = await send(body);
      assert.equal(doubt.status, 409);
      assert.equal((await doubt.json()).code, 'EMAIL_OUTCOME_IN_DOUBT');

      const reused = await send({ ...body, subject: 'Different email' });
      assert.equal(reused.status, 422);
      assert.equal((await reused.json()).code, 'EMAIL_IDEMPOTENCY_KEY_REUSED');
    } finally {
      server.close();
    }
  });
});

describe('EmailService.sendInvoiceEmail checkpoints', () => {
  const invoice = {
    id: '11111111-1111-4111-8111-111111111111',
    sellerPublicKey: `G${'A'.repeat(55)}`,
    amount: 10,
    assetCode: 'XLM',
    memo: 'INV-ABC-123',
    status: 'PENDING',
    customerEmail: 'client@example.com',
    createdAt: T0,
    expiresAt: LATER,
  } as StoredInvoice;

  it('a retried send with the same key emails the client once; no key keeps the old behaviour', async () => {
    const mail = new MemoryEmailTransport();
    const service = new EmailService(mail);
    const first = await service.sendInvoiceEmail(invoice, 'payment_request', { idempotencyKey: 'retry-1' });
    const second = await service.sendInvoiceEmail(invoice, 'payment_request', { idempotencyKey: 'retry-1' });
    assert.equal(second.messageId, first.messageId);
    assert.equal(mail.sentEmails.length, 1);

    await service.sendInvoiceEmail(invoice);
    await service.sendInvoiceEmail(invoice);
    assert.equal(mail.sentEmails.length, 3);
  });

  it('refuses the same key for a different email on the same invoice', async () => {
    const service = new EmailService(new MemoryEmailTransport());
    await service.sendInvoiceEmail(invoice, 'payment_request', { idempotencyKey: 'k' });
    await assert.rejects(
      service.sendInvoiceEmail(invoice, 'payment_request', { idempotencyKey: 'k', recipientEmail: 'someone@example.com' }),
      CheckpointKeyReusedError
    );
  });

  it('authorization path: a key reused on another invoice cannot replay this invoice\'s result', async () => {
    const mail = new MemoryEmailTransport();
    const service = new EmailService(mail);
    const other = { ...invoice, id: '22222222-2222-4222-8222-222222222222', customerEmail: 'other@example.com' } as StoredInvoice;
    const mine = await service.sendInvoiceEmail(invoice, 'payment_request', { idempotencyKey: 'shared' });
    const theirs = await service.sendInvoiceEmail(other, 'payment_request', { idempotencyKey: 'shared' });
    assert.notEqual(theirs.messageId, mine.messageId);
    assert.equal(theirs.recipient, 'other@example.com');
    assert.equal(mail.sentEmails.length, 2);
  });
});
