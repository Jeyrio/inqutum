import { Router, Request, Response } from 'express';
import { createWebhookMiddleware } from '../webhooks/webhook-middleware';
import { sendSuccess } from '../types/api';
import type { WebhookConfig } from '../webhooks/types';

export interface WebhookRouterOptions {
  signingSecret?: string;
}

/**
 * Webhook routes. Only mounted when WEBHOOK_SIGNING_SECRET is set.
 */
export function createWebhookRouter(options: WebhookRouterOptions): Router | null {
  const secret = options.signingSecret || process.env.WEBHOOK_SIGNING_SECRET;
  if (!secret) return null;

  const config: WebhookConfig = {
    signingSecret: secret,
    toleranceSeconds: 300, // 5 minutes
    replayWindowMs: 5 * 60 * 1000,
  };

  const router = Router();
  const verify = createWebhookMiddleware(config);

  router.post('/webhooks/incoming', verify, async (req: Request, res: Response) => {
    const eventId = req.webhookEventId;
    const payload = req.body;

    console.log(`Webhook received: event=${eventId}, type=${payload?.type || 'unknown'}`);

    sendSuccess(res, 200, {
      received: true,
      eventId,
    });
  });

  return router;
}
