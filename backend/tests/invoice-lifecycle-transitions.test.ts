/**
 * Formal lifecycle state-machine tests for every terminal and recovery
 * transition (Issue #242).
 *
 * domain-invariants.test.ts already models the allowed transition table,
 * but only against a test-local `canTransition()` reimplementation — it
 * never calls the real production code. These tests exercise the actual
 * `MemoryStorage` / `InvoiceMemoryService` methods directly, so a passing
 * suite proves the real implementation enforces the invariants, not just
 * that the test's own mental model is self-consistent.
 *
 * There is no "recovery" transition out of a terminal state implemented
 * anywhere in this codebase (no un-cancel, dispute, or refund path), so the
 * correct formal property to prove is that PAID/EXPIRED/CANCELLED are
 * permanently terminal under every mutating operation. This is intentional
 * and is not itself a gap this issue is meant to close — adding new
 * recovery states would be a product decision beyond "formal tests".
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';

const SELLER = 'G' + 'L'.repeat(55);
const PAYER = 'G' + 'P'.repeat(55);

describe('Invoice lifecycle: terminal and recovery transitions (Issue #242)', () => {
  let storage: MemoryStorage;
  let service: InvoiceMemoryService;

  beforeEach(() => {
    storage = new MemoryStorage();
    service = new InvoiceMemoryService(storage);
  });

  const createPending = async () =>
    service.createInvoice({
      sellerPublicKey: SELLER,
      amount: 100,
      assetCode: 'XLM',
      expiresInDays: 7,
    } as any);

  /** Forces a PENDING invoice overdue, bypassing the normal >=1-day validation. */
  const makeOverdue = (invoiceId: string) =>
    storage.updateInvoice(invoiceId, { expiresAt: new Date('2000-01-01T00:00:00.000Z') });

  describe('PENDING -> PAID (settlement)', () => {
    it('allows exactly one settlement of a pending, unexpired invoice', async () => {
      const invoice = await createPending();
      const paid = await service.markAsPaid(invoice.id, 'tx-1', PAYER);
      assert.equal(paid.status, 'PAID');
    });

    it('rejects a second settlement attempt (PAID is terminal)', async () => {
      const invoice = await createPending();
      await service.markAsPaid(invoice.id, 'tx-1', PAYER);
      await assert.rejects(() => service.markAsPaid(invoice.id, 'tx-2', PAYER), /not found, expired, or already processed/);
    });

    it('rejects settling an already-cancelled invoice', async () => {
      const invoice = await createPending();
      await service.cancelInvoice(invoice.id);
      await assert.rejects(() => service.markAsPaid(invoice.id, 'tx-1', PAYER), /not found, expired, or already processed/);
    });

    it('rejects settling an already-expired invoice', async () => {
      const invoice = await createPending();
      makeOverdue(invoice.id);
      await service.markExpiredInvoices();
      await assert.rejects(() => service.markAsPaid(invoice.id, 'tx-1', PAYER), /not found, expired, or already processed/);
    });
  });

  describe('PENDING -> CANCELLED', () => {
    it('allows cancelling a pending invoice exactly once', async () => {
      const invoice = await createPending();
      const cancelled = await service.cancelInvoice(invoice.id);
      assert.equal(cancelled.status, 'CANCELLED');
    });

    it('rejects cancelling an already-cancelled invoice (CANCELLED is terminal)', async () => {
      const invoice = await createPending();
      await service.cancelInvoice(invoice.id);
      await assert.rejects(() => service.cancelInvoice(invoice.id), /not found or already processed/);
    });

    it('rejects cancelling an already-paid invoice', async () => {
      const invoice = await createPending();
      await service.markAsPaid(invoice.id, 'tx-1', PAYER);
      await assert.rejects(() => service.cancelInvoice(invoice.id), /not found or already processed/);
    });

    it('rejects cancelling an already-expired invoice', async () => {
      const invoice = await createPending();
      makeOverdue(invoice.id);
      await service.markExpiredInvoices();
      await assert.rejects(() => service.cancelInvoice(invoice.id), /not found or already processed/);
    });
  });

  describe('PENDING -> EXPIRED (time-based)', () => {
    it('transitions an overdue pending invoice to EXPIRED', async () => {
      const invoice = await createPending();
      makeOverdue(invoice.id);
      const count = await service.markExpiredInvoices();
      assert.equal(count, 1);
      const reloaded = await service.getInvoiceById(invoice.id);
      assert.equal(reloaded?.status, 'EXPIRED');
    });

    it('never expires an already-paid invoice, even if its deadline has passed', async () => {
      const invoice = await createPending();
      makeOverdue(invoice.id);
      // Paying an expired invoice is itself rejected (covered above); assert
      // directly against storage that expiry sweeps never flip a PAID row.
      storage.updateInvoice(invoice.id, { status: 'PAID', paidAt: new Date() });
      await service.markExpiredInvoices();
      const reloaded = await service.getInvoiceById(invoice.id);
      assert.equal(reloaded?.status, 'PAID');
    });

    it('never expires an already-cancelled invoice', async () => {
      const invoice = await createPending();
      makeOverdue(invoice.id);
      storage.updateInvoice(invoice.id, { status: 'CANCELLED' });
      await service.markExpiredInvoices();
      const reloaded = await service.getInvoiceById(invoice.id);
      assert.equal(reloaded?.status, 'CANCELLED');
    });
  });

  describe('terminal states have no recovery path', () => {
    it('PAID, EXPIRED, and CANCELLED all reject every mutating operation', async () => {
      const paid = await createPending();
      await service.markAsPaid(paid.id, 'tx-1', PAYER);

      const expired = await createPending();
      makeOverdue(expired.id);
      await service.markExpiredInvoices();

      const cancelled = await createPending();
      await service.cancelInvoice(cancelled.id);

      for (const terminalInvoice of [paid, expired, cancelled]) {
        await assert.rejects(() => service.markAsPaid(terminalInvoice.id, 'tx-x', PAYER));
        await assert.rejects(() => service.cancelInvoice(terminalInvoice.id));
      }
    });
  });
});
