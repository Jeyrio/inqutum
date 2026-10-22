// A small in-process stand-in for the Postgres `invoices` + `payment_events`
// tables. It understands only the statements InvoiceService issues, matched by
// their leading text like the doubles in the older suites, so SQL parameter
// order and row mapping stay under test without a database.
//
// Unlike those per-file doubles it also keeps the audit rows, which is what the
// lifecycle and reconciliation suites read back.
import type { Queryable } from '../../src/services/invoice.service.ts';

const INSERT_COLUMNS = [
  'id',
  'seller_public_key',
  'seller_name',
  'seller_email',
  'amount',
  'asset_code',
  'asset_issuer',
  'memo',
  'description',
  'customer_name',
  'customer_email',
  'status',
  'expires_at',
];

export interface FakeEventRow {
  id: string;
  invoice_id: string;
  event_type: string;
  event_data: any;
  created_at: Date;
}

export class FakeInvoiceDb implements Queryable {
  rows: Record<string, any>[] = [];
  events: FakeEventRow[] = [];
  private eventSeq = 0;

  async query(text: string, params: any[] = []) {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('INSERT INTO invoices')) {
      const row: Record<string, any> = {
        created_at: new Date(),
        paid_at: null,
        metadata: null,
        payment_tx_hash: null,
        payer_public_key: null,
        payer_name: null,
        payer_email: null,
        cancelled_at: null,
        settled_at: null,
        settlement_context: null,
        prior_status: null,
        late_payment_warning_code: null,
        // The real INSERT sets version to the literal 1.
        version: 1,
      };
      INSERT_COLUMNS.forEach((column, index) => {
        row[column] = params[index] ?? null;
      });
      // Postgres returns DECIMAL as a string.
      row.amount = String(row.amount);
      this.rows.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'EXPIRED'")) {
      const now = new Date(params[0]).getTime();
      const expired = this.rows.filter(
        (row) => row.status === 'PENDING' && new Date(row.expires_at).getTime() <= now
      );
      expired.forEach((row) => {
        row.status = 'EXPIRED';
      });
      return { rows: expired.map((row) => ({ id: row.id })), rowCount: expired.length };
    }

    if (sql.startsWith('WITH settled AS')) {
      const settledAt = params[5] ? new Date(params[5]) : new Date();
      const expectedVersion = params[6] ?? null;
      const row = this.rows.find(
        (candidate) =>
          candidate.id === params[0] &&
          (expectedVersion === null || candidate.version === expectedVersion) &&
          ((candidate.status === 'PENDING' && new Date(candidate.expires_at).getTime() > Date.now()) ||
            (candidate.status === 'CANCELLED' && candidate.cancelled_at && params[5]))
      );
      if (!row) return { rows: [], rowCount: 0 };
      const afterCancel =
        row.status === 'CANCELLED' && settledAt.getTime() >= new Date(row.cancelled_at).getTime();
      Object.assign(row, {
        prior_status: row.status === 'CANCELLED' ? 'CANCELLED' : null,
        status: 'PAID',
        payment_tx_hash: params[1],
        payer_public_key: params[2],
        payer_name: params[3],
        payer_email: params[4],
        paid_at: new Date(),
        settled_at: settledAt,
        settlement_context: afterCancel ? 'AFTER_CANCEL' : 'ON_TIME',
        late_payment_warning_code: afterCancel ? 'PAYMENT_RECEIVED_AFTER_CANCEL' : null,
        version: row.version + 1,
      });
      // The real statement writes the PAYMENT_CONFIRMED event in the same CTE.
      this.pushEvent(row.id, 'PAYMENT_CONFIRMED', { txHash: params[1], payerPublicKey: params[2] });
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'CANCELLED'")) {
      // Mirrors InvoiceService.cancelInvoice: [id, sellerPublicKey?, version?].
      const sellerPublicKey = params[1] ?? null;
      const expectedVersion = params[2] ?? null;
      const row = this.rows.find(
        (candidate) =>
          candidate.id === params[0] &&
          candidate.status === 'PENDING' &&
          (!sellerPublicKey || candidate.seller_public_key === sellerPublicKey) &&
          (expectedVersion === null || candidate.version === expectedVersion)
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'CANCELLED';
      row.cancelled_at = new Date();
      row.version += 1;
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO payment_events')) {
      this.pushEvent(params[0], params[1], params[2] ? JSON.parse(params[2]) : null);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, invoice_id, event_type, event_data, created_at FROM payment_events')) {
      const found = this.events.filter((event) => event.invoice_id === params[0]);
      return { rows: found.map((event) => ({ ...event })), rowCount: found.length };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE id =')) {
      const found = this.rows.filter((row) => row.id === params[0]);
      return { rows: found.map((row) => ({ ...row })), rowCount: found.length };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE memo =')) {
      const found = this.rows.filter((row) => row.memo === params[0]);
      return { rows: found.map((row) => ({ ...row })), rowCount: found.length };
    }

    if (sql.startsWith('SELECT id FROM invoices WHERE payment_tx_hash =')) {
      const found = this.rows.filter((row) => row.payment_tx_hash === params[0]);
      return { rows: found.map((row) => ({ id: row.id })), rowCount: found.length };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE seller_public_key =')) {
      let found = this.rows.filter((row) => row.seller_public_key === params[0]);
      if (params.length > 1 && typeof params[1] === 'string' && params[1] !== 'all') {
        found = found.filter((row) => row.status === params[1]);
      }
      return { rows: found.map((row) => ({ ...row })), rowCount: found.length };
    }

    if (sql.startsWith('SELECT COUNT(*) as total_invoices') || sql.includes('revenue_by_asset')) {
      const seller = params[0];
      const sellerRows = this.rows.filter((row) => row.seller_public_key === seller);
      const paidRows = sellerRows.filter((row) => row.status === 'PAID');
      const pendingRows = sellerRows.filter((row) => row.status === 'PENDING');
      const expiredRows = sellerRows.filter((row) => row.status === 'EXPIRED');

      const revenueByAsset: Record<string, number> = {};
      for (const row of paidRows) {
        const asset = row.asset_code || 'XLM';
        revenueByAsset[asset] = (revenueByAsset[asset] || 0) + parseFloat(row.amount || '0');
      }

      const row = {
        total_invoices: sellerRows.length,
        paid_invoices: paidRows.length,
        pending_invoices: pendingRows.length,
        actionable_invoices: pendingRows.length,
        expired_invoices: expiredRows.length,
        revenue_by_asset: revenueByAsset,
      };

      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM invoice_stats WHERE seller_public_key =') || sql.includes('FROM invoice_stats')) {
      const seller = params[0];
      const sellerRows = this.rows.filter((row) => row.seller_public_key === seller);
      const byAsset = new Map<string, any>();

      for (const row of sellerRows) {
        const asset = row.asset_code || 'XLM';
        if (!byAsset.has(asset)) {
          byAsset.set(asset, {
            seller_public_key: seller,
            total_invoices: 0,
            paid_invoices: 0,
            pending_invoices: 0,
            expired_invoices: 0,
            cancelled_invoices: 0,
            total_revenue: 0,
            asset_code: asset,
          });
        }
        const st = byAsset.get(asset);
        st.total_invoices += 1;
        if (row.status === 'PAID') {
          st.paid_invoices += 1;
          st.total_revenue += parseFloat(row.amount || '0');
        } else if (row.status === 'PENDING') {
          st.pending_invoices += 1;
        } else if (row.status === 'EXPIRED') {
          st.expired_invoices += 1;
        } else if (row.status === 'CANCELLED') {
          st.cancelled_invoices += 1;
        }
      }

      const rows = Array.from(byAsset.values()).map((s) => ({
        ...s,
        total_revenue: String(s.total_revenue),
      }));

      return { rows, rowCount: rows.length };
    }

    throw new Error(`FakeInvoiceDb: unsupported SQL: ${sql.slice(0, 120)}`);
  }

  /** Force an invoice past its expiry without going through the sweep. */
  backdateExpiry(id: string, msAgo = 60_000): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no such invoice ${id}`);
    row.expires_at = new Date(Date.now() - msAgo);
  }

  private pushEvent(invoiceId: string, eventType: string, eventData: any): void {
    this.eventSeq += 1;
    this.events.push({
      id: `evt-${this.eventSeq}`,
      invoice_id: invoiceId,
      event_type: eventType,
      event_data: eventData,
      // Strictly increasing so ordering assertions do not depend on clock ticks.
      created_at: new Date(Date.now() + this.eventSeq),
    });
  }
}
