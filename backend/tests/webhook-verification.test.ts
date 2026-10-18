import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'crypto';

import {
  verifyWebhookSignature,
  isTimestampStale,
  WebhookVerificationError,
} from '../src/webhooks/webhook-verification';
import { MemoryReplayStore } from '../src/webhooks/replay-store';
import { createWebhookMiddleware } from '../src/webhooks/webhook-middleware';

const SECRET = 'test-webhook-secret-key';
const PAYLOAD = JSON.stringify({ type: 'invoice.paid', invoiceId: '123' });

function makeSignature(payload: string, timestamp: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('Webhook Verification', () => {
  describe('verifyWebhookSignature', () => {
    it('accepts a valid signature', () => {
      const ts = nowTimestamp();
      const sig = makeSignature(PAYLOAD, ts);
      assert.strictEqual(verifyWebhookSignature(PAYLOAD, sig, SECRET, ts), true);
    });

    it('rejects an invalid signature', () => {
      const ts = nowTimestamp();
      assert.strictEqual(verifyWebhookSignature(PAYLOAD, 'sha256=deadbeef', SECRET, ts), false);
    });

    it('rejects a signature with wrong secret', () => {
      const ts = nowTimestamp();
      const sig = makeSignature(PAYLOAD, ts, 'wrong-secret');
      assert.strictEqual(verifyWebhookSignature(PAYLOAD, sig, SECRET, ts), false);
    });

    it('works with Buffer payloads', () => {
      const ts = nowTimestamp();
      const sig = makeSignature(PAYLOAD, ts);
      assert.strictEqual(verifyWebhookSignature(Buffer.from(PAYLOAD), sig, SECRET, ts), true);
    });
  });

  describe('isTimestampStale', () => {
    it('returns false for a fresh timestamp', () => {
      assert.strictEqual(isTimestampStale(nowTimestamp(), 300), false);
    });

    it('returns true for a timestamp older than tolerance', () => {
      const old = String(Math.floor(Date.now() / 1000) - 600);
      assert.strictEqual(isTimestampStale(old, 300), true);
    });

    it('returns true for non-numeric timestamps', () => {
      assert.strictEqual(isTimestampStale('not-a-number', 300), true);
    });

    it('returns true for empty string', () => {
      assert.strictEqual(isTimestampStale('', 300), true);
    });
  });

  describe('WebhookVerificationError', () => {
    it('carries a code property', () => {
      const err = new WebhookVerificationError('INVALID_SIGNATURE', 'bad sig');
      assert.strictEqual(err.code, 'INVALID_SIGNATURE');
      assert.strictEqual(err.message, 'bad sig');
      assert.ok(err instanceof Error);
    });
  });
});

describe('MemoryReplayStore', () => {
  let store: MemoryReplayStore;

  beforeEach(() => {
    store = new MemoryReplayStore({ maxCapacity: 5, replayWindowMs: 1000 });
  });

  it('detects duplicate event IDs', () => {
    store.add('evt-1');
    assert.strictEqual(store.has('evt-1'), true);
    assert.strictEqual(store.has('evt-2'), false);
  });

  it('evicts oldest when at capacity', () => {
    for (let i = 0; i < 6; i++) {
      store.add(`evt-${i}`);
    }
    // evt-0 should have been evicted
    assert.strictEqual(store.size, 5);
  });

  it('evicts entries past TTL on cleanup', async () => {
    const shortStore = new MemoryReplayStore({ maxCapacity: 100, replayWindowMs: 50 });
    shortStore.add('evt-old');
    await new Promise((r) => setTimeout(r, 100));
    shortStore.cleanup();
    assert.strictEqual(shortStore.has('evt-old'), false);
  });
});

describe('Webhook Middleware', () => {
  const config = { signingSecret: SECRET, toleranceSeconds: 300, replayWindowMs: 300_000 };

  function mockReqRes(headers: Record<string, string>, body: any = {}) {
    const req = { headers, body } as any;
    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status(code: number) { statusCode = code; return res; },
      json(data: any) { jsonBody = data; return res; },
    } as any;
    return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
  }

  it('passes valid webhooks through to next()', (_, done) => {
    const middleware = createWebhookMiddleware(config);
    const ts = nowTimestamp();
    const sig = makeSignature(PAYLOAD, ts);
    const { req, res } = mockReqRes({
      'x-webhook-signature': sig,
      'x-webhook-timestamp': ts,
      'x-webhook-event-id': 'evt-100',
    }, JSON.parse(PAYLOAD));

    middleware(req, res, () => {
      assert.strictEqual(req.webhookEventId, 'evt-100');
      done();
    });
  });

  it('rejects missing headers with 400', () => {
    const middleware = createWebhookMiddleware(config);
    const { req, res, getStatus, getJson } = mockReqRes({});

    middleware(req, res, () => { throw new Error('should not call next'); });
    assert.strictEqual(getStatus(), 400);
    assert.strictEqual(getJson().code, 'MALFORMED_WEBHOOK');
  });

  it('rejects invalid signature with 401', () => {
    const middleware = createWebhookMiddleware(config);
    const ts = nowTimestamp();
    const { req, res, getStatus, getJson } = mockReqRes({
      'x-webhook-signature': 'sha256=bad',
      'x-webhook-timestamp': ts,
      'x-webhook-event-id': 'evt-101',
    }, JSON.parse(PAYLOAD));

    middleware(req, res, () => { throw new Error('should not call next'); });
    assert.strictEqual(getStatus(), 401);
    assert.strictEqual(getJson().code, 'INVALID_SIGNATURE');
  });

  it('rejects stale timestamps with 408', () => {
    const middleware = createWebhookMiddleware(config);
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const sig = makeSignature(PAYLOAD, staleTs);
    const { req, res, getStatus, getJson } = mockReqRes({
      'x-webhook-signature': sig,
      'x-webhook-timestamp': staleTs,
      'x-webhook-event-id': 'evt-102',
    }, JSON.parse(PAYLOAD));

    middleware(req, res, () => { throw new Error('should not call next'); });
    assert.strictEqual(getStatus(), 408);
    assert.strictEqual(getJson().code, 'STALE_TIMESTAMP');
  });

  it('rejects duplicate events with 409', (_, done) => {
    const store = new MemoryReplayStore({ replayWindowMs: 300_000 });
    const middleware = createWebhookMiddleware(config, store);
    const ts = nowTimestamp();
    const sig = makeSignature(PAYLOAD, ts);
    const headers = {
      'x-webhook-signature': sig,
      'x-webhook-timestamp': ts,
      'x-webhook-event-id': 'evt-dup',
    };
    const body = JSON.parse(PAYLOAD);

    // First call should succeed
    const first = mockReqRes(headers, body);
    middleware(first.req, first.res, () => {
      // Second call with same event ID should be rejected
      const second = mockReqRes(headers, body);
      middleware(second.req, second.res, () => { throw new Error('should not call next'); });
      assert.strictEqual(second.getStatus(), 409);
      assert.strictEqual(second.getJson().code, 'DUPLICATE_EVENT');
      done();
    });
  });
});
