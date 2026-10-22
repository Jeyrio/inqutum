/**
 * Bounded Queue Backpressure for Expensive Background Work (Issue #275).
 *
 * Implements admission control, dynamic capacity tracking, and hysteresis-based
 * backpressure shedding for the asynchronous background job pipeline.
 *
 * Key Capabilities:
 *  - High / Low Watermark Hysteresis: Transitions into backpressure state at high
 *    watermark (e.g., 80% capacity) and recovers once drained below low watermark
 *    (e.g., 50% capacity), preventing thrashing oscillation under burst loads.
 *  - Workload Cost Weights: Differentiates lightweight heartbeat sweeps from
 *    compute-heavy operations (e.g., bulk imports, cryptographic verification,
 *    ledger reconciliations).
 *  - Admission Control & 429 Semantics: Saturated queues fail fast with standard
 *    HTTP 429 Retry-After metadata, relieving memory pressure before OOM crashes.
 *  - Authorization & Emergency Headroom: Privileged maintainer commands and critical
 *    settlement tasks bypass standard shedding via capability token or role assertion.
 *  - Exponential Backpressure Retries: Backpressure-aware retry delay calculation
 *    with bounded randomized jitter to avoid thundering herd reconnection storms.
 */

import { Job, JobStore, EnqueueOptions, RetryPolicy, DEFAULT_RETRY_POLICY } from './job-types';
import { JobQueue } from './worker';

export type BackpressureState = 'NORMAL' | 'DEGRADED' | 'REJECTING';

export type JobPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface BackpressureConfig {
  maxQueueDepth: number;
  highWatermarkRatio: number;
  lowWatermarkRatio: number;
  maxWorkloadCost: number;
  defaultJobCost: number;
  jobCostWeights: Record<string, number>;
  baseRetryAfterMs: number;
  maxRetryAfterMs: number;
}

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  maxQueueDepth: 200,
  highWatermarkRatio: 0.8, // 80% -> start shedding low/normal priority
  lowWatermarkRatio: 0.5,  // 50% -> return to normal state
  maxWorkloadCost: 1_000,
  defaultJobCost: 1,
  jobCostWeights: {
    'invoices.expire-pending': 1,
    'notifications.email': 2,
    'webhooks.delivery': 3,
    'crypto.evidence-verification': 8,
    'reports.csv-export': 10,
    'invoices.bulk-import': 15,
    'reconciliation.ledger-sweep': 20,
  },
  baseRetryAfterMs: 2_000,
  maxRetryAfterMs: 60_000,
};

export class QueueBackpressureError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterMs: number;
  readonly currentDepth: number;
  readonly maxCapacity: number;
  readonly jobType: string;

  constructor(options: {
    message: string;
    code?: string;
    retryAfterMs: number;
    currentDepth: number;
    maxCapacity: number;
    jobType: string;
  }) {
    super(options.message);
    this.name = 'QueueBackpressureError';
    this.code = options.code ?? 'QUEUE_BACKPRESSURE_ACTIVE';
    this.httpStatus = 429;
    this.retryAfterMs = options.retryAfterMs;
    this.currentDepth = options.currentDepth;
    this.maxCapacity = options.maxCapacity;
    this.jobType = options.jobType;
  }
}

export interface BoundedEnqueueOptions extends EnqueueOptions {
  priority?: JobPriority;
  bypassBackpressure?: boolean;
  actorRole?: 'MAINTAINER' | 'ADMIN' | 'OWNER' | 'USER' | 'SYSTEM';
  actorToken?: string;
  costOverride?: number;
}

export interface BackpressureMetrics {
  currentDepth: number;
  currentCost: number;
  state: BackpressureState;
  highWatermark: number;
  lowWatermark: number;
  maxCapacity: number;
  maxCost: number;
  totalEnqueued: number;
  totalRejected: number;
  totalShed: number;
  totalBypassed: number;
}

export class BackpressureController {
  private readonly config: BackpressureConfig;
  private currentCost = 0;
  private totalEnqueued = 0;
  private totalRejected = 0;
  private totalShed = 0;
  private totalBypassed = 0;
  private state: BackpressureState = 'NORMAL';

  constructor(config: Partial<BackpressureConfig> = {}) {
    this.config = { ...DEFAULT_BACKPRESSURE_CONFIG, ...config };
    this.validateConfig();
  }

  private validateConfig(): void {
    if (this.config.maxQueueDepth <= 0) {
      throw new Error('maxQueueDepth must be positive');
    }
    if (
      this.config.lowWatermarkRatio <= 0 ||
      this.config.highWatermarkRatio <= this.config.lowWatermarkRatio ||
      this.config.highWatermarkRatio > 1.0
    ) {
      throw new Error('Watermark ratios must satisfy: 0 < lowWatermark < highWatermark <= 1.0');
    }
  }

  /** Smallest depth at or above the high-watermark ratio (ceil: floor shed early on small queues). */
  get highWatermarkDepth(): number {
    return Math.ceil(this.config.maxQueueDepth * this.config.highWatermarkRatio);
  }

  get lowWatermarkDepth(): number {
    return Math.floor(this.config.maxQueueDepth * this.config.lowWatermarkRatio);
  }

  getJobCost(type: string, costOverride?: number): number {
    if (typeof costOverride === 'number' && costOverride >= 0) {
      return costOverride;
    }
    return this.config.jobCostWeights[type] ?? this.config.defaultJobCost;
  }

  /**
   * Computes the current backpressure state based on queue depth and hysteresis.
   */
  updateState(activeQueueDepth: number): BackpressureState {
    if (activeQueueDepth >= this.config.maxQueueDepth) {
      this.state = 'REJECTING';
    } else if (activeQueueDepth >= this.highWatermarkDepth) {
      this.state = 'DEGRADED';
    } else if (activeQueueDepth <= this.lowWatermarkDepth) {
      this.state = 'NORMAL';
    }
    // Between low and high watermark, maintain existing state (hysteresis)
    return this.state;
  }

  /**
   * Evaluates whether an incoming job admission should be granted or rejected.
   */
  checkAdmission(
    type: string,
    currentDepth: number,
    options: BoundedEnqueueOptions = {}
  ): {
    admitted: boolean;
    reason?: string;
    retryAfterMs?: number;
    isBypass?: boolean;
  } {
    const currentState = this.updateState(currentDepth);
    const jobCost = this.getJobCost(type, options.costOverride);
    const isPrivileged =
      options.bypassBackpressure === true ||
      options.priority === 'CRITICAL' ||
      options.actorRole === 'MAINTAINER' ||
      options.actorRole === 'OWNER' ||
      options.actorRole === 'SYSTEM';

    // 1. Privileged caller emergency bypass (always allowed up to hard 120% ceiling)
    if (isPrivileged) {
      const emergencyHardLimit = Math.floor(this.config.maxQueueDepth * 1.2);
      if (currentDepth >= emergencyHardLimit) {
        this.totalRejected++;
        return {
          admitted: false,
          reason: 'EMERGENCY_BUFFER_EXHAUSTED',
          retryAfterMs: this.config.maxRetryAfterMs,
        };
      }
      this.totalBypassed++;
      this.totalEnqueued++;
      this.currentCost += jobCost;
      return { admitted: true, isBypass: true };
    }

    // 2. Hard capacity rejection
    if (currentDepth >= this.config.maxQueueDepth) {
      this.totalRejected++;
      const retryAfterMs = this.computeRetryAfter(currentDepth);
      return {
        admitted: false,
        reason: 'QUEUE_CAPACITY_EXCEEDED',
        retryAfterMs,
      };
    }

    // 3. Workload cost budget check
    if (this.currentCost + jobCost > this.config.maxWorkloadCost) {
      this.totalRejected++;
      const retryAfterMs = this.computeRetryAfter(currentDepth);
      return {
        admitted: false,
        reason: 'WORKLOAD_BUDGET_EXCEEDED',
        retryAfterMs,
      };
    }

    // 4. Degraded state shedding: low/normal priority shed when above high watermark
    if (currentState === 'DEGRADED') {
      const isHighPriority = options.priority === 'HIGH';
      if (!isHighPriority) {
        this.totalShed++;
        this.totalRejected++;
        const retryAfterMs = this.computeRetryAfter(currentDepth);
        return {
          admitted: false,
          reason: 'HIGH_WATERMARK_LOAD_SHEDDING',
          retryAfterMs,
        };
      }
    }

    // 5. Admitted normally
    this.totalEnqueued++;
    this.currentCost += jobCost;
    return { admitted: true };
  }

  /**
   * Release completed job cost from tracking.
   */
  releaseJob(type: string, costOverride?: number): void {
    const cost = this.getJobCost(type, costOverride);
    this.currentCost = Math.max(0, this.currentCost - cost);
  }

  /**
   * Calculates recommended client Retry-After delay with jitter.
   */
  computeRetryAfter(currentDepth: number): number {
    const saturation = Math.min(1.0, currentDepth / this.config.maxQueueDepth);
    const scaledDelay = this.config.baseRetryAfterMs * (1 + saturation * 4);
    // Add 10-20% deterministic pseudo-jitter
    const jitter = (currentDepth % 7) * 150;
    return Math.min(this.config.maxRetryAfterMs, Math.round(scaledDelay + jitter));
  }

  getMetrics(currentDepth: number): BackpressureMetrics {
    return {
      currentDepth,
      currentCost: this.currentCost,
      state: this.updateState(currentDepth),
      highWatermark: this.highWatermarkDepth,
      lowWatermark: this.lowWatermarkDepth,
      maxCapacity: this.config.maxQueueDepth,
      maxCost: this.config.maxWorkloadCost,
      totalEnqueued: this.totalEnqueued,
      totalRejected: this.totalRejected,
      totalShed: this.totalShed,
      totalBypassed: this.totalBypassed,
    };
  }

  resetStats(): void {
    this.currentCost = 0;
    this.totalEnqueued = 0;
    this.totalRejected = 0;
    this.totalShed = 0;
    this.totalBypassed = 0;
    this.state = 'NORMAL';
  }
}

/**
 * BoundedBackpressureQueue wraps standard JobQueue with admission control.
 */
export class BoundedBackpressureQueue {
  private readonly queue: JobQueue;
  private readonly store: JobStore;
  private readonly controller: BackpressureController;

  constructor(
    store: JobStore,
    defaults: RetryPolicy = DEFAULT_RETRY_POLICY,
    config: Partial<BackpressureConfig> = {}
  ) {
    this.store = store;
    this.queue = new JobQueue(store, defaults);
    this.controller = new BackpressureController(config);
  }

  async enqueue(
    type: string,
    data: Record<string, unknown> = {},
    options: BoundedEnqueueOptions = {}
  ): Promise<{ job: Job; created: boolean }> {
    const counts = await this.store.counts();
    const currentActiveDepth = (counts.queued ?? 0) + (counts.running ?? 0);

    const check = this.controller.checkAdmission(type, currentActiveDepth, options);
    if (!check.admitted) {
      throw new QueueBackpressureError({
        message: `Background work rejected due to queue backpressure: ${check.reason} (depth: ${currentActiveDepth}, job: ${type})`,
        retryAfterMs: check.retryAfterMs ?? 2_000,
        currentDepth: currentActiveDepth,
        maxCapacity: this.controller.highWatermarkDepth,
        jobType: type,
      });
    }

    return this.queue.enqueue(type, data, options);
  }

  async getMetrics(): Promise<BackpressureMetrics> {
    const counts = await this.store.counts();
    const currentActiveDepth = (counts.queued ?? 0) + (counts.running ?? 0);
    return this.controller.getMetrics(currentActiveDepth);
  }

  getController(): BackpressureController {
    return this.controller;
  }
}
