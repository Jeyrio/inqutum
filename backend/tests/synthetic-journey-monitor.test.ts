import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SyntheticJourneyMonitor,
  formatSyntheticJourneyReport,
} from '../src/ops/synthetic-journey-monitor';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';

describe('Synthetic journey monitor for critical end-to-end workflow (Issue #264)', () => {
  it('runs complete happy path journey and records per-step and total latency', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney();

    assert.equal(report.success, true);
    assert.ok(report.totalLatencyMs >= 0);
    assert.equal(report.steps.length, 5);

    // Verify all 5 steps passed in sequence
    const expectedSteps = [
      'CREATE_INVOICE',
      'INSPECT_PAYMENT_DETAILS',
      'VERIFY_STELLAR_PAYMENT',
      'CONFIRM_SETTLEMENT',
      'DISPATCH_EVENT_AND_RECEIPT',
    ];

    for (let i = 0; i < expectedSteps.length; i++) {
      assert.equal(report.steps[i].step, expectedSteps[i]);
      assert.equal(report.steps[i].status, 'PASS');
      assert.ok(report.steps[i].latencyMs >= 0);
    }

    const formatted = formatSyntheticJourneyReport(report);
    assert.match(formatted, /SUCCESS/);
    assert.match(formatted, /Total Latency:/);
  });

  it('accurately blames STORAGE_LAYER when invoice creation fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'CREATE_INVOICE',
      injectedFailureMessage: 'Database connection timeout',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CREATE_INVOICE');
    assert.equal(report.blamedDependency, 'STORAGE_LAYER');
    assert.match(report.rootCause || '', /Database connection timeout/);
    assert.match(report.remediation || '', /connection pool/);
  });

  it('accurately blames API_LAYER when payment envelope retrieval fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'INSPECT_PAYMENT_DETAILS',
      injectedFailureMessage: 'Read replica stale lag',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'INSPECT_PAYMENT_DETAILS');
    assert.equal(report.blamedDependency, 'API_LAYER');
    assert.match(report.remediation || '', /HTTP API routes/);
  });

  it('accurately blames STELLAR_HORIZON when on-chain payment matching fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'VERIFY_STELLAR_PAYMENT',
      injectedFailureMessage: 'Horizon 504 Gateway Timeout',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'VERIFY_STELLAR_PAYMENT');
    assert.equal(report.blamedDependency, 'STELLAR_HORIZON');
    assert.match(report.remediation || '', /Horizon RPC connectivity/);
  });

  it('accurately blames SETTLEMENT_ENGINE when state transition to PAID fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'CONFIRM_SETTLEMENT',
      injectedFailureMessage: 'Optimistic lock conflict during settlement',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CONFIRM_SETTLEMENT');
    assert.equal(report.blamedDependency, 'SETTLEMENT_ENGINE');
    assert.match(report.remediation || '', /optimistic lock versioning/);
  });

  it('accurately blames EXPORT_ENGINE when receipt proof generation fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'DISPATCH_EVENT_AND_RECEIPT',
      injectedFailureMessage: 'Export schema serialization failure',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'DISPATCH_EVENT_AND_RECEIPT');
    assert.equal(report.blamedDependency, 'EXPORT_ENGINE');
    assert.match(report.remediation || '', /export pipeline schemas/);
  });
});
