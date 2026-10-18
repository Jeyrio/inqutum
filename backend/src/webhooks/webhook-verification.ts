/**
 * Cryptographic webhook signature verification.
 *
 * Expected signature format: sha256=HMAC(secret, timestamp + '.' + payload)
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { canonicalize } from '../security/canonical-serialization';

export class WebhookVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

/**
 * Verify an HMAC-SHA256 webhook signature.
 *
 * @returns true when the signature is valid
 */
export function verifyWebhookSignature(
  payload: string | Buffer | unknown,
  signature: string,
  secret: string,
  timestamp: string
): boolean {
  let body: string;
  if (typeof payload === 'string') {
    body = payload;
  } else if (Buffer.isBuffer(payload)) {
    body = payload.toString('utf8');
  } else {
    body = canonicalize(payload);
  }

  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest('hex');

  if (expected.length !== signature.length) {
    // If raw string check failed and it's valid JSON, try canonicalizing
    if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        const canonicalBody = canonicalize(parsed);
        if (canonicalBody !== payload) {
          const canonicalExpected = 'sha256=' + createHmac('sha256', secret)
            .update(timestamp + '.' + canonicalBody)
            .digest('hex');
          if (canonicalExpected.length === signature.length) {
            return timingSafeEqual(Buffer.from(canonicalExpected), Buffer.from(signature));
          }
        }
      } catch {
        // Not JSON
      }
    }
    return false;
  }

  try {
    const match = timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (match) return true;

    // Fallback: If body was JSON string with different key order, try canonical form
    if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        const canonicalBody = canonicalize(parsed);
        if (canonicalBody !== payload) {
          const canonicalExpected = 'sha256=' + createHmac('sha256', secret)
            .update(timestamp + '.' + canonicalBody)
            .digest('hex');
          if (canonicalExpected.length === signature.length) {
            return timingSafeEqual(Buffer.from(canonicalExpected), Buffer.from(signature));
          }
        }
      } catch {
        // Not JSON
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Compute the canonical HMAC-SHA256 webhook signature for a payload.
 */
export function signWebhookPayload(payload: unknown, secret: string, timestamp: string): string {
  const body = typeof payload === 'string' ? payload : canonicalize(payload);
  return 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest('hex');
}

/**
 * Returns true when the timestamp is older than the tolerance window.
 */
export function isTimestampStale(timestamp: string, toleranceSeconds: number): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return true;
  const age = Math.abs(Date.now() / 1000 - ts);
  return age > toleranceSeconds;
}
