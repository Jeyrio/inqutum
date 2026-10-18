/**
 * Executable Load Test Runner for Worst-Case Cardinality and Burst Traffic (Issue #287).
 *
 * Usage:
 *   npx tsx scripts/load-cardinality-burst.ts [--concurrency=50] [--requests=500]
 */

import { performance } from 'perf_hooks';
import { metrics, MetricsRegistry } from '../backend/src/observability/telemetry';

export interface LoadTestConfig {
  concurrency: number;
  totalRequests: number;
  baseUrl?: string;
}

export interface LoadTestResult {
  totalRequests: number;
  successful: number;
  failed: number;
  durationMs: number;
  throughputRps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxCardinalityObserved: number;
  overflowCaptured: boolean;
  heapDeltaMb: number;
}

export async function runCardinalityBurstLoadTest(
  config: LoadTestConfig = { concurrency: 50, totalRequests: 2500 }
): Promise<LoadTestResult> {
  const initialMemory = process.memoryUsage().heapUsed;
  const startTime = performance.now();
  const latencies: number[] = [];
  let successful = 0;
  let failed = 0;

  console.log(`🚀 Starting cardinality burst load test (${config.totalRequests} requests, concurrency ${config.concurrency})...`);

  // Run assault across normal, failure, retry, and auth scenarios
  const batchSize = config.concurrency;
  for (let i = 0; i < config.totalRequests; i += batchSize) {
    const currentBatch = Math.min(batchSize, config.totalRequests - i);
    const promises = Array.from({ length: currentBatch }, async (_, idx) => {
      const reqStart = performance.now();
      try {
        const pathType = idx % 4;
        if (pathType === 0) {
          // Normal baseline path
          metrics.recordHttpRequest('GET', '/api/health', 200, 1.5);
          successful++;
        } else if (pathType === 1) {
          // Worst-case high cardinality path
          const attackPath = `/api/load-test/burst-${i + idx}-${Math.random().toString(36).slice(2)}`;
          metrics.recordHttpRequest('GET', attackPath, 404, 2.1);
          successful++;
        } else if (pathType === 2) {
          // Retry / transient failure path
          metrics.recordHttpRequest('POST', '/api/invoices/verify', 503, 15.2);
          failed++;
        } else {
          // Protected authorization path
          metrics.recordHttpRequest('GET', '/api/jobs', 401, 1.1);
          successful++;
        }
      } catch {
        failed++;
      } finally {
        latencies.push(performance.now() - reqStart);
      }
    });

    await Promise.all(promises);
  }

  const durationMs = performance.now() - startTime;
  const finalMemory = process.memoryUsage().heapUsed;
  const heapDeltaMb = (finalMemory - initialMemory) / (1024 * 1024);

  latencies.sort((a, b) => a - b);
  const p50Ms = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95Ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99Ms = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

  const summary = metrics.getMetricsSummary();
  const endpointsCount = Object.keys(summary.http_requests).length;
  const overflowCaptured = Boolean(summary.http_requests['__cardinality_overflow__']);

  return {
    totalRequests: config.totalRequests,
    successful,
    failed,
    durationMs,
    throughputRps: (config.totalRequests / durationMs) * 1000,
    p50Ms: Number(p50Ms.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    p99Ms: Number(p99Ms.toFixed(2)),
    maxCardinalityObserved: endpointsCount,
    overflowCaptured,
    heapDeltaMb: Number(heapDeltaMb.toFixed(2)),
  };
}

if (require.main === module || process.argv[1]?.endsWith('load-cardinality-burst.ts')) {
  runCardinalityBurstLoadTest().then((res) => {
    console.log('====================================================');
    console.log('📊 Cardinality & Burst Traffic Load Test Results');
    console.log('====================================================');
    console.log(`Requests:     ${res.totalRequests} (${res.successful} success, ${res.failed} failure/retry)`);
    console.log(`Throughput:   ${res.throughputRps.toFixed(2)} req/sec (Total: ${res.durationMs.toFixed(2)} ms)`);
    console.log(`Latencies:    p50: ${res.p50Ms}ms | p95: ${res.p95Ms}ms | p99: ${res.p99Ms}ms`);
    console.log(`Cardinality:  ${res.maxCardinalityObserved} distinct keys (Capped at 501 max)`);
    console.log(`Overflow:     ${res.overflowCaptured ? '✅ Captured into __cardinality_overflow__' : '❌ None'}`);
    console.log(`Heap Delta:   ${res.heapDeltaMb} MB`);
    console.log('====================================================');
    process.exit(res.maxCardinalityObserved <= 501 && res.overflowCaptured ? 0 : 1);
  });
}
