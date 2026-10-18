/**
 * Express middleware for webhook signature verification and replay prevention.
 *
 * Reads three headers from each request:
 *   X-Webhook-Signature  — sha256=<hex>
 *   X-Webhook-Timestamp  — unix epoch seconds
 *   X-Webhook-Event-Id   — unique event identifier
 *
 * On failure the middleware short-circuits with a structured JSON error.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyWebhookSignature, isTimestampStale, WebhookVerificationError } from './webhook-verification';
import { MemoryReplayStore, type ReplayStore } from './replay-store';
import type { WebhookConfig } from './types';

const HEADER_SIGNATURE = 'x-webhook-signature';
const HEADER_TIMESTAMP = 'x-webhook-timestamp';
const HEADER_EVENT_ID = 'x-webhook-event-id';

function webhookError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    error: message,
    code,
    timestamp: new Date().toISOString(),
  });
}

export function createWebhookMiddleware(
  config: WebhookConfig,
  replayStore?: ReplayStore
): RequestHandler {
  const store = replayStore ?? new MemoryReplayStore({
    replayWindowMs: config.replayWindowMs,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers[HEADER_SIGNATURE] as string | undefined;
    const timestamp = req.headers[HEADER_TIMESTAMP] as string | undefined;
    const eventId = req.headers[HEADER_EVENT_ID] as string | undefined;

    // Check required headers
    if (!signature || !timestamp || !eventId) {
      webhookError(res, 400, 'MALFORMED_WEBHOOK', 'Missing required webhook headers: X-Webhook-Signature, X-Webhook-Timestamp, X-Webhook-Event-Id');
      return;
    }

    // Check timestamp freshness
    if (isTimestampStale(timestamp, config.toleranceSeconds)) {
      webhookError(res, 408, 'STALE_TIMESTAMP', 'Webhook timestamp is outside the allowed window');
      return;
    }

    // Verify signature
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!verifyWebhookSignature(rawBody, signature, config.signingSecret, timestamp)) {
      webhookError(res, 401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
      return;
    }

    // Check replay
    if (store.has(eventId)) {
      webhookError(res, 409, 'DUPLICATE_EVENT', 'Webhook event has already been processed');
      return;
    }

    store.add(eventId);
    req.webhookEventId = eventId;
    next();
  };
}
