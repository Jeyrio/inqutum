import { Router } from 'express';
import { createInvoiceHandlers, InvoiceHandlerOptions } from './invoice.handlers';

/**
 * Audit trail routes. Mount under `/api`.
 *
 * Exposes:
 *   GET /invoices/:id/audit-trail
 *   GET /audit/events
 *   GET /audit/export
 */
export function createAuditRouter(options: InvoiceHandlerOptions): Router {
  const handlers = createInvoiceHandlers(options);
  const router = Router();

  router.get('/invoices/:id/audit-trail', handlers.getInvoiceAuditTrail);
  router.get('/audit/events', handlers.getAuditEvents);
  router.get('/audit/export', handlers.exportAuditTrail);

  return router;
}

export default createAuditRouter;
