import type { Job, JobStore } from '../jobs/job-types';
import { EXPIRY_SWEEP_INTERVAL_MS } from '../jobs/runtime';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { sanitizeForLogging, type StructuredLogEntry } from '../observability/telemetry';

export const OPS_THRESHOLDS = {
  /** Queued jobs this far past their run time mean no worker is draining the queue. */
  queuedStaleMs: 5 * 60_000,
  /** Expiry sweeps run every minute; two missed sweeps is drift, not lag. */
  overdueGraceMs: 2 * EXPIRY_SWEEP_INTERVAL_MS,
  samples: 10,
  // ponytail: stale-job counts scan at most this many rows per status; add a
  // store-side count query if queues routinely exceed it.
  scanCap: 1_000,
};

export interface OpsHealthDeps {
  storage: InvoiceStorage;
  jobs?: JobStore;
  /** Recent structured logs (in-process ring buffer). */
  recentLogs: () => StructuredLogEntry[];
  now?: () => Date;
}

interface Category<T> {
  count: number;
  description: string;
  link: string;
  samples: T[];
  /** Set when the count hit OPS_THRESHOLDS.scanCap and is a lower bound. */
  truncated?: boolean;
}

/** Public keys are not secret, but a maintainer summary only needs enough to correlate. */
export function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…';
}

function redactError(message: string | undefined): string | null {
  if (!message) return null;
  const clean = String(sanitizeForLogging(message)).replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]');
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

const jobLink = (job: Job) => `/api/jobs/${job.id}`;

export async function buildOpsHealthReport(deps: OpsHealthDeps) {
  const now = deps.now?.() ?? new Date();
  const { samples, scanCap } = OPS_THRESHOLDS;
  const categories: Record<string, Category<Record<string, unknown>>> = {};
  let telemetryUnavailable = false;
  let recentLogs: StructuredLogEntry[] = [];
  try {
    recentLogs = deps.recentLogs();
  } catch {
    telemetryUnavailable = true;
  }

  if (deps.jobs) {
    const [dead, running, queued] = await Promise.all(
      (['dead', 'running', 'queued'] as const).map(status =>
        deps.jobs!.list({ status, limit: status === 'dead' ? samples : scanCap })
      )
    );

    categories.deadJobs = {
      count: dead.total,
      description: 'Jobs that exhausted retries. Inspect, fix the cause, then POST /api/jobs/:id/retry.',
      link: '/api/jobs?status=dead',
      samples: dead.jobs.map(job => ({
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        failedAt: job.updatedAt,
        lastError: redactError(job.errors[job.errors.length - 1]?.message),
        link: jobLink(job),
      })),
    };

    const queuedCutoff = now.getTime() - OPS_THRESHOLDS.queuedStaleMs;
    const stale = [
      ...running.jobs.filter(job => job.lockedUntil && Date.parse(job.lockedUntil) < now.getTime()),
      ...queued.jobs.filter(job => Date.parse(job.runAt) < queuedCutoff),
    ];
    categories.staleJobs = {
      count: stale.length,
      description:
        'Running jobs whose lease expired (worker died) or queued jobs overdue by more than 5 minutes (no worker draining).',
      link: '/api/jobs?status=running',
      samples: stale.slice(0, samples).map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        since: job.status === 'running' ? job.lockedUntil : job.runAt,
        link: jobLink(job),
      })),
      ...(running.total > scanCap || queued.total > scanCap ? { truncated: true } : {}),
    };
  }

  const overdue = await deps.storage.findOverduePendingInvoices(
    new Date(now.getTime() - OPS_THRESHOLDS.overdueGraceMs),
    samples
  );
  categories.invoiceExpiryDrift = {
    count: overdue.total,
    description:
      'PENDING invoices more than two sweep intervals past expiry: the expiry sweep job is not running or failing.',
    link: '/api/jobs?type=invoices.expire-pending',
    samples: overdue.invoices.map(invoice => ({
      id: invoice.id,
      seller: maskKey(invoice.sellerPublicKey),
      expiresAt: new Date(invoice.expiresAt).toISOString(),
      link: `/api/invoices/${invoice.id}`,
    })),
  };

  // 4xx are caller mistakes; 5xx (or failures with no status) reached a user as an outage.
  const incidents = deps
    .recentLogs()
    .filter(log => log.result === 'failure' && (log.http_status ?? 500) >= 500)
    .reverse();
  categories.serverErrors = {
    count: incidents.length,
    description:
      'Server-side failures in the recent in-process log buffer. Search logs by correlationId for the full trace.',
    link: '/api/observability/metrics',
    samples: incidents.slice(0, samples).map(log => ({
      at: log.timestamp,
      operation: log.operation,
      errorCode: log.error_code ?? null,
      httpStatus: log.http_status ?? null,
      correlationId: log.correlation_id,
    })),
  };

  if (telemetryUnavailable) {
    categories.telemetry = {
      count: 1,
      description:
        'Recent telemetry could not be read. Job and invoice checks remain available, but server-error visibility is degraded.',
      link: '/api/observability/metrics',
      samples: [],
    };
  }

  const attention = Object.entries(categories)
    .filter(([, category]) => category.count > 0)
    .map(([name]) => name);

  return {
    status: attention.length ? ('attention' as const) : ('ok' as const),
    attention,
    generatedAt: now.toISOString(),
    thresholds: OPS_THRESHOLDS,
    categories,
  };
}
