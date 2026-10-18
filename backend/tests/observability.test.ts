import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  metrics,
  sanitizeForLogging,
  sanitizeLabelValue,
  measureOperation,
  OperationLatencyStats,
} from '../src/observability/telemetry';

describe('Observability & Telemetry System (Issue #50)', () => {
  beforeEach(() => {
    metrics.clear();
  });

  describe('Sensitive Value Sanitization and Redaction', () => {
    it('redacts Stellar secret keys (S...) while preserving public keys (G...) and tx hashes', () => {
      const secretKey = 'SB3T7Y2Y64D6V7M6F6K5VNJZ6Z7UHQ67ZYZJ4R3N6Q7Y64D6V7M6F6K5';
      const publicKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const txHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

      const payload = {
        secret: secretKey,
        sellerPublicKey: publicKey,
        txHash: txHash,
        token: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
        password: 'super-secret-password-123',
        amount: 150.5,
        memo: 'INV-12345',
      };

      const sanitized = sanitizeForLogging(payload);

      assert.equal(sanitized.secret, '[REDACTED]');
      assert.equal(sanitized.token, '[REDACTED]');
      assert.equal(sanitized.password, '[REDACTED]');
      assert.equal(sanitized.sellerPublicKey, publicKey);
      assert.equal(sanitized.txHash, txHash);
      assert.equal(sanitized.amount, 150.5);
      assert.equal(sanitized.memo, 'INV-12345');
    });

    it('sanitizes strings containing secret keys and authorization tokens inside text', () => {
      const logString =
        'Connecting with secret SB3T7Y2Y64D6V7M6F6K5VNJZ6Z7UHQ67ZYZJ4R3N6Q7Y64D6V7M6F6K5 and auth Bearer abc123def456';
      const sanitized = sanitizeForLogging(logString);

      assert.ok(!sanitized.includes('SB3T7Y2Y64D6V7M6F6K5VNJZ6Z7UHQ67ZYZJ4R3N6Q7Y64D6V7M6F6K5'));
      assert.ok(sanitized.includes('S[REDACTED_SECRET_KEY]'));
      assert.ok(sanitized.includes('Bearer [REDACTED_TOKEN]'));
    });
  });

  describe('Latency Histograms and Failure Rate Tracking', () => {
    it('calculates min, max, avg, failure rate, and percentiles accurately', () => {
      const stats = new OperationLatencyStats();

      // Record 100 sample latencies (10ms, 20ms, ..., 1000ms) with 10 failures
      for (let i = 1; i <= 100; i++) {
        const latency = i * 10;
        const isFailure = i % 10 === 0;
        stats.record(latency, isFailure);
      }

      const json = stats.toJSON();
      assert.equal(json.count, 100);
      assert.equal(json.failures, 10);
      assert.equal(json.failure_rate, 0.1);
      assert.equal(json.min_ms, 10);
      assert.equal(json.max_ms, 1000);
      assert.equal(json.avg_ms, 505);
      assert.ok(json.p50_ms >= 400 && json.p50_ms <= 600);
      assert.ok(json.p95_ms >= 900 && json.p95_ms <= 1000);
    });

    it('measures async operations with measureOperation and records telemetry', async () => {
      const result = await measureOperation(
        'invoice.verify_payment',
        'payer',
        'corr-test-1',
        async () => {
          return { verified: true };
        },
        { invoiceId: 'inv-123' }
      );

      assert.deepEqual(result, { verified: true });

      const summary = metrics.getMetricsSummary();
      assert.ok(summary.operations['invoice.verify_payment']);
      assert.equal(summary.operations['invoice.verify_payment'].count, 1);
      assert.equal(summary.operations['invoice.verify_payment'].failures, 0);
    });

    it('records failed operations with error codes', async () => {
      await assert.rejects(async () => {
        await measureOperation(
          'invoice.verify_payment',
          'payer',
          'corr-test-2',
          async () => {
            const err: any = new Error('Memo mismatch');
            err.code = 'MEMO_MISMATCH';
            throw err;
          }
        );
      });

      const summary = metrics.getMetricsSummary();
      assert.equal(summary.operations['invoice.verify_payment'].failures, 1);
      assert.equal(summary.error_breakdown['invoice.verify_payment:MEMO_MISMATCH'], 1);
    });
  });

  describe('Core Operations Telemetry Coverage', () => {
    it('tracks telemetry for at least five core domain operations', () => {
      const coreOps = [
        'invoice.create',
        'invoice.get',
        'invoice.get_payment_info',
        'invoice.verify_payment',
        'invoice.cancel',
        'invoice.get_stats',
      ];

      for (const op of coreOps) {
        metrics.recordOperation({
          operation: op,
          actor_type: 'seller',
          result: 'success',
          latency_ms: 15.5,
          correlation_id: `corr-${op}`,
        });
      }

      const summary = metrics.getMetricsSummary();
      for (const op of coreOps) {
        assert.ok(summary.operations[op], `Telemetry must exist for ${op}`);
        assert.equal(summary.operations[op].count, 1);
      }
    });
  });

  describe('Business-Critical Conversion Funnel', () => {
    it('tracks funnel stages and calculates conversion percentages', () => {
      // 10 invoices created
      for (let i = 0; i < 10; i++) metrics.recordFunnelStage('invoice_created');
      // 8 payment pages viewed
      for (let i = 0; i < 8; i++) metrics.recordFunnelStage('payment_page_viewed');
      // 6 payments initiated
      for (let i = 0; i < 6; i++) metrics.recordFunnelStage('payment_initiated');
      // 5 payments verified
      for (let i = 0; i < 5; i++) metrics.recordFunnelStage('payment_verified');

      const summary = metrics.getMetricsSummary();
      const funnel = summary.conversion_funnel;

      assert.equal(funnel.stages.invoice_created, 10);
      assert.equal(funnel.stages.payment_page_viewed, 8);
      assert.equal(funnel.stages.payment_verified, 5);

      assert.equal(funnel.conversion_percentages.created_to_viewed_rate, 80.0);
      assert.equal(funnel.conversion_percentages.viewed_to_verified_rate, 62.5);
      assert.equal(funnel.conversion_percentages.overall_conversion_rate, 50.0);
    });
  });

  describe('Prometheus Metrics Format', () => {
    it('exports Prometheus-compliant text format metrics', () => {
      metrics.recordOperation({
        operation: 'invoice.create',
        actor_type: 'seller',
        result: 'success',
        latency_ms: 22.4,
        correlation_id: 'corr-prom',
      });
      metrics.recordFunnelStage('invoice_created');

      const text = metrics.exportPrometheusMetrics();

      assert.ok(text.includes('# TYPE quittance_operations_total counter'));
      assert.ok(text.includes('quittance_operations_total{operation="invoice.create",status="success"} 1'));
      assert.ok(text.includes('quittance_operation_duration_ms_bucket{operation="invoice.create"'));
      assert.ok(text.includes('quittance_conversion_funnel_total{stage="invoice_created"} 1'));
    });
  });

  describe('High-Cardinality Telemetry Protection (Issue #239)', () => {
    it('collapses dynamic path segments to bounded placeholders', () => {
      assert.equal(sanitizeLabelValue('/invoices/550e8400-e29b-41d4-a716-446655440000'), '/invoices/:id');
      assert.equal(sanitizeLabelValue('/invoices/1234'), '/invoices/:id');
      assert.equal(
        sanitizeLabelValue('/webhooks/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'),
        '/webhooks/:id'
      );
      // Short, non-dynamic segments are left intact.
      assert.equal(sanitizeLabelValue('/health'), '/health');
    });

    it('caps overly long label values that survive segment collapsing', () => {
      // Short, distinct words joined by slashes/dashes: none individually
      // match the ID-collapsing patterns, but the whole value is still long.
      const long = '/' + Array.from({ length: 40 }, (_, i) => `seg-${i}`).join('/');
      const result = sanitizeLabelValue(long, 80);
      assert.ok(result.length <= 83); // 80 + '...'
      assert.ok(result.endsWith('...'));
    });

    it('bounds httpRequests cardinality under an abusive volume of unmatched routes', () => {
      for (let i = 0; i < 2000; i++) {
        metrics.recordHttpRequest('GET', `/unmatched/${i}-${'x'.repeat(20)}`, 404);
      }
      const summary = metrics.getMetricsSummary();
      const distinctKeys = Object.keys(summary.http_requests).length;
      // MAX_METRIC_CARDINALITY (500) + 1 overflow bucket key, never unbounded.
      assert.ok(distinctKeys <= 501, `expected bounded cardinality, got ${distinctKeys} keys`);
      assert.ok(
        Object.keys(summary.http_requests).some((k) => k.includes('__cardinality_overflow__')),
        'expected an overflow bucket once the cap is exceeded'
      );
    });

    it('bounds errorCounts cardinality under an abusive volume of distinct error codes', () => {
      for (let i = 0; i < 2000; i++) {
        metrics.recordOperation({
          operation: 'invoice.create',
          actor_type: 'anonymous',
          result: 'failure',
          latency_ms: 1,
          correlation_id: `corr-${i}`,
          error_code: `ERR_${i}_${'y'.repeat(20)}`,
        });
      }
      const summary = metrics.getMetricsSummary();
      const distinctKeys = Object.keys(summary.error_breakdown).length;
      assert.ok(distinctKeys <= 501, `expected bounded cardinality, got ${distinctKeys} keys`);
    });
  });
});
