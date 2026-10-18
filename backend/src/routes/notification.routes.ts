import { Request, Response, Router } from 'express';
import { stellarPublicKeySchema } from '../utils/validation';
import { sendFailure, sendSuccess } from '../types/api';
import { NotificationService, notificationService } from '../notifications/notification-service';

export interface NotificationRouterOptions {
  service?: NotificationService;
}

function recipientOf(req: Request, res: Response): string | null {
  const raw = req.query.recipient ?? req.body?.recipient;
  const parsed = stellarPublicKeySchema.safeParse(raw);
  if (!parsed.success) {
    sendFailure(res, 400, 'recipient must be a valid Stellar public key', {
      code: 'RECIPIENT_REQUIRED',
      correlationId: req.correlationId,
    });
    return null;
  }
  return parsed.data;
}

const int = (v: unknown, fallback: number) => {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Notification routes. Mount under `/api`. Every route is scoped to the
 * `recipient` wallet, the same identity model the invoice routes use.
 *
 *   GET  /notifications?recipient=&unread=true&limit=&offset=
 *   GET  /notifications/unread-count?recipient=
 *   POST /notifications/read-all      { recipient }
 *   POST /notifications/:id/read      { recipient }
 */
export function createNotificationRouter(options: NotificationRouterOptions = {}): Router {
  const service = options.service ?? notificationService;
  const router = Router();

  router.get('/notifications', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    const page = service.list(recipient, {
      unreadOnly: req.query.unread === 'true',
      limit: int(req.query.limit, 50),
      offset: int(req.query.offset, 0),
    });
    sendSuccess(res, 200, { notifications: page.notifications, unread: page.unread }, {
      pagination: { limit: page.limit, offset: page.offset, total: page.total },
    });
  });

  router.get('/notifications/unread-count', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    sendSuccess(res, 200, { unread: service.unreadCount(recipient) });
  });

  router.post('/notifications/read-all', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    sendSuccess(res, 200, { updated: service.markAllRead(recipient) });
  });

  router.post('/notifications/:id/read', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    const notification = service.markRead(recipient, req.params.id);
    if (!notification) {
      return sendFailure(res, 404, 'Notification not found', {
        code: 'NOTIFICATION_NOT_FOUND',
        correlationId: req.correlationId,
      });
    }
    sendSuccess(res, 200, notification);
  });

  router.get('/notifications/preferences', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    const preferences = service.getPreferences(recipient);
    sendSuccess(res, 200, preferences);
  });

  router.put('/notifications/preferences', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    const patch = {
      channels: req.body?.channels,
      categories: req.body?.categories,
    };
    const preferences = service.savePreferences(recipient, patch);
    sendSuccess(res, 200, preferences);
  });

  router.get('/notifications/routing-audit', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    const records = service.getRoutingAudit(recipient);
    sendSuccess(res, 200, { records, total: records.length });
  });

  return router;
}

export default createNotificationRouter;
