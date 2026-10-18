// Projection of StoredInvoice used by the dashboard stats aggregator. Uses a
// strict subset of StoredInvoice fields so both storage backends can feed the
// same pure calculateInvoiceStats helper without re-mapping types — the memory
// backend passes raw invoices, the Postgres backend maps a COUNT/SUM row to
// this shape.  Keeps sellerPublicKey, amount, assetCode, status in the same
// casing as StoredInvoice to avoid silent rename bugs.
export interface StatsInvoice {
  sellerPublicKey: string;
  amount: number;
  assetCode: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
}

export interface InvoiceStats {
  total_invoices: number;
  paid_invoices: number;
  pending_invoices: number;
  actionable_invoices: number;
  expired_invoices: number;
  revenue_by_asset: Record<string, number>;
}

export class InvalidInvoiceStatsInputError extends TypeError {
  readonly code = 'INVALID_INVOICE_STATS_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvoiceStatsInputError';
  }
}

const INVOICE_STATUSES = new Set<StatsInvoice['status']>([
  'PENDING',
  'PAID',
  'EXPIRED',
  'CANCELLED',
]);

function validateStatsInput(allInvoices: StatsInvoice[], sellerPublicKey: string): void {
  if (!Array.isArray(allInvoices)) {
    throw new InvalidInvoiceStatsInputError('Invoices must be an array');
  }
  if (typeof sellerPublicKey !== 'string' || sellerPublicKey.trim().length === 0) {
    throw new InvalidInvoiceStatsInputError('Seller public key is required');
  }

  for (const invoice of allInvoices as unknown[]) {
    if (
      typeof invoice !== 'object' || invoice === null || Array.isArray(invoice) ||
      typeof (invoice as StatsInvoice).sellerPublicKey !== 'string' ||
      (invoice as StatsInvoice).sellerPublicKey.trim().length === 0 ||
      typeof (invoice as StatsInvoice).assetCode !== 'string' ||
      (invoice as StatsInvoice).assetCode.trim().length === 0 ||
      typeof (invoice as StatsInvoice).amount !== 'number' ||
      !Number.isFinite((invoice as StatsInvoice).amount) ||
      (invoice as StatsInvoice).amount < 0 ||
      !INVOICE_STATUSES.has((invoice as StatsInvoice).status)
    ) {
      throw new InvalidInvoiceStatsInputError('Invoice contains invalid stats fields');
    }
  }
}

export function calculateInvoiceStats(
  allInvoices: StatsInvoice[],
  sellerPublicKey: string
): InvoiceStats {
  validateStatsInput(allInvoices, sellerPublicKey);
  const invoices = allInvoices.filter(
    invoice => invoice.sellerPublicKey === sellerPublicKey
  );
  const revenueByAsset: Record<string, number> = {};

  invoices
    .filter(invoice => invoice.status === 'PAID')
    .forEach((invoice) => {
      const currentRevenue = Object.prototype.hasOwnProperty.call(
        revenueByAsset,
        invoice.assetCode
      )
        ? revenueByAsset[invoice.assetCode]
        : 0;
      // Define the key explicitly so special property names such as
      // "__proto__" remain ordinary asset codes instead of mutating the map.
      Object.defineProperty(revenueByAsset, invoice.assetCode, {
        configurable: true,
        enumerable: true,
        value: currentRevenue + invoice.amount,
        writable: true,
      });
    });

  const pendingInvoices = invoices.filter(isPendingInvoice).length;

  return {
    total_invoices: invoices.length,
    paid_invoices: invoices.filter(invoice => invoice.status === 'PAID').length,
    pending_invoices: pendingInvoices,
    actionable_invoices: pendingInvoices,
    expired_invoices: invoices.filter(invoice => invoice.status === 'EXPIRED').length,
    revenue_by_asset: revenueByAsset,
  };
}
