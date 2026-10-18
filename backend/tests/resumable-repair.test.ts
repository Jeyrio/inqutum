/**
 * Resumable Repair Job for Orphaned and Inconsistent Records — Test Suite.
 *
 * Covers:
 *  - Normal path: repair of all failure families (detached transactions, orphaned transactions,
 *    orphaned payment events, inconsistent invoices, inconsistent jobs).
 *  - Keyset pagination and resumability: chunked batch execution, pause at batch limits,
 *    and resumption from saved checkpoint cursor without re-processing.
 *  - Failure path: query and update errors recorded in checkpoint, failed count tracked,
 *    and checkpoint recovery.
 *  - Dry-run mode: full scan and action log preview with zero database mutations.
 *  - Worker background job execution: registration and retry compatibility.
 *  - Authorization path: admin token enforcement on /ops/repair-records/* endpoints.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  ResumableRepairService,
  MemoryRepairCheckpointStore,
  PostgresRepairCheckpointStore,
  RepairJobNotFoundError,
  type RepairDatabase,
  type RepairPhase,
} from '../src/ops/resumable-repair.service';
import { createOpsRouter } from '../src/routes/ops.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { JobQueue, JobWorker } from '../src/jobs/worker';
import { registerJobHandlers, RESUMABLE_REPAIR_JOB } from '../src/jobs/runtime';

interface MockDbState {
  invoices: Array<{
    id: string;
    memo: string;
    status: string;
    paid_at: string | null;
    payment_tx_hash: string | null;
    version: number;
    created_at: string;
  }>;
  transactions: Array<{
    id: string;
    invoice_id: string | null;
    tx_hash: string;
    memo: string | null;
    amount: number;
    metadata: Record<string, unknown> | null;
    processed_at: string;
  }>;
  payment_events: Array<{
    id: string;
    invoice_id: string | null;
    event_type: string;
    event_data: Record<string, unknown> | null;
    created_at: string;
  }>;
  jobs: Array<{
    id: string;
    type: string;
    status: string;
    locked_until: string | null;
    locked_by: string | null;
    completed_at: string | null;
    updated_at: string;
    created_at: string;
  }>;
  checkpoints: Map<string, any>;
}

class MockRepairDatabase implements RepairDatabase {
  public state: MockDbState;
  public throwOnPhaseScan: RepairPhase | null = null;
  public throwOnUpdateId: string | null = null;
  public updateCalls: string[] = [];

  constructor(initialState?: Partial<MockDbState>) {
    this.state = {
      invoices: initialState?.invoices ? [...initialState.invoices] : [],
      transactions: initialState?.transactions ? [...initialState.transactions] : [],
      payment_events: initialState?.payment_events ? [...initialState.payment_events] : [],
      jobs: initialState?.jobs ? [...initialState.jobs] : [],
      checkpoints: initialState?.checkpoints ?? new Map(),
    };
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    // ── Checkpoint table queries ───────────────────────────────────────────
    if (text.includes('CREATE TABLE IF NOT EXISTS record_repair_checkpoints')) {
      return { rows: [] };
    }
    if (text.includes('INSERT INTO record_repair_checkpoints')) {
      const id = String(params[0]);
      this.state.checkpoints.set(id, {
        id,
        status: params[1],
        phase: params[2],
        cursor: params[3],
        dry_run: params[4],
        batch_size: params[5],
        phases: params[6],
        scanned_count: params[7],
        repaired_count: params[8],
        skipped_count: params[9],
        failed_count: params[10],
        errors: params[11],
        action_log: params[12],
        started_at: params[13],
        updated_at: params[14],
        completed_at: params[15],
      });
      return { rows: [] };
    }
    if (text.includes('SELECT') && text.includes('FROM record_repair_checkpoints')) {
      if (text.includes('WHERE id = $1')) {
        const cp = this.state.checkpoints.get(String(params[0]));
        return { rows: cp ? [cp] : [] };
      }
      return { rows: Array.from(this.state.checkpoints.values()) };
    }

    // ── Phase 1: detached_transactions ─────────────────────────────────────
    if (text.includes('FROM transactions t') && text.includes('JOIN invoices i ON i.memo = t.memo')) {
      if (this.throwOnPhaseScan === 'detached_transactions') {
        throw new Error('Simulated failure during detached_transactions scan');
      }
      const cursor = (params[0] as string) || null;
      const limit = Number(params[1]) || 100;

      let matches = this.state.transactions
        .filter((t) => t.invoice_id === null && t.memo !== null)
        .map((t) => {
          const inv = this.state.invoices.find((i) => i.memo === t.memo);
          return inv ? { id: t.id, tx_hash: t.tx_hash, memo: t.memo, matching_invoice_id: inv.id } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (cursor) {
        matches = matches.filter((r) => r.id > cursor);
      }
      matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { rows: matches.slice(0, limit) };
    }

    if (text.includes('UPDATE transactions SET invoice_id = $1 WHERE id = $2 AND invoice_id IS NULL')) {
      const [invoiceId, id] = params as [string, string];
      if (this.throwOnUpdateId === id) {
        throw new Error(`Simulated update error on transaction ${id}`);
      }
      this.updateCalls.push(`relink_tx_${id}`);
      const tx = this.state.transactions.find((t) => t.id === id);
      if (tx && tx.invoice_id === null) {
        tx.invoice_id = invoiceId;
      }
      return { rows: [] };
    }

    // ── Phase 2: orphaned_transactions ─────────────────────────────────────
    if (text.includes('FROM transactions t') && text.includes('LEFT JOIN invoices i ON i.id = t.invoice_id')) {
      if (this.throwOnPhaseScan === 'orphaned_transactions') {
        throw new Error('Simulated failure during orphaned_transactions scan');
      }
      const cursor = (params[0] as string) || null;
      const limit = Number(params[1]) || 100;

      let orphans = this.state.transactions.filter(
        (t) => t.invoice_id !== null && !this.state.invoices.some((i) => i.id === t.invoice_id)
      );

      if (cursor) {
        orphans = orphans.filter((t) => t.id > cursor);
      }
      orphans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        rows: orphans.slice(0, limit).map((t) => ({
          id: t.id,
          invoice_id: t.invoice_id,
          tx_hash: t.tx_hash,
        })),
      };
    }

    if (text.includes('UPDATE transactions') && text.includes('orphaned_invoice_id')) {
      const [orphanedInvoiceId, id] = params as [string, string];
      if (this.throwOnUpdateId === id) {
        throw new Error(`Simulated update error on orphaned transaction ${id}`);
      }
      this.updateCalls.push(`isolate_orphaned_tx_${id}`);
      const tx = this.state.transactions.find((t) => t.id === id);
      if (tx) {
        tx.invoice_id = null;
        tx.metadata = { ...(tx.metadata ?? {}), orphaned_invoice_id: orphanedInvoiceId };
      }
      return { rows: [] };
    }

    // ── Phase 3: orphaned_payment_events ───────────────────────────────────
    if (text.includes('FROM payment_events e') && text.includes('LEFT JOIN invoices i ON i.id = e.invoice_id')) {
      if (this.throwOnPhaseScan === 'orphaned_payment_events') {
        throw new Error('Simulated failure during orphaned_payment_events scan');
      }
      const cursor = (params[0] as string) || null;
      const limit = Number(params[1]) || 100;

      let orphans = this.state.payment_events.filter(
        (e) => e.invoice_id !== null && !this.state.invoices.some((i) => i.id === e.invoice_id)
      );

      if (cursor) {
        orphans = orphans.filter((e) => e.id > cursor);
      }
      orphans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        rows: orphans.slice(0, limit).map((e) => ({
          id: e.id,
          invoice_id: e.invoice_id,
          event_type: e.event_type,
        })),
      };
    }

    if (text.includes('UPDATE payment_events') && text.includes('orphaned_invoice_id')) {
      const [orphanedInvoiceId, id] = params as [string, string];
      if (this.throwOnUpdateId === id) {
        throw new Error(`Simulated update error on orphaned payment event ${id}`);
      }
      this.updateCalls.push(`isolate_orphaned_event_${id}`);
      const evt = this.state.payment_events.find((e) => e.id === id);
      if (evt) {
        evt.invoice_id = null;
        evt.event_data = { ...(evt.event_data ?? {}), orphaned_invoice_id: orphanedInvoiceId };
      }
      return { rows: [] };
    }

    // ── Phase 4: inconsistent_invoices ─────────────────────────────────────
    if (text.includes('FROM invoices i') && text.includes('LEFT JOIN LATERAL')) {
      if (this.throwOnPhaseScan === 'inconsistent_invoices') {
        throw new Error('Simulated failure during inconsistent_invoices scan');
      }
      const cursor = (params[0] as string) || null;
      const limit = Number(params[1]) || 100;

      let inconsistent = this.state.invoices
        .map((i) => {
          const linkedTx = this.state.transactions.find(
            (t) => t.invoice_id === i.id || (i.payment_tx_hash && t.tx_hash === i.payment_tx_hash)
          );
          const needsPaidAt = i.status === 'PAID' && !i.paid_at;
          const hasInvalidPaidAt = i.status !== 'PAID' && i.paid_at !== null;
          const needsPaymentTxHash = i.status === 'PAID' && !i.payment_tx_hash && linkedTx?.tx_hash;
          const invalidVersion = i.version === null || i.version === undefined || i.version < 1;

          if (needsPaidAt || hasInvalidPaidAt || needsPaymentTxHash || invalidVersion) {
            return {
              id: i.id,
              status: i.status,
              paid_at: i.paid_at,
              payment_tx_hash: i.payment_tx_hash,
              version: i.version,
              created_at: i.created_at,
              tx_processed_at: linkedTx?.processed_at ?? null,
              tx_hash: linkedTx?.tx_hash ?? null,
            };
          }
          return null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (cursor) {
        inconsistent = inconsistent.filter((i) => i.id > cursor);
      }
      inconsistent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { rows: inconsistent.slice(0, limit) };
    }

    if (text.includes('UPDATE invoices SET paid_at = $1 WHERE id = $2 AND paid_at IS NULL')) {
      const [paidAt, id] = params as [string, string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on invoice ${id}`);
      this.updateCalls.push(`backfill_paid_at_${id}`);
      const inv = this.state.invoices.find((i) => i.id === id);
      if (inv) inv.paid_at = paidAt;
      return { rows: [] };
    }

    if (text.includes('UPDATE invoices SET paid_at = NULL WHERE id = $1 AND status <> \'PAID\'')) {
      const [id] = params as [string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on invoice ${id}`);
      this.updateCalls.push(`clear_paid_at_${id}`);
      const inv = this.state.invoices.find((i) => i.id === id);
      if (inv) inv.paid_at = null;
      return { rows: [] };
    }

    if (text.includes('UPDATE invoices SET payment_tx_hash = $1 WHERE id = $2 AND payment_tx_hash IS NULL')) {
      const [txHash, id] = params as [string, string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on invoice ${id}`);
      this.updateCalls.push(`backfill_tx_hash_${id}`);
      const inv = this.state.invoices.find((i) => i.id === id);
      if (inv) inv.payment_tx_hash = txHash;
      return { rows: [] };
    }

    if (text.includes('UPDATE invoices SET version = 1 WHERE id = $1 AND (version IS NULL OR version < 1)')) {
      const [id] = params as [string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on invoice ${id}`);
      this.updateCalls.push(`reset_version_${id}`);
      const inv = this.state.invoices.find((i) => i.id === id);
      if (inv) inv.version = 1;
      return { rows: [] };
    }

    // ── Phase 5: inconsistent_jobs ─────────────────────────────────────────
    if (text.includes('FROM jobs j') && text.includes('status = \'running\'')) {
      if (this.throwOnPhaseScan === 'inconsistent_jobs') {
        throw new Error('Simulated failure during inconsistent_jobs scan');
      }
      const cursor = (params[0] as string) || null;
      const limit = Number(params[1]) || 100;

      let inconsistent = this.state.jobs.filter((j) => {
        const isStaleLease =
          j.status === 'running' &&
          (!j.locked_until || new Date(j.locked_until).getTime() < Date.now());
        const isMissingCompleted =
          ['succeeded', 'dead'].includes(j.status) && !j.completed_at;
        const isUnexpectedCompleted =
          ['queued', 'running'].includes(j.status) && j.completed_at !== null;
        return isStaleLease || isMissingCompleted || isUnexpectedCompleted;
      });

      if (cursor) {
        inconsistent = inconsistent.filter((j) => j.id > cursor);
      }
      inconsistent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        rows: inconsistent.slice(0, limit).map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          locked_until: j.locked_until,
          completed_at: j.completed_at,
          updated_at: j.updated_at,
          created_at: j.created_at,
        })),
      };
    }

    if (text.includes('UPDATE jobs') && text.includes('status = \'queued\', locked_until = NULL')) {
      const [id] = params as [string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on job ${id}`);
      this.updateCalls.push(`requeue_stale_job_${id}`);
      const job = this.state.jobs.find((j) => j.id === id);
      if (job) {
        job.status = 'queued';
        job.locked_until = null;
        job.locked_by = null;
      }
      return { rows: [] };
    }

    if (text.includes('UPDATE jobs SET completed_at = $1 WHERE id = $2 AND completed_at IS NULL')) {
      const [completedAt, id] = params as [string, string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on job ${id}`);
      this.updateCalls.push(`backfill_job_completed_${id}`);
      const job = this.state.jobs.find((j) => j.id === id);
      if (job) job.completed_at = completedAt;
      return { rows: [] };
    }

    if (text.includes('UPDATE jobs SET completed_at = NULL WHERE id = $1 AND status IN (\'queued\', \'running\')')) {
      const [id] = params as [string];
      if (this.throwOnUpdateId === id) throw new Error(`Simulated update error on job ${id}`);
      this.updateCalls.push(`clear_job_completed_${id}`);
      const job = this.state.jobs.find((j) => j.id === id);
      if (job) job.completed_at = null;
      return { rows: [] };
    }

    return { rows: [] };
  }
}

function createSampleAnomalies(): MockDbState {
  return {
    invoices: [
      {
        id: 'inv-01',
        memo: 'MEMO-01',
        status: 'PAID',
        paid_at: null, // Inconsistent: paid without timestamp
        payment_tx_hash: null, // Inconsistent: paid without tx_hash
        version: 1,
        created_at: '2026-01-01T10:00:00Z',
      },
      {
        id: 'inv-02',
        memo: 'MEMO-02',
        status: 'PENDING',
        paid_at: '2026-01-02T10:00:00Z', // Inconsistent: unpaid with timestamp
        payment_tx_hash: null,
        version: 0, // Inconsistent: invalid version
        created_at: '2026-01-02T10:00:00Z',
      },
      {
        id: 'inv-03',
        memo: 'MEMO-03',
        status: 'PENDING',
        paid_at: null,
        payment_tx_hash: null,
        version: 1,
        created_at: '2026-01-03T10:00:00Z',
      },
    ],
    transactions: [
      {
        id: 'tx-01',
        invoice_id: null,
        tx_hash: 'hash-tx-01',
        memo: 'MEMO-03', // Detached: memo matches inv-03
        amount: 50,
        metadata: null,
        processed_at: '2026-01-03T12:00:00Z',
      },
      {
        id: 'tx-02',
        invoice_id: 'non-existent-inv-99', // Orphaned: foreign ref does not exist
        tx_hash: 'hash-tx-02',
        memo: 'UNKNOWN-MEMO',
        amount: 25,
        metadata: { originalMeta: true },
        processed_at: '2026-01-04T12:00:00Z',
      },
      {
        id: 'tx-03',
        invoice_id: 'inv-01', // Linked to inv-01 to satisfy backfill
        tx_hash: 'hash-tx-03',
        memo: 'MEMO-01',
        amount: 100,
        metadata: null,
        processed_at: '2026-01-01T11:00:00Z',
      },
    ],
    payment_events: [
      {
        id: 'evt-01',
        invoice_id: 'non-existent-inv-88', // Orphaned: foreign ref does not exist
        event_type: 'PAYMENT_RECEIVED',
        event_data: { raw: 'data' },
        created_at: '2026-01-05T12:00:00Z',
      },
    ],
    jobs: [
      {
        id: 'job-01',
        type: 'test-job',
        status: 'running',
        locked_until: '2026-01-01T00:00:00Z', // Inconsistent: expired running lease
        locked_by: 'worker-1',
        completed_at: null,
        updated_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'job-02',
        type: 'test-job',
        status: 'succeeded',
        locked_until: null,
        locked_by: null,
        completed_at: null, // Inconsistent: terminal without completion
        updated_at: '2026-01-02T15:00:00Z',
        created_at: '2026-01-02T14:00:00Z',
      },
      {
        id: 'job-03',
        type: 'test-job',
        status: 'queued',
        locked_until: null,
        locked_by: null,
        completed_at: '2026-01-03T10:00:00Z', // Inconsistent: non-terminal with completion
        updated_at: '2026-01-03T09:00:00Z',
        created_at: '2026-01-03T09:00:00Z',
      },
    ],
    checkpoints: new Map(),
  };
}

describe('Resumable Repair Job for Orphaned and Inconsistent Records', () => {
  let db: MockRepairDatabase;
  let service: ResumableRepairService;

  beforeEach(() => {
    db = new MockRepairDatabase(createSampleAnomalies());
    service = new ResumableRepairService({ db, defaultBatchSize: 10 });
  });

  // ── 1. Normal Path ─────────────────────────────────────────────────────────
  describe('Normal Path: End-to-end Repair Execution', () => {
    it('repairs detached transactions, orphaned references, and inconsistent invoices/jobs', async () => {
      const report = await service.startRepairJob({ dryRun: false, batchSize: 10 });

      assert.equal(report.status, 'completed');
      assert.equal(report.dryRun, false);
      assert.equal(report.errors.length, 0);
      assert.equal(report.counts.failed, 0);

      // Verify detached transaction tx-01 is re-linked to inv-03
      const tx1 = db.state.transactions.find((t) => t.id === 'tx-01');
      assert.equal(tx1?.invoice_id, 'inv-03');

      // Verify orphaned transaction tx-02 has invoice_id nulled and metadata preserved
      const tx2 = db.state.transactions.find((t) => t.id === 'tx-02');
      assert.equal(tx2?.invoice_id, null);
      assert.equal(tx2?.metadata?.orphaned_invoice_id, 'non-existent-inv-99');
      assert.equal(tx2?.metadata?.originalMeta, true);

      // Verify orphaned payment event evt-01 has invoice_id nulled and event_data preserved
      const evt1 = db.state.payment_events.find((e) => e.id === 'evt-01');
      assert.equal(evt1?.invoice_id, null);
      assert.equal(evt1?.event_data?.orphaned_invoice_id, 'non-existent-inv-88');

      // Verify inv-01 had paid_at and payment_tx_hash backfilled from linked tx-03
      const inv1 = db.state.invoices.find((i) => i.id === 'inv-01');
      assert.equal(inv1?.paid_at, '2026-01-01T11:00:00Z');
      assert.equal(inv1?.payment_tx_hash, 'hash-tx-03');

      // Verify inv-02 had paid_at cleared and version reset to 1
      const inv2 = db.state.invoices.find((i) => i.id === 'inv-02');
      assert.equal(inv2?.paid_at, null);
      assert.equal(inv2?.version, 1);

      // Verify job-01 (stale running lease) was requeued
      const job1 = db.state.jobs.find((j) => j.id === 'job-01');
      assert.equal(job1?.status, 'queued');
      assert.equal(job1?.locked_until, null);

      // Verify job-02 (terminal without completed_at) backfilled completed_at
      const job2 = db.state.jobs.find((j) => j.id === 'job-02');
      assert.equal(job2?.completed_at, '2026-01-02T15:00:00Z');

      // Verify job-03 (non-terminal with completed_at) cleared completed_at
      const job3 = db.state.jobs.find((j) => j.id === 'job-03');
      assert.equal(job3?.completed_at, null);

      // Re-running repair on the now clean database finds 0 violations
      const secondRun = await service.startRepairJob();
      assert.equal(secondRun.status, 'completed');
      assert.equal(secondRun.counts.repaired, 0);
      assert.equal(secondRun.counts.scanned, 0);
    });
  });

  // ── 2. Resumability & Keyset Cursor Pagination ─────────────────────────────
  describe('Resumability and Cursor Checkpointing', () => {
    it('pauses at maxBatches limit and resumes from checkpoint without duplicate processing', async () => {
      // Seed 6 detached transactions
      db.state.transactions = [
        { id: 'tx-1', invoice_id: null, tx_hash: 'h1', memo: 'MEMO-01', amount: 10, metadata: null, processed_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-2', invoice_id: null, tx_hash: 'h2', memo: 'MEMO-01', amount: 10, metadata: null, processed_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-3', invoice_id: null, tx_hash: 'h3', memo: 'MEMO-01', amount: 10, metadata: null, processed_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-4', invoice_id: null, tx_hash: 'h4', memo: 'MEMO-01', amount: 10, metadata: null, processed_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-5', invoice_id: null, tx_hash: 'h5', memo: 'MEMO-01', amount: 10, metadata: null, processed_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-6', invoice_id: null, tx_hash: 'h6', memo: 'MEMO-01', amount: 10, metadata: null, processed_at: '2026-01-01T00:00:00Z' },
      ];
      db.state.invoices = [
        { id: 'inv-01', memo: 'MEMO-01', status: 'PAID', paid_at: '2026-01-01T00:00:00Z', payment_tx_hash: 'h1', version: 1, created_at: '2026-01-01T00:00:00Z' },
      ];
      db.state.payment_events = [];
      db.state.jobs = [];

      // Run with batchSize = 2 and maxBatches = 1 (processes exactly tx-1 and tx-2)
      const firstRun = await service.startRepairJob({
        batchSize: 2,
        maxBatches: 1,
        phases: ['detached_transactions'],
      });

      assert.equal(firstRun.status, 'paused');
      assert.equal(firstRun.counts.scanned, 2);
      assert.equal(firstRun.counts.repaired, 2);
      assert.equal(firstRun.cursor, 'tx-2');

      // Verify exactly tx-1 and tx-2 were relinked
      assert.equal(db.state.transactions.find((t) => t.id === 'tx-1')?.invoice_id, 'inv-01');
      assert.equal(db.state.transactions.find((t) => t.id === 'tx-2')?.invoice_id, 'inv-01');
      assert.equal(db.state.transactions.find((t) => t.id === 'tx-3')?.invoice_id, null);

      // Resume second chunk with maxBatches = 1 (processes tx-3 and tx-4)
      const secondRun = await service.resumeRepairJob(firstRun.jobId, { maxBatches: 1 });
      assert.equal(secondRun.status, 'paused');
      assert.equal(secondRun.counts.scanned, 4);
      assert.equal(secondRun.counts.repaired, 4);
      assert.equal(secondRun.cursor, 'tx-4');

      // Resume to completion (processes tx-5 and tx-6, finishes phase)
      const finalRun = await service.resumeRepairJob(firstRun.jobId);
      assert.equal(finalRun.status, 'completed');
      assert.equal(finalRun.counts.scanned, 6);
      assert.equal(finalRun.counts.repaired, 6);

      // Verify all transactions are now linked
      for (const tx of db.state.transactions) {
        assert.equal(tx.invoice_id, 'inv-01');
      }

      // Resuming an already completed job returns the completed report idempotently
      const postComplete = await service.resumeRepairJob(firstRun.jobId);
      assert.equal(postComplete.status, 'completed');
    });

    it('throws RepairJobNotFoundError when resuming unknown jobId', async () => {
      await assert.rejects(
        () => service.resumeRepairJob('nonexistent-job-id'),
        RepairJobNotFoundError
      );
    });
  });

  // ── 3. Failure & Error Recovery Path ───────────────────────────────────────
  describe('Failure and Error Resilience', () => {
    it('records record-level update failures in checkpoint and continues processing other records', async () => {
      db.throwOnUpdateId = 'tx-01'; // Make first record fail during update

      const report = await service.startRepairJob({
        dryRun: false,
        phases: ['detached_transactions', 'inconsistent_jobs'],
      });

      assert.equal(report.status, 'completed');
      assert.equal(report.counts.failed, 1);
      assert.equal(report.counts.repaired >= 3, true);
      assert.equal(report.errors.length, 1);
      assert.equal(report.errors[0]?.recordId, 'tx-01');
      assert.match(report.errors[0]?.error ?? '', /Simulated update error/);
    });

    it('persists checkpoint status as failed and records scan failure if DB throws', async () => {
      db.throwOnPhaseScan = 'orphaned_transactions';

      await assert.rejects(
        () => service.startRepairJob(),
        /Simulated failure during orphaned_transactions scan/
      );

      const jobs = await service.listJobs();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.status, 'failed');
      assert.equal(jobs[0]?.phase, 'orphaned_transactions');
      assert.equal(jobs[0]?.errors.length, 1);
      assert.match(jobs[0]?.errors[0]?.error ?? '', /Simulated failure during orphaned_transactions scan/);
    });
  });

  // ── 4. Dry-Run Path ────────────────────────────────────────────────────────
  describe('Dry-Run Mode', () => {
    it('scans anomalies, produces planned action log, and performs zero mutations', async () => {
      const initialTransactions = JSON.parse(JSON.stringify(db.state.transactions));
      const initialInvoices = JSON.parse(JSON.stringify(db.state.invoices));
      const initialJobs = JSON.parse(JSON.stringify(db.state.jobs));

      const report = await service.startRepairJob({ dryRun: true });

      assert.equal(report.status, 'completed');
      assert.equal(report.dryRun, true);
      assert.equal(report.counts.scanned > 0, true);
      assert.equal(report.counts.repaired > 0, true);
      assert.equal(report.actionLogSample.length > 0, true);
      assert.equal(db.updateCalls.length, 0); // ZERO database updates issued!

      // Database state remains completely identical
      assert.deepEqual(db.state.transactions, initialTransactions);
      assert.deepEqual(db.state.invoices, initialInvoices);
      assert.deepEqual(db.state.jobs, initialJobs);
    });
  });

  // ── 5. Background Job Framework Integration ────────────────────────────────
  describe('Background Job Worker Integration', () => {
    it('executes resumable repair via registered JobWorker and JobQueue', async () => {
      const jobStore = new MemoryJobStore();
      const queue = new JobQueue(jobStore);
      const worker = new JobWorker({ store: jobStore, pollIntervalMs: 10 });

      registerJobHandlers(worker, {
        expirePendingInvoices: async () => 0,
        repairRecords: async (payload) => {
          if (payload.jobId) {
            return service.resumeRepairJob(payload.jobId, payload);
          }
          return service.startRepairJob(payload);
        },
      });

      const enqueued = await queue.enqueue(RESUMABLE_REPAIR_JOB, {
        dryRun: false,
        phases: ['detached_transactions'],
      });

      await worker.runOnce();

      const finished = await jobStore.get(enqueued.job.id);
      assert.equal(finished?.status, 'succeeded');
      const result = finished?.result as any;
      assert.equal(result?.status, 'completed');
      assert.equal(result?.counts?.repaired, 1);
    });
  });

  // ── 6. Authorization and Ops Routes ────────────────────────────────────────
  describe('Authorization and Ops HTTP Routes', () => {
    const ADMIN_TOKEN = 'secret-ops-admin-token-12345';
    let app: express.Express;
    let server: ReturnType<express.Express['listen']>;
    let baseUrl: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      app.use(
        '/api',
        createOpsRouter({
          storage: new MemoryInvoiceStorage(),
          adminToken: ADMIN_TOKEN,
          repairService: service,
          approvals: null,
        })
      );

      server = app.listen(0);
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/repair-records/jobs`;
    });

    const request = (
      method: string,
      path = '',
      body?: unknown,
      token: string | null = ADMIN_TOKEN
    ) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    it('rejects unauthenticated and invalid token requests with 401', async () => {
      try {
        const noToken = await request('POST', '', {}, null);
        assert.equal(noToken.status, 401);

        const badToken = await request('POST', '', {}, 'invalid-token');
        assert.equal(badToken.status, 401);

        const getNoToken = await request('GET', '', undefined, null);
        assert.equal(getNoToken.status, 401);
      } finally {
        server.close();
      }
    });

    it('creates, inspects, and resumes repair jobs via authorized HTTP endpoints', async () => {
      try {
        // 1. Create a repair job with maxBatches = 1
        const startRes = await request('POST', '', { maxBatches: 1, batchSize: 1 });
        assert.equal(startRes.status, 201);
        const startBody = await startRes.json();
        assert.equal(startBody.success, true);
        const jobId = startBody.data.jobId;
        assert.equal(startBody.data.status, 'paused');

        // 2. Inspect job by id
        const getRes = await request('GET', `/${jobId}`);
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        assert.equal(getBody.data.jobId, jobId);
        assert.equal(getBody.data.status, 'paused');

        // 3. Resume job to completion
        const resumeRes = await request('POST', `/${jobId}/resume`, {});
        assert.equal(resumeRes.status, 200);
        const resumeBody = await resumeRes.json();
        assert.equal(resumeBody.data.status, 'completed');

        // 4. List jobs
        const listRes = await request('GET', '');
        assert.equal(listRes.status, 200);
        const listBody = await listRes.json();
        assert.equal(listBody.data.length >= 1, true);

        // 5. Query non-existent job returns 404
        const notFoundRes = await request('GET', '/non-existent-id');
        assert.equal(notFoundRes.status, 404);
        const notFoundBody = await notFoundRes.json();
        assert.equal(notFoundBody.code, 'REPAIR_JOB_NOT_FOUND');
      } finally {
        server.close();
      }
    });
  });

  // ── 7. Postgres Checkpoint Store ───────────────────────────────────────────
  describe('PostgresRepairCheckpointStore', () => {
    it('persists and retrieves checkpoints across job lifecycle', async () => {
      const pgStore = new PostgresRepairCheckpointStore(db);
      await pgStore.initTable();

      const cp = {
        id: 'test-cp-1',
        status: 'running' as const,
        phase: 'orphaned_transactions' as const,
        cursor: 'tx-100',
        dryRun: false,
        batchSize: 50,
        phases: ['orphaned_transactions'] as RepairPhase[],
        scannedCount: 10,
        repairedCount: 10,
        skippedCount: 0,
        failedCount: 0,
        errors: [],
        actionLog: [
          {
            timestamp: new Date().toISOString(),
            phase: 'orphaned_transactions' as const,
            recordId: 'tx-100',
            action: 'isolate_orphaned_transaction',
            details: {},
          },
        ],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      };

      await pgStore.save(cp);
      const loaded = await pgStore.get('test-cp-1');

      assert.equal(loaded?.id, 'test-cp-1');
      assert.equal(loaded?.status, 'running');
      assert.equal(loaded?.cursor, 'tx-100');
      assert.equal(loaded?.actionLog.length, 1);

      const list = await pgStore.list();
      assert.equal(list.length >= 1, true);
    });
  });
});
