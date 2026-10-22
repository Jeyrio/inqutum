import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { sendFailure, sendSuccess } from '../types/api';
import {
  EmailDeliveryService,
  emailDeliveryService,
  isValidRecipient,
  type EmailStatus,
} from '../notifications/email-delivery';
import { authenticate, mayAccessSeller, requirePermission } from '../middleware/access-control';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { EmailQueueService, emailQueueService } from '../services/email-queue.service';

export interface EmailRouterOptions {
  service?: EmailDeliveryService;
  /** When true, POST /email/webhook accepts unsigned provider callbacks. */
  allowUnsignedWebhooks?: boolean;
  /**
   * Invoice store. When given, the per-invoice routes are mounted:
   * POST /invoices/:id/send-proof and GET /invoices/:id/deliveries
   * (restored after #328 replaced this router).
   */
  storage?: InvoiceStorage;
  /** Queue for per-invoice emails. Defaults to the process-wide queue. */
  queueService?: EmailQueueService;
}

const sendEmailSchema = z.object({
  to: z.string().min(3),
  subject: z.string().min(1).max(200),
  text: z.string().max(20_000).optional(),
  html: z.string().max(50_000).optional(),
  replyTo: z.string().optional(),
  invoiceId: z.string().max(64).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

const webhookSchema = z.object({
  /** Provider message id returned on the original send. */
  messageId: z.string().min(1),
  event: z.enum(['bounce', 'complaint', 'delivered']),
  reason: z.string().max(500).optional(),
});

/** Failure categories map to stable codes so the UI can give specific advice. */
const FAILURE_CODES: Record<string, { status: number; code: string; recovery: string }> = {
  auth: {
    status: 502,
    code: 'EMAIL_AUTH_FAILED',
    recovery: 'The email provider rejected our credentials. A maintainer must fix the provider API key or SMTP username.',
  },
  quota: {
    status: 429,
    code: 'EMAIL_QUOTA_EXCEEDED',
    recovery: 'The email provider is rate limiting or out of quota. Try again later or upgrade the sending plan.',
  },
  transient: {
    status: 503,
    code: 'EMAIL_TRANSIENT_FAILURE',
    recovery: 'The email provider is temporarily unreachable. Try again in a few minutes.',
  },
  invalid_recipient: {
    status: 400,
    code: 'EMAIL_INVALID_RECIPIENT',
    recovery: 'Check the recipient address and try again.',
  },
  config: {
    status: 503,
    code: 'EMAIL_NOT_CONFIGURED',
    recovery: 'Email delivery is not configured for this deployment. See docs/EMAIL_DELIVERY.md.',
  },
  in_progress: {
    status: 409,
    code: 'EMAIL_SEND_IN_PROGRESS',
    recovery: 'A send with this idempotency key is still running. Retry in a moment to get its result.',
  },
  in_doubt: {
    status: 409,
    code: 'EMAIL_OUTCOME_IN_DOUBT',
    recovery:
      'A previous send stopped before its outcome was recorded. Check the provider log, then resolve the checkpoint (docs/RECOVERY_CHECKPOINTS.md).',
  },
  key_reused: {
    status: 422,
    code: 'EMAIL_IDEMPOTENCY_KEY_REUSED',
    recovery: 'This idempotency key was already used for a different email. Use a new key for a new message.',
  },
  permanent: {
    status: 502,
    code: 'EMAIL_FAILED',
    recovery: 'The email provider rejected this message. Check the address and content, then try again.',
  },
};

/**
 * Email delivery routes. Mount under `/api`.
 *
 *   POST /email/send      send an invoice / proof email, explicit success or failure
 *   GET  /email/deliveries?to=&status=   delivery log (bounces + complaints included)
 *   GET  /email/problems  everything not confirmed as sent
 *   POST /email/webhook   provider bounce / complaint / delivery callback
 */
export function createEmailRouter(options: EmailRouterOptions = {}): Router {
  const service = options.service ?? emailDeliveryService;
  const router = Router();

  router.post('/email/send', async (req: Request, res: Response) => {
    const parsed = sendEmailSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendFailure(res, 400, 'Invalid email request', {
        code: 'EMAIL_REQUEST_INVALID',
        correlationId: req.correlationId,
      });
    }

    const body = parsed.data;
    if (!isValidRecipient(body.to)) {
      return sendFailure(res, 400, 'Recipient is not a valid email address', {
        code: 'EMAIL_INVALID_RECIPIENT',
        correlationId: req.correlationId,
      });
    }

    const result = await service.deliver({
      to: body.to,
      subject: body.subject,
      text: body.text,
      html: body.html,
      replyTo: body.replyTo,
      idempotencyKey: body.idempotencyKey ?? (body.invoiceId ? `invoice:${body.invoiceId}` : undefined),
      metadata: body.invoiceId ? { invoiceId: body.invoiceId } : undefined,
    });

    // Success is reported explicitly, never implied by a 2xx with no body.
    if (result.ok) {
      return sendSuccess(
        res,
        200,
        {
          status: result.status,
          deliveryId: result.delivery?.id,
          providerMessageId: result.delivery?.providerMessageId,
        },
        { message: result.message, correlationId: req.correlationId }
      );
    }

    const mapping = FAILURE_CODES[result.category ?? 'permanent'] ?? FAILURE_CODES.permanent;
    return sendFailure(res, mapping.status, result.message ?? 'Email delivery failed', {
      code: mapping.code,
      category:
        result.category === 'quota'
          ? 'RATE_LIMIT'
          : result.category === 'in_progress' || result.category === 'in_doubt' || result.category === 'key_reused'
            ? 'LIFECYCLE'
            : 'NETWORK',
      retryable: result.retryable ?? false,
      recoveryAction: mapping.recovery,
      correlationId: req.correlationId,
    });
  });

  router.get('/email/deliveries', (req: Request, res: Response) => {
    const status = req.query.status as EmailStatus | undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const deliveries = service.listDeliveries({
      to: req.query.to ? String(req.query.to) : undefined,
      status,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return sendSuccess(res, 200, { deliveries, count: deliveries.length }, {
      correlationId: req.correlationId,
    });
  });

  // Bounce / complaint visibility: everything that was not confirmed as sent.
  router.get('/email/problems', (_req: Request, res: Response) => {
    const problems = service.listProblems();
    return sendSuccess(res, 200, { problems, count: problems.length });
  });

  router.post('/email/webhook', (req: Request, res: Response) => {
    const parsed = webhookSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendFailure(res, 400, 'Invalid webhook payload', {
        code: 'EMAIL_WEBHOOK_INVALID',
        correlationId: req.correlationId,
      });
    }

    const { messageId, event, reason } = parsed.data;
    const record =
      event === 'bounce'
        ? service.recordBounce(messageId, reason)
        : event === 'complaint'
          ? service.recordComplaint(messageId, reason)
          : service.getStore().findByProviderMessageId(messageId);

    if (!record) {
      return sendFailure(res, 404, 'No delivery matches that message id', {
        code: 'EMAIL_DELIVERY_NOT_FOUND',
        correlationId: req.correlationId,
      });
    }

    return sendSuccess(res, 200, { delivery: record }, { correlationId: req.correlationId });
  });

  if (options.storage) {
    mountInvoiceEmailRoutes(router, options.storage, options.queueService ?? emailQueueService);
  }

  return router;
}

function mountInvoiceEmailRoutes(router: Router, storage: InvoiceStorage, queue: EmailQueueService): void {
  // Queue a payment-proof email for a paid invoice. 202: delivery is async.
  router.post(
    '/invoices/:id/send-proof',
    authenticate(),
    requirePermission('invoice:email'),
    async (req: Request, res: Response) => {
      try {
        const invoice = await storage.getInvoiceById(req.params.id);
        if (!invoice) return sendFailure(res, 404, 'Invoice not found', 'INVOICE_NOT_FOUND');
        if (invoice.status !== 'PAID') {
          return sendFailure(res, 400, 'Payment proof is only available for paid invoices', 'INVOICE_NOT_PAID');
        }

        const { recipientEmail, subject, text, html } = req.body ?? {};
        const targetEmail = recipientEmail || invoice.payerEmail || invoice.customerEmail || invoice.sellerEmail;
        if (!targetEmail) return sendFailure(res, 400, 'Recipient email is required', 'MISSING_RECIPIENT_EMAIL');

        const result = await queue.enqueue({
          invoiceId: invoice.id,
          recipientEmail: targetEmail,
          senderWallet: invoice.sellerPublicKey,
          emailType: 'PAYMENT_PROOF',
          subject: subject || `Payment Receipt: ${invoice.memo}`,
          payload: {
            text:
              text ||
              `Your payment for invoice ${invoice.memo} (${invoice.amount} ${invoice.assetCode}) was confirmed on Stellar. Tx: ${invoice.paymentTxHash}`,
            html,
            invoice,
          },
        } as any);

        if (!result.success) {
          if (result.code === 'EMAIL_RATE_LIMIT_EXCEEDED' || result.code === 'QUOTA_EXCEEDED') {
            res.set('Retry-After', String(result.retryAfterSeconds || 3600));
            return sendFailure(res, 429, result.error || 'Too many emails', result.code);
          }
          return sendFailure(res, 400, result.error || 'Failed to queue proof email', result.code);
        }
        return sendSuccess(res, 202, result.delivery, { message: 'Payment proof email queued for delivery' });
      } catch (error: any) {
        return sendFailure(res, 500, error.message || 'Failed to send payment proof email');
      }
    }
  );

  // Delivery status for the invoice's owner (or an operator).
  router.get(
    '/invoices/:id/deliveries',
    authenticate(),
    requirePermission('invoice:deliveries'),
    async (req: Request, res: Response) => {
      try {
        const invoice = await storage.getInvoiceById(req.params.id);
        if (!invoice) return sendFailure(res, 404, 'Invoice not found', 'INVOICE_NOT_FOUND');
        if (!mayAccessSeller(req.actor, 'invoice:deliveries', invoice.sellerPublicKey)) {
          return sendFailure(res, 403, 'You can only view deliveries for your own invoices', 'FORBIDDEN');
        }
        return sendSuccess(res, 200, await queue.getInvoiceDeliveries(invoice.id));
      } catch (error: any) {
        return sendFailure(res, 500, error.message || 'Failed to get email deliveries');
      }
    }
  );
}

export default createEmailRouter;
