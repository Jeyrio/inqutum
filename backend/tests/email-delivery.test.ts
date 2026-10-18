import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  EmailDeliveryService,
  EmailDeliveryError,
  MemoryEmailDeliveryStore,
  classifyProviderError,
  createHttpApiTransport,
  createSmtpTransport,
  disabledTransport,
  isValidRecipient,
  type EmailMessage,
  type EmailTransport,
} from '../src/notifications/email-delivery';

/**
 * Email deliverability hardening (#35).
 *
 * Covers the failure modes the issue calls out: a send that silently does not
 * arrive, provider auth failures, provider quota failures, and bounces that are
 * never looked at.
 */
const MESSAGE: EmailMessage = {
  to: 'client@example.com',
  subject: 'Invoice INV-1 from Rosa',
  text: 'You have received an invoice.',
  idempotencyKey: 'invoice:INV-1',
};

function stubTransport(
  behaviour: (message: EmailMessage) => Promise<{ providerMessageId?: string }>
): EmailTransport {
  return { name: 'stub', send: behaviour };
}

describe('Email delivery hardening (Issue #35)', () => {
  let store: MemoryEmailDeliveryStore;
  let noSleep: (ms: number) => Promise<void>;

  beforeEach(() => {
    store = new MemoryEmailDeliveryStore();
    noSleep = async () => {};
  });

  describe('Explicit success state', () => {
    it('reports success explicitly and records the provider message id', async () => {
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        transport: stubTransport(async () => ({ providerMessageId: 'prov_123' })),
      });

      const result = await service.deliver(MESSAGE);

      assert.equal(result.ok, true);
      assert.equal(result.status, 'sent');
      assert.equal(result.delivery?.providerMessageId, 'prov_123');
      assert.equal(store.get(result.delivery!.id)?.status, 'sent');
    });

    it('never sends the same logical email twice', async () => {
      let sends = 0;
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        transport: stubTransport(async () => {
          sends++;
          return { providerMessageId: 'prov_123' };
        }),
      });

      await service.deliver(MESSAGE);
      const second = await service.deliver(MESSAGE);

      assert.equal(sends, 1);
      assert.equal(second.ok, true);
    });
  });

  describe('Provider failures are categorised distinctly', () => {
    const cases: Array<[string, string]> = [
      ['auth', 'Error: unauthorized'],
      ['quota', 'Error: TooManyRequests'],
      ['quota', 'Error: DailyLimitExceeded'],
      ['invalid_recipient', 'Error: mailbox unavailable'],
      ['transient', 'Error: socket hang up'],
      ['transient', 'Error: 503 upstream'],
      ['permanent', 'Error: something odd'],
      ['config', 'Error: API key not configured'],
    ];

    for (const [expected, message] of cases) {
      it(`classifies "${message}" as ${expected}`, () => {
        const classified = classifyProviderError(new Error(message));
        assert.equal(classified.category, expected);
      });
    }

    it('surfaces an auth failure as auth, not a generic failure', async () => {
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        maxAttempts: 1,
        transport: stubTransport(async () => {
          throw new Error('401 unauthorized');
        }),
      });

      const result = await service.deliver(MESSAGE);

      assert.equal(result.ok, false);
      assert.equal(result.category, 'auth');
      assert.equal(result.status, 'failed');
      assert.equal(result.retryable, false);
    });

    it('surfaces a quota failure as quota and marks it retryable', async () => {
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        maxAttempts: 1,
        transport: stubTransport(async () => {
          throw new Error('429 rate limit exceeded');
        }),
      });

      const result = await service.deliver(MESSAGE);
      assert.equal(result.category, 'quota');
      assert.equal(result.retryable, true);
    });

    it('retries transient failures and succeeds on a later attempt', async () => {
      let attempts = 0;
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        maxAttempts: 3,
        transport: stubTransport(async () => {
          attempts++;
          if (attempts < 3) throw new Error('ECONNRESET');
          return { providerMessageId: 'prov_late' };
        }),
      });

      const result = await service.deliver(MESSAGE);

      assert.equal(attempts, 3);
      assert.equal(result.ok, true);
      assert.equal(result.delivery?.attempts, 3);
    });

    it('does not retry permanent failures', async () => {
      let attempts = 0;
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        maxAttempts: 3,
        transport: stubTransport(async () => {
          attempts++;
          throw new Error('550 rejected');
        }),
      });

      await service.deliver(MESSAGE);
      assert.equal(attempts, 1);
    });

    it('fails loudly when no transport is configured', async () => {
      const service = new EmailDeliveryService({ store, sleep: noSleep, transport: disabledTransport });
      const result = await service.deliver(MESSAGE);
      assert.equal(result.ok, false);
      assert.equal(result.category, 'config');
    });

    it('rejects an invalid recipient before calling the provider', async () => {
      let called = false;
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        transport: stubTransport(async () => {
          called = true;
          return {};
        }),
      });

      const result = await service.deliver({ ...MESSAGE, to: 'not-an-email' });

      assert.equal(called, false);
      assert.equal(result.category, 'invalid_recipient');
      assert.equal(result.ok, false);
    });
  });

  describe('Bounce and complaint visibility', () => {
    it('records a bounce against the original delivery', async () => {
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        transport: stubTransport(async () => ({ providerMessageId: 'prov_b' })),
      });
      const sent = await service.deliver(MESSAGE);

      const bounced = service.recordBounce('prov_b', 'mailbox full');

      assert.equal(bounced?.id, sent.delivery?.id);
      assert.equal(bounced?.status, 'bounced');
      assert.ok(bounced?.bouncedAt);
      assert.equal(store.findByProviderMessageId('prov_b')?.status, 'bounced');
    });

    it('records a spam complaint', async () => {
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        transport: stubTransport(async () => ({ providerMessageId: 'prov_c' })),
      });
      await service.deliver(MESSAGE);

      const complained = service.recordComplaint('prov_c', 'reported as spam');

      assert.equal(complained?.status, 'complained');
      assert.ok(complained?.complainedAt);
    });

    it('surfaces non-sent deliveries for manual follow-up', async () => {
      const service = new EmailDeliveryService({
        store,
        sleep: noSleep,
        maxAttempts: 1,
        transport: stubTransport(async () => {
          throw new Error('permanent failure');
        }),
      });
      await service.deliver({ ...MESSAGE, idempotencyKey: 'invoice:bad' });

      const problems = service.listProblems();
      assert.equal(problems.length, 1);
      assert.equal(problems[0].status, 'failed');
      assert.equal(problems[0].category, 'permanent');
    });

    it('ignores a bounce for an unknown message id', () => {
      const service = new EmailDeliveryService({ store, sleep: noSleep });
      assert.equal(service.recordBounce('prov_unknown'), null);
    });
  });

  describe('Transports', () => {
    it('maps a provider 401 onto the auth category', async () => {
      const transport = createHttpApiTransport({
        endpoint: 'https://api.example.com/send',
        token: 'token',
        from: 'billing@example.com',
        fetchImpl: async () => new Response('nope', { status: 401 }),
      });

      const error = await transport.send(MESSAGE).catch((e) => e as EmailDeliveryError);
      assert.equal((error as EmailDeliveryError).category, 'auth');
    });

    it('maps a provider 429 onto the quota category', async () => {
      const transport = createHttpApiTransport({
        endpoint: 'https://api.example.com/send',
        token: 'token',
        from: 'billing@example.com',
        fetchImpl: async () => new Response('slow down', { status: 429 }),
      });

      const error = await transport.send(MESSAGE).catch((e) => e as EmailDeliveryError);
      assert.equal((error as EmailDeliveryError).category, 'quota');
    });

    it('returns the provider message id on success', async () => {
      const transport = createHttpApiTransport({
        endpoint: 'https://api.example.com/send',
        token: 'token',
        from: 'billing@example.com',
        fetchImpl: async () => Response.json({ id: 'prov_http' }),
      });

      const result = await transport.send(MESSAGE);
      assert.equal(result.providerMessageId, 'prov_http');
    });

    it('adapts an SMTP client and surfaces full rejection', async () => {
      const transport = createSmtpTransport({
        sendMail: async () => ({ messageId: 'smtp_1', accepted: [], rejected: ['client@example.com'] }),
      });

      const error = await transport.send(MESSAGE).catch((e) => e as EmailDeliveryError);
      assert.equal((error as EmailDeliveryError).category, 'invalid_recipient');
    });

    it('validates recipient addresses', () => {
      assert.equal(isValidRecipient('client@example.com'), true);
      assert.equal(isValidRecipient('nope'), false);
      assert.equal(isValidRecipient(''), false);
      assert.equal(isValidRecipient(undefined), false);
    });
  });
});
