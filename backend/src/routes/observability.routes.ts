import { Router } from 'express';
import { createInvoiceHandlers, InvoiceHandlerOptions } from './invoice.handlers';

/**
 * Observability & Telemetry routes. Mount under `/api`.
 *
 * Exposes:
 *   GET /observability/metrics
 *   GET /metrics
 */
export function createObservabilityRouter(options: InvoiceHandlerOptions): Router {
  const handlers = createInvoiceHandlers(options);
  const router = Router();

  router.get('/observability/metrics', handlers.getObservabilityMetrics);
  router.get('/metrics', handlers.getPrometheusMetrics);

  return router;
}

export default createObservabilityRouter;
