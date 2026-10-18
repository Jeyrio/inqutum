import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PostgresInvoiceStorage } from '../src/storage/postgres-invoice-storage.ts';
import type { InvoiceService } from '../src/services/invoice.service.ts';

describe('PostgresInvoiceStorage adapter contract', () => {
  it('returns delegated stats unchanged on success', async () => {
    const stats = [{
      total_invoices: 2,
      paid_invoices: 1,
      pending_invoices: 1,
      actionable_invoices: 1,
      expired_invoices: 0,
      revenue_by_asset: { XLM: 12 },
    }];
    let calls = 0;
    const service = {
      getInvoiceStats: async () => {
        calls += 1;
        return stats;
      },
    } as unknown as InvoiceService;
    const storage = new PostgresInvoiceStorage(service);

    assert.equal(await storage.getInvoiceStats('GSELLER'), stats);
    assert.equal(calls, 1);
  });

  it('preserves dependency error codes and does not retry a failed write', async () => {
    const dependencyError = Object.assign(new Error('Database temporarily unavailable'), {
      code: 'DATABASE_UNAVAILABLE',
    });
    let calls = 0;
    const service = {
      createInvoice: async () => {
        calls += 1;
        throw dependencyError;
      },
    } as unknown as InvoiceService;
    const storage = new PostgresInvoiceStorage(service);

    await assert.rejects(
      storage.createInvoice({} as any),
      error => error === dependencyError && (error as any).code === 'DATABASE_UNAVAILABLE'
    );
    assert.equal(calls, 1);
  });

  it('delegates validation failures without replacing the service error', async () => {
    const validationError = Object.assign(new Error('Seller public key is required'), {
      code: 'INVALID_SELLER_PUBLIC_KEY',
    });
    const service = {
      getInvoiceStats: async () => {
        throw validationError;
      },
    } as unknown as InvoiceService;
    const storage = new PostgresInvoiceStorage(service);

    await assert.rejects(
      storage.getInvoiceStats(''),
      error => error === validationError && (error as any).code === 'INVALID_SELLER_PUBLIC_KEY'
    );
  });
});
