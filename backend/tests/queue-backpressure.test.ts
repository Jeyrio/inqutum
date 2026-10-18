import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BackpressureController,
  BoundedBackpressureQueue,
  QueueBackpressureError,
} from '../src/jobs/backpressure';
import { MemoryJobStore } from '../src/jobs/memory-job-store';

describe('Bounded Queue Backpressure (Issue #275)', () => {
  let controller: BackpressureController;

  beforeEach(() => {
    controller = new BackpressureController({
      maxQueueDepth: 100,
      highWatermarkRatio: 0.8, // 80
      lowWatermarkRatio: 0.5,  // 50
      maxWorkloadCost: 300,
      baseRetryAfterMs: 1_000,
      maxRetryAfterMs: 30_000,
    });
  });

  describe('Normal Path', () => {
    it('admits standard and expensive background jobs when within capacity bounds', () => {
      const result1 = controller.checkAdmission('invoices.expire-pending', 10);
      assert.equal(result1.admitted, true);

      const result2 = controller.checkAdmission('invoices.bulk-import', 50);
      assert.equal(result2.admitted, true);

      const metrics = controller.getMetrics(50);
      assert.equal(metrics.state, 'NORMAL');
      assert.equal(metrics.highWatermark, 80);
      assert.equal(metrics.lowWatermark, 50);
      assert.equal(metrics.totalRejected, 0);
    });

    it('releases completed job costs accurately', () => {
      controller.checkAdmission('invoices.bulk-import', 10); // cost 15
      controller.checkAdmission('reconciliation.ledger-sweep', 10); // cost 20
      let metrics = controller.getMetrics(10);
      assert.equal(metrics.currentCost, 35);

      controller.releaseJob('invoices.bulk-import');
      metrics = controller.getMetrics(10);
      assert.equal(metrics.currentCost, 20);

      controller.releaseJob('reconciliation.ledger-sweep');
      metrics = controller.getMetrics(10);
      assert.equal(metrics.currentCost, 0);
    });
  });

  describe('Failure Path (Shedding & Saturated Queue)', () => {
    it('sheds normal/low priority work when above high watermark (degraded state)', () => {
      // 85 items is between highWatermark (80) and maxQueueDepth (100)
      const res = controller.checkAdmission('invoices.expire-pending', 85, { priority: 'NORMAL' });
      assert.equal(res.admitted, false);
      assert.equal(res.reason, 'HIGH_WATERMARK_LOAD_SHEDDING');
      assert.ok(res.retryAfterMs! >= 1000);

      const metrics = controller.getMetrics(85);
      assert.equal(metrics.state, 'DEGRADED');
      assert.equal(metrics.totalShed, 1);
      assert.equal(metrics.totalRejected, 1);
    });

    it('rejects all unprivileged jobs when hard capacity is exceeded', () => {
      const res = controller.checkAdmission('invoices.expire-pending', 105);
      assert.equal(res.admitted, false);
      assert.equal(res.reason, 'QUEUE_CAPACITY_EXCEEDED');

      const metrics = controller.getMetrics(105);
      assert.equal(metrics.state, 'REJECTING');
      assert.equal(metrics.totalRejected, 1);
    });

    it('rejects work when workload cost budget is exhausted', () => {
      // Saturate cost budget (300)
      for (let i = 0; i < 20; i++) {
        controller.checkAdmission('invoices.bulk-import', 10); // 20 * 15 = 300
      }
      const res = controller.checkAdmission('invoices.bulk-import', 10);
      assert.equal(res.admitted, false);
      assert.equal(res.reason, 'WORKLOAD_BUDGET_EXCEEDED');
    });
  });

  describe('Retry Path & Hysteresis Recovery', () => {
    it('provides scaled retry-after delay with jitter based on queue depth', () => {
      const delayLow = controller.computeRetryAfter(10);
      const delayHigh = controller.computeRetryAfter(95);

      assert.ok(delayLow >= 1_000);
      assert.ok(delayHigh > delayLow);
      assert.ok(delayHigh <= 30_000);
    });

    it('maintains hysteresis: recovers to NORMAL only when draining below low watermark', () => {
      // Trigger degraded
      assert.equal(controller.updateState(85), 'DEGRADED');

      // Between low (50) and high (80), stays degraded to prevent flapping
      assert.equal(controller.updateState(70), 'DEGRADED');
      assert.equal(controller.updateState(60), 'DEGRADED');

      // Once drained at or below 50, transitions back to NORMAL
      assert.equal(controller.updateState(50), 'NORMAL');
      assert.equal(controller.updateState(30), 'NORMAL');
    });
  });

  describe('Authorization & Priority Bypass Path', () => {
    it('allows CRITICAL priority jobs through even in degraded state', () => {
      const res = controller.checkAdmission('crypto.evidence-verification', 85, {
        priority: 'CRITICAL',
      });
      assert.equal(res.admitted, true);
      assert.equal(res.isBypass, true);
    });

    it('allows MAINTAINER role to bypass standard backpressure up to emergency headroom', () => {
      const res = controller.checkAdmission('reports.csv-export', 102, {
        actorRole: 'MAINTAINER',
      });
      assert.equal(res.admitted, true);
      assert.equal(res.isBypass, true);
    });

    it('rejects even maintainers when emergency headroom (120%) is exhausted', () => {
      // 100 * 1.2 = 120
      const res = controller.checkAdmission('reports.csv-export', 125, {
        actorRole: 'MAINTAINER',
      });
      assert.equal(res.admitted, false);
      assert.equal(res.reason, 'EMERGENCY_BUFFER_EXHAUSTED');
    });
  });

  describe('BoundedBackpressureQueue Integration', () => {
    it('enqueues successfully and throws QueueBackpressureError when saturated', async () => {
      const store = new MemoryJobStore();
      const boundedQueue = new BoundedBackpressureQueue(store, undefined, {
        maxQueueDepth: 2,
        highWatermarkRatio: 0.8,
        lowWatermarkRatio: 0.5,
      });

      // 1st job
      const j1 = await boundedQueue.enqueue('invoices.expire-pending', { foo: 'bar' });
      assert.equal(j1.created, true);

      // 2nd job
      const j2 = await boundedQueue.enqueue('invoices.expire-pending', { foo: 'baz' });
      assert.equal(j2.created, true);

      // 3rd job: active count is 2 (at maxQueueDepth) -> should reject with QueueBackpressureError
      await assert.rejects(
        async () => {
          await boundedQueue.enqueue('invoices.expire-pending', { foo: 'qux' });
        },
        (err: unknown) => {
          assert.ok(err instanceof QueueBackpressureError);
          assert.equal(err.httpStatus, 429);
          assert.ok(err.retryAfterMs > 0);
          assert.equal(err.jobType, 'invoices.expire-pending');
          return true;
        }
      );
    });
  });
});
