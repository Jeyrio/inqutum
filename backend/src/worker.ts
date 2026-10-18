// Standalone worker process: `npm run worker`. Runs the same handlers as the
// embedded worker in server.ts, against the shared PostgreSQL `jobs` table.
import dotenv from 'dotenv';
import { pool } from './config/database';
import invoiceService from './services/invoice.service';
import { JobQueue, JobWorker } from './jobs/worker';
import { PostgresJobStore } from './jobs/postgres-job-store';
import { registerJobHandlers, startExpiryScheduler } from './jobs/runtime';

dotenv.config();

const store = new PostgresJobStore(pool);
const worker = registerJobHandlers(new JobWorker({ store }), {
  expirePendingInvoices: () => invoiceService.markExpiredInvoices(),
});
const stopScheduler = startExpiryScheduler(new JobQueue(store));

worker.start();
console.log('[jobs] standalone worker started');

async function shutdown() {
  worker.stop();
  stopScheduler();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
