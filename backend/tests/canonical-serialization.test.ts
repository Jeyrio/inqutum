import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  canonicalHash,
  canonicalHmac,
  canonicalSigningPayload,
  CanonicalSerializationError,
} from '../src/security/canonical-serialization';
import { verifyWebhookSignature, signWebhookPayload } from '../src/webhooks/webhook-verification';

describe('Canonical Serialization Layer (Issue #247)', () => {
  describe('RFC 8785 key ordering & structural determinism', () => {
    it('produces identical serialization regardless of object key insertion order', () => {
      const objA = { z: 1, a: 2, m: 3 };
      const objB = { a: 2, m: 3, z: 1 };
      const objC = { m: 3, z: 1, a: 2 };

      const canonA = canonicalize(objA);
      const canonB = canonicalize(objB);
      const canonC = canonicalize(objC);

      assert.strictEqual(canonA, '{"a":2,"m":3,"z":1}');
      assert.strictEqual(canonA, canonB);
      assert.strictEqual(canonB, canonC);
      assert.strictEqual(canonicalHash(objA), canonicalHash(objB));
    });

    it('orders keys by UTF-16 code units recursively at all nesting levels', () => {
      const complex1 = {
        outer: {
          delta: [3, 2, 1],
          alpha: {
            zebra: 'test',
            apple: 'fruit',
          },
        },
        id: '123',
      };

      const complex2 = {
        id: '123',
        outer: {
          alpha: {
            apple: 'fruit',
            zebra: 'test',
          },
          delta: [3, 2, 1],
        },
      };

      assert.strictEqual(canonicalize(complex1), canonicalize(complex2));
      assert.strictEqual(
        canonicalize(complex1),
        '{"id":"123","outer":{"alpha":{"apple":"fruit","zebra":"test"},"delta":[3,2,1]}}'
      );
    });

    it('preserves array element ordering strictly', () => {
      const arr1 = [1, 2, 3];
      const arr2 = [3, 2, 1];

      assert.notStrictEqual(canonicalize(arr1), canonicalize(arr2));
      assert.strictEqual(canonicalize(arr1), '[1,2,3]');
      assert.strictEqual(canonicalize(arr2), '[3,2,1]');
    });
  });

  describe('Unicode normalization (NFC)', () => {
    it('normalizes NFD and NFC unicode strings to identical canonical representations', () => {
      // "café" in NFC (single code point for é: \u00e9) vs NFD (e + combining acute accent: e\u0301)
      const nfcString = 'caf\u00e9';
      const nfdString = 'cafe\u0301';

      assert.notStrictEqual(nfcString, nfdString); // JavaScript standard strings differ
      assert.strictEqual(canonicalize(nfcString), canonicalize(nfdString));
      assert.strictEqual(canonicalHash({ text: nfcString }), canonicalHash({ text: nfdString }));
    });

    it('normalizes unicode keys in objects', () => {
      const nfcKey = { 'caf\u00e9': 100 };
      const nfdKey = { 'cafe\u0301': 100 };

      assert.strictEqual(canonicalize(nfcKey), canonicalize(nfdKey));
      assert.strictEqual(canonicalHash(nfcKey), canonicalHash(nfdKey));
    });

    it('correctly escapes control characters without altering standard unicode', () => {
      const str = 'line1\nline2\ttab"quote"\\slash';
      assert.strictEqual(canonicalize(str), '"line1\\nline2\\ttab\\"quote\\"\\\\slash"');

      // Emoji and non-ASCII characters must NOT be backslash-u escaped under RFC 8785
      const emoji = 'Stellar 🌟 Payment';
      assert.strictEqual(canonicalize(emoji), '"Stellar 🌟 Payment"');
    });
  });

  describe('Number normalization', () => {
    it('normalizes negative zero (-0) to 0', () => {
      assert.strictEqual(canonicalize(-0), '0');
      assert.strictEqual(canonicalize({ val: -0 }), '{"val":0}');
      assert.strictEqual(canonicalize({ val: 0 }), '{"val":0}');
      assert.strictEqual(canonicalHash({ val: -0 }), canonicalHash({ val: 0 }));
    });

    it('serializes integers and floating point numbers canonically', () => {
      assert.strictEqual(canonicalize(100), '100');
      assert.strictEqual(canonicalize(25.5), '25.5');
      assert.strictEqual(canonicalize(0.0000001), '1e-7');
    });

    it('throws CanonicalSerializationError on NaN, Infinity, -Infinity', () => {
      assert.throws(
        () => canonicalize(NaN),
        (err: any) => err instanceof CanonicalSerializationError && err.code === 'INVALID_NUMBER'
      );
      assert.throws(
        () => canonicalize({ invalid: Infinity }),
        (err: any) => err instanceof CanonicalSerializationError && err.code === 'INVALID_NUMBER'
      );
      assert.throws(
        () => canonicalize([1, -Infinity]),
        (err: any) => err instanceof CanonicalSerializationError && err.code === 'INVALID_NUMBER'
      );
    });
  });

  describe('Edge cases, omitted fields & native types', () => {
    it('omits undefined and function properties from objects', () => {
      const obj = {
        active: true,
        skipped: undefined,
        fn: () => 'hello',
        name: 'invoice',
      };

      assert.strictEqual(canonicalize(obj), '{"active":true,"name":"invoice"}');
    });

    it('serializes undefined and functions as null inside arrays', () => {
      const arr = [1, undefined, () => {}, 4];
      assert.strictEqual(canonicalize(arr), '[1,null,null,4]');
    });

    it('serializes Date instances to ISO strings', () => {
      const date = new Date('2026-10-17T12:00:00.000Z');
      assert.strictEqual(canonicalize({ timestamp: date }), '{"timestamp":"2026-10-17T12:00:00.000Z"}');
    });

    it('serializes Buffer instances to hex strings', () => {
      const buf = Buffer.from('stellar');
      assert.strictEqual(canonicalize({ data: buf }), '{"data":"7374656c6c6172"}');
    });

    it('throws CanonicalSerializationError on circular references', () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      assert.throws(
        () => canonicalize(circular),
        (err: any) => err instanceof CanonicalSerializationError && err.code === 'CIRCULAR_REFERENCE'
      );
    });
  });

  describe('Cryptographic signing and hashing integration', () => {
    const SECRET = 'test_webhook_signing_secret_32_characters';

    it('generates identical HMACs for objects with scrambled keys', () => {
      const payload1 = {
        eventId: 'evt_1001',
        amount: '100.0000000',
        asset: 'XLM',
        recipient: 'GA5ZSEODL54HG5KTWU5UXZMCTV3OH46BRBSK7H3XCMZ2K7K27H2JTXQ6',
      };

      const payload2 = {
        recipient: 'GA5ZSEODL54HG5KTWU5UXZMCTV3OH46BRBSK7H3XCMZ2K7K27H2JTXQ6',
        eventId: 'evt_1001',
        asset: 'XLM',
        amount: '100.0000000',
      };

      const hmac1 = canonicalHmac(payload1, SECRET);
      const hmac2 = canonicalHmac(payload2, SECRET);

      assert.strictEqual(hmac1, hmac2);
      assert.strictEqual(canonicalHash(payload1), canonicalHash(payload2));
    });

    it('generates stable canonical signing envelopes with timestamp', () => {
      const payload = { action: 'invoice.cancel', id: 'inv_123' };
      const env1 = canonicalSigningPayload('intent', payload, 1729166400);
      const env2 = canonicalSigningPayload('intent', { id: 'inv_123', action: 'invoice.cancel' }, '1729166400');

      assert.strictEqual(env1, env2);
      assert.strictEqual(env1, 'intent.1729166400.{"action":"invoice.cancel","id":"inv_123"}');
    });

    it('verifies webhook signatures across reordered and canonical JSON payloads', () => {
      const timestamp = '1729166400';
      const originalObj = {
        invoiceId: 'inv-42',
        status: 'PAID',
        txHash: 'a'.repeat(64),
      };

      // Sign canonical payload
      const signature = signWebhookPayload(originalObj, SECRET, timestamp);

      // Verify with original object
      assert.ok(verifyWebhookSignature(originalObj, signature, SECRET, timestamp));

      // Verify with reordered object
      const reorderedObj = {
        txHash: 'a'.repeat(64),
        status: 'PAID',
        invoiceId: 'inv-42',
      };
      assert.ok(verifyWebhookSignature(reorderedObj, signature, SECRET, timestamp));

      // Verify with reordered JSON string
      const reorderedJsonStr = JSON.stringify(reorderedObj);
      assert.ok(verifyWebhookSignature(reorderedJsonStr, signature, SECRET, timestamp));

      // Tampered payload fails
      const tamperedObj = { ...originalObj, status: 'CANCELLED' };
      assert.strictEqual(verifyWebhookSignature(tamperedObj, signature, SECRET, timestamp), false);
    });
  });
});
