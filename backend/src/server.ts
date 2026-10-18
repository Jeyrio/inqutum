import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import routes from './routes';
import { pool } from './config/database';
import { validateStellarConfig, SELLER_PUBLIC_KEY } from './config/stellar';
import paymentMonitorService from './services/payment-monitor.service';
import { assertSafeEnvironment, configuredFrontendOrigins, corsOptions } from './config/runtime';
import postgresInvoiceStorage from './storage/postgres-invoice-storage';
import { securityHeaders } from './security/content-safety';
import { correlationMiddleware } from './observability/telemetry';
import invoiceService from './services/invoice.service';
import { JobQueue, JobWorker } from './jobs/worker';
import { PostgresJobStore } from './jobs/postgres-job-store';
import { registerJobHandlers, startExpiryScheduler } from './jobs/runtime';
import { buildUserSafeErrorResponse, classifyError } from './errors/error-taxonomy';
import { validateEnvironment } from './config/env-validator';

dotenv.config();
assertSafeEnvironment();

const envCheck = validateEnvironment(process.env, { strict: process.env.NODE_ENV === 'production' });
if (envCheck.issues.length > 0 && process.env.NODE_ENV !== 'test') {
  console.warn(`⚠️ Configuration warnings detected:\n  - ${envCheck.issues.join('\n  - ')}`);
}

const app: Application = express();
const PORT = envCheck.validated.PORT || process.env.PORT || 3001;

// Background jobs: the expiry sweep runs through the worker framework. Set
// JOBS_EMBEDDED_WORKER=false to run workers only via `npm run worker`.
const jobStore = new PostgresJobStore(pool);
const jobWorker = registerJobHandlers(new JobWorker({ store: jobStore }), {
  expirePendingInvoices: () => invoiceService.markExpiredInvoices(),
});
let stopExpiryScheduler: (() => void) | null = null;

// Correlation ID & Latency Tracking
app.use(correlationMiddleware());

// Restrictive security headers on every API response
app.use(securityHeaders());

app.use(cors(corsOptions()));

app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} [${req.correlationId}] - ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Quittance API',
    version: '1.0.0',
    status: 'running',
    mode: postgresInvoiceStorage.mode,
    documentation: '/api/health',
  });
});

// User-Safe Error handling middleware with taxonomy and correlation tracking
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  if ((err as any).type === 'entity.too.large' || (err as any).status === 413 || (err as any).statusCode === 413) {
    return res.status(413).json({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: 'Payload too large: request body exceeds 16 kB limit',
    });
  }
  console.error('Unhandled error:', err);
  const classified = classifyError(err);
  const status = (err as any).code === 'CORS_ORIGIN_DENIED' ? 403 : classified.httpStatus || 500;
  const payload = buildUserSafeErrorResponse(err, req.correlationId);

  res.status(status).json(payload);
});

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    error: 'Endpoint not found',
    correlationId: req.correlationId,
  });
});

// Retention sweep (issue #61). Report-only: the scheduler calls plan(), which
// performs no writes, so this cannot delete anything on its own. Report-only
// datasets (settlement, financial) are refused by apply() regardless.
const retentionService = new RetentionService(new PostgresRetentionStore(pool));
let stopRetentionScheduler: (() => void) | null = null;

async function initialize() {
  try {
    console.log('Starting server...');
    await pool.query('SELECT NOW()');
    console.log('Database connected');

    stopRetentionScheduler = startRetentionScheduler(retentionService, {
      onReport: (plan) => {
        const eligible = Object.values(plan.wouldDelete).reduce((sum, n) => sum + n, 0);
        if (eligible > 0) {
          console.log(
            `Retention: ${eligible} row(s) past their window. Report-only; nothing deleted. ` +
              'Run the sweep with apply: true to act on this.'
          );
        }
      },
      onError: (error) => console.error('Retention sweep failed:', error),
    });

    if (SELLER_PUBLIC_KEY) {
      validateStellarConfig();
      paymentMonitorService.start();
    } else {
      console.log('Wallet-scoped mode: no SELLER_PUBLIC_KEY, payment monitor disabled');
    }

    if (process.env.JOBS_EMBEDDED_WORKER !== 'false') {
      jobWorker.start();
      stopExpiryScheduler = startExpiryScheduler(new JobQueue(jobStore));
    }
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
}

export function startServer(port: number | string = PORT) {
  return app.listen(port, async () => {
    await initialize();
    console.log('\n🚀 Quittance Backend (Postgres Mode)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Server running on port ${port}`);
    console.log(`📍 API: http://localhost:${port}/api`);
    console.log(`🏥 Health: http://localhost:${port}/api/health`);
    console.log(`💾 Storage: PostgreSQL`);
    console.log(`💰 Dynamic Seller: Each user uses their own wallet!`);
    console.log(`🌐 Frontends: ${configuredFrontendOrigins().join(', ') || 'not configured'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
}

const entryPoint = process.argv[1] ?? '';
if (/server(\.[cm]?[jt]s)?$/.test(entryPoint)) {
  startServer();
}

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  stopRetentionScheduler?.();
  paymentMonitorService.stop();
  jobWorker.stop();
  stopExpiryScheduler?.();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  stopRetentionScheduler?.();
  paymentMonitorService.stop();
  jobWorker.stop();
  stopExpiryScheduler?.();
  await pool.end();
  process.exit(0);
});

export default app;
