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

  router.post('/invoices', handlers.createInvoice);
  // Must stay before the dynamic /invoices/:id route to avoid shadowing.
  router.get('/invoices/stats', handlers.getStats);
  router.get('/invoices', handlers.getInvoices);
  router.get('/invoices/:id', handlers.getInvoice);
  router.get('/invoices/:id/payment-info', handlers.getPaymentInfo);
  router.post('/invoices/:id/cancel', handlers.cancelInvoice);
  router.post('/invoices/:id/verify', handlers.verifyPayment);
  router.post('/invoices/:id/simulate-payment', handlers.simulatePayment);
  router.get('/invoices/:id/email-preview', handlers.getEmailPreview);
  router.post('/invoices/:id/send-email', handlers.sendInvoiceEmail);

  return router;
}

export default createInvoiceRouter;
