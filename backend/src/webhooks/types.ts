import 'express';

declare global {
  namespace Express {
    interface Request {
      webhookEventId?: string;
    }
  }
}

export interface WebhookConfig {
  signingSecret: string;
  toleranceSeconds: number;
  replayWindowMs: number;
}
