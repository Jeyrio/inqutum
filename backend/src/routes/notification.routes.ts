import { Request, Response, Router } from 'express';
import { stellarPublicKeySchema } from '../utils/validation';
import { sendFailure, sendSuccess } from '../types/api';
import { NotificationService, notificationService } from '../notifications/notification-service';
import {
  MANDATORY_NOTIFICATION_CATEGORIES,
  notificationPreferencePatchSchema,
  type RecipientNotificationPreferences,
} from '../notifications/notification-preference';
import { authenticate, mayAccessSeller, requirePermission } from '../middleware/access-control';
import { ANONYMOUS_ACTOR } from '../auth/actor';
import type { AuditActor } from '../audit/audit-service';

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

/**
 * Preferences plus the categories routing will deliver regardless of them.
 * Additive: every field the response had before is unchanged.
 */
const withMandatoryCategories = (preferences: RecipientNotificationPreferences) => ({
  ...preferences,
  mandatoryCategories: [...MANDATORY_NOTIFICATION_CATEGORIES],
});

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
 *   GET  /notifications/preferences?recipient=
 *   PUT  /notifications/preferences   { recipient, channels?, categories? }
 *   GET  /notifications/routing-audit?recipient=
 *
 * Changing preferences is the one write that can silence someone else's
 * alerts, so it alone requires a credential: the recipient's own wallet
 * session, or a maintainer acting for them (Issue #193). Reads keep the
 * recipient-scoped model the rest of this router uses.
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
    sendSuccess(res, 200, withMandatoryCategories(preferences));
  });

  router.put(
    '/notifications/preferences',
    authenticate(),
    requirePermission('notification:preferences:write'),
    (req, res) => {
      const recipient = recipientOf(req, res);
      if (!recipient) return;

      const actor = req.actor ?? ANONYMOUS_ACTOR;
      if (!mayAccessSeller(actor, 'notification:preferences:write', recipient)) {
        return sendFailure(res, 403, 'You can only change your own notification preferences', {
          code: 'FORBIDDEN',
          correlationId: req.correlationId,
        });
      }

      // `recipient` addresses the resource; everything else must be a valid patch.
      const { recipient: _recipient, ...body } = req.body ?? {};
      const parsed = notificationPreferencePatchSchema.safeParse(body);
      if (!parsed.success) {
        // The "at least one preference" refinement also fires when every key
        // was unknown; report it only when it is the sole problem.
        const specific = parsed.error.issues.filter((i) => i.code !== 'custom');
        const issues = (specific.length > 0 ? specific : parsed.error.issues)
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; ');
        return sendFailure(res, 400, `Notification preference update is invalid: ${issues}`, {
          code: 'INVALID_NOTIFICATION_PREFERENCES',
          correlationId: req.correlationId,
        });
      }

      const changedBy: AuditActor =
        actor.role === 'maintainer'
          ? { type: 'maintainer', id: actor.subject }
          : { type: 'seller', id: actor.wallet ?? recipient };
      const preferences = service.savePreferences(recipient, parsed.data, {
        changedBy,
        correlationId: req.correlationId,
      });
      sendSuccess(res, 200, withMandatoryCategories(preferences));
    }
  );

  router.get('/notifications/routing-audit', (req, res) => {
    const recipient = recipientOf(req, res);
    if (!recipient) return;
    const records = service.getRoutingAudit(recipient);
    sendSuccess(res, 200, { records, total: records.length });
  });

  return router;
}

export default createNotificationRouter;
