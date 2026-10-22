import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { createInvoiceHandlers, isSimulationEnabled, InvoiceHandlerOptions } from './invoice.handlers';
import { authenticate, requirePermission } from '../middleware/access-control';
import { sendFailure } from '../types/api';
import { idempotency } from '../idempotency/middleware';
import { MemoryIdempotencyStore } from '../idempotency/memory-store';
import type { IdempotencyStore } from '../idempotency/store';
import {
  createInvoiceRateLimiters,
  createVerifyRateLimiters,
  createGetInvoicesRateLimiter,
  createInvoiceReadRateLimiter,
  createCancelInvoiceRateLimiter,
  verifyConcurrencyLock,
} from '../middleware/rate-limit';
import { createInvoiceCeilingMiddleware } from '../middleware/invoice-ceiling';
import { isDemoEnvironment } from '../config/runtime';

export interface InvoiceRouterOptions extends InvoiceHandlerOptions {
  enableRateLimiting?: boolean;
  enableConcurrencyLock?: boolean;
  enableCeilingCheck?: boolean;
  invoiceCeiling?: number;
  /**
   * Where `Idempotency-Key` outcomes are remembered. Defaults to an in-process
   * store; the Postgres server passes the durable one so retries survive a
   * restart and reach whichever instance handles them.
   */
  idempotencyStore?: IdempotencyStore;
}

/**
 * Invoice routes shared by both servers. Mount under `/api`.
 *
 * Route list is kept identical between server.ts (Postgres) and
 * server-mvp.ts (in-memory):
 *   POST   /invoices
 *   GET    /invoices/lifecycle
 *   GET    /invoices/stats
 *   GET    /invoices
 *   GET    /invoices/:id
 *   GET    /invoices/:id/payment-info
 *   POST   /invoices/:id/cancel (seller authorized)
 *   POST   /invoices/:id/verify
 *   POST   /invoices/:id/simulate-payment
 *   GET    /invoices/:id/audit
 *   GET    /invoices/:id/email-preview
 *   POST   /invoices/:id/send-email
 *
 * The four writes (create, cancel, verify, simulate) honour an optional
 * `Idempotency-Key` header; see docs/IDEMPOTENCY.md.
 *
 * Every route declares the permission it needs (see shared/access-control.ts),
 * checked before any handler runs. Handlers then apply the resource-level rule
 * for owner-scoped permissions ("only your own invoices"). A route added here
 * without a `requirePermission` guard fails tests/access-control.test.ts.
 */
export function createInvoiceRouter(options: InvoiceRouterOptions): Router {
  const handlers = createInvoiceHandlers(options);
  const router = Router();
  const retrySafe = idempotency({
    store: options.idempotencyStore ?? new MemoryIdempotencyStore(),
  });

  // Resolve the caller on every invoice route. This never rejects; the
  // per-route guards below decide.
  router.use('/invoices', authenticate());

  const isDemo = isDemoEnvironment();
  const enableRateLimiting =
    options.enableRateLimiting ??
    (process.env.ENABLE_RATE_LIMITING === 'true' || process.env.NODE_ENV === 'production' || isDemo);

  const enableConcurrencyLock =
    options.enableConcurrencyLock ??
    (process.env.ENABLE_VERIFY_CONCURRENCY_LOCK === 'true' || process.env.NODE_ENV === 'production' || isDemo);

  const enableCeilingCheck =
    options.enableCeilingCheck ??
    (process.env.ENABLE_INVOICE_CEILING === 'true' ||
      process.env.NODE_ENV === 'production' ||
      isDemo ||
      options.invoiceCeiling !== undefined);

  const createMiddlewares: RequestHandler[] = [];
  if (enableCeilingCheck && options.storage.countInvoices) {
    createMiddlewares.push(
      createInvoiceCeilingMiddleware(() => options.storage.countInvoices!(), {
        ceiling: options.invoiceCeiling,
      })
    );
  }
  if (enableRateLimiting) {
    createMiddlewares.push(...createInvoiceRateLimiters());
  }

  router.post(
    '/invoices',
    requirePermission('invoice:create'),
    // Before the ceiling and rate limits: a retry of a create that already
    // succeeded is a replay, not new load, and must not be refused as "full".
    retrySafe,
    ...createMiddlewares,
    handlers.createInvoice
  );
  // Static routes stay before the dynamic /invoices/:id so they are not shadowed.
  router.get('/invoices/lifecycle', requirePermission('lifecycle:read'), handlers.getLifecycle);
  router.get('/invoices/stats', requirePermission('invoice:stats'), handlers.getStats);

  const getInvoicesMiddlewares: RequestHandler[] = [];
  if (enableRateLimiting) {
    getInvoicesMiddlewares.push(createGetInvoicesRateLimiter());
  }
  router.get(
    '/invoices',
    requirePermission('invoice:list'),
    ...getInvoicesMiddlewares,
    handlers.getInvoices
  );

  const readMiddlewares: RequestHandler[] = [];
  if (enableRateLimiting) {
    readMiddlewares.push(createInvoiceReadRateLimiter());
  }
  router.get(
    '/invoices/:id',
    requirePermission('invoice:read'),
    ...readMiddlewares,
    handlers.getInvoice
  );

  // GET /invoices/:id/payment-info — higher read budget so pay-page polling is not 429'd
  router.get(
    '/invoices/:id/payment-info',
    requirePermission('invoice:read'),
    ...readMiddlewares,
    handlers.getPaymentInfo
  );
  router.get('/invoices/:id/audit', requirePermission('invoice:audit'), handlers.getAuditTrail);

  const cancelMiddlewares: RequestHandler[] = [];
  const cancelAuthPreCheck: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const requireSig =
      options.requireCancelSignature ?? (process.env.REQUIRE_CANCEL_SIGNATURE === 'true');
    if (requireSig) {
      const sellerKey =
        req.body?.sellerPublicKey || req.headers['x-seller-public-key'] || req.query?.sellerPublicKey;
      const signature =
        req.body?.signature || req.headers['x-signature'] || req.headers['x-seller-signature'];
      if (!sellerKey || !signature) {
        return res.status(401).json({
          success: false,
          code: 'UNAUTHORIZED',
          error: 'Cancellation requires seller proof of ownership (signature)',
        });
      }
    }
    next();
  };
  cancelMiddlewares.push(cancelAuthPreCheck);
  if (enableRateLimiting) {
    cancelMiddlewares.push(createCancelInvoiceRateLimiter());
  }
  router.post(
    '/invoices/:id/cancel',
    requirePermission('invoice:cancel'),
    retrySafe,
    ...cancelMiddlewares,
    handlers.cancelInvoice
  );

  const verifyMiddlewares: RequestHandler[] = [];
  if (enableConcurrencyLock) {
    verifyMiddlewares.push(verifyConcurrencyLock());
  }
  if (enableRateLimiting) {
    verifyMiddlewares.push(...createVerifyRateLimiters());
  }
  router.post(
    '/invoices/:id/verify',
    requirePermission('invoice:verify'),
    retrySafe,
    ...verifyMiddlewares,
    handlers.verifyPayment
  );

  // A switched-off simulate endpoint must look like it does not exist, so the
  // switch is checked before authentication can leak that the route is real.
  const simulationSwitch: RequestHandler = (_req, res, next) =>
    isSimulationEnabled(options)
      ? next()
      : sendFailure(res, 404, 'Endpoint not found');
  router.post(
    '/invoices/:id/simulate-payment',
    simulationSwitch,
    requirePermission('invoice:simulate'),
    retrySafe,
    handlers.simulatePayment
  );

  // Invoice email (#58). Open to the payer like the pay page itself; the
  // handlers render only the invoice's own non-sensitive fields.
  router.get('/invoices/:id/email-preview', requirePermission('invoice:email'), handlers.getEmailPreview);
  router.post('/invoices/:id/send-email', requirePermission('invoice:email'), retrySafe, handlers.sendInvoiceEmail);

  return router;
}

export default createInvoiceRouter;
