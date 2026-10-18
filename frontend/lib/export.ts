import { format } from 'date-fns';
import {
  assertPaymentProofAvailable,
  canExportPaymentProof,
} from './payment-proof-policy.js';
import {
  buildInvoiceMailto,
  buildProofMailto,
  canSendInvoiceEmail,
  canSendProofEmail,
  getInvoiceMailtoRecipient,
  getProofMailtoRecipient,
  openInvoiceMailto,
  openProofMailto,
} from './mailto-delivery.js';

import {
  PRINT_DOCUMENT_CSP,
  buildMailtoUrl,
  csvCell,
  escapeHtml,
} from './safe-content.js';

export { assertPaymentProofAvailable, canExportPaymentProof };
export { escapeHtml };

export interface Invoice {
  id: string;
  amount: number;
  assetCode: string;
  assetIssuer?: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
  sellerName?: string;
  sellerEmail?: string;
  payerName?: string;
  payerEmail?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  paidAt?: string;
  cancelledAt?: string;
  settledAt?: string;
  settlementContext?: 'ON_TIME' | 'AFTER_EXPIRY' | 'AFTER_CANCEL';
  priorStatus?: string;
  latePaymentWarningCode?: 'PAYMENT_RECEIVED_AFTER_EXPIRY' | 'PAYMENT_RECEIVED_AFTER_CANCEL';
  memo: string;
  sellerPublicKey: string;
  payerPublicKey?: string;
  paymentTxHash?: string;
}

/**
 * Safely formats a date without throwing RangeError on invalid date values.
 *
 * @param value Date input (string, number, Date)
 * @param formatPattern date-fns format string
 * @param fallback default string if date is invalid or missing
 */
export function safeFormatDate(
  value: unknown,
  formatPattern: string,
  fallback = ''
): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    const d = new Date(value as string | number | Date);
    if (!Number.isFinite(d.getTime())) {
      return fallback;
    }
    return format(d, formatPattern);
  } catch {
    return fallback;
  }
}

/**
 * Generates CSV content from an array of invoices with formula-injection protection
 * and resilient handling of missing or corrupted fields (issue #148).
 */
export function generateInvoiceCSV(invoices: Invoice[]): string {
  const headers = [
    'Invoice ID',
    'Date',
    'Seller Name',
    'Seller Email',
    'Customer Name',
    'Customer Email',
    'Description',
    'Amount',
    'Asset',
    'Status',
    'Payment Date',
    'Payer Name',
    'Payer Email',
    'Expires At',
    'Memo',
    'Transaction Hash',
  ];

  if (!Array.isArray(invoices) || invoices.length === 0) {
    return headers.join(',');
  }

  const rows = invoices
    .filter((inv) => inv && typeof inv === 'object')
    .map((inv) => [
      inv.id || '',
      safeFormatDate(inv.createdAt, 'yyyy-MM-dd HH:mm:ss', ''),
      inv.sellerName || '',
      inv.sellerEmail || '',
      inv.customerName || '',
      inv.customerEmail || '',
      inv.description || '',
      inv.amount !== null && inv.amount !== undefined ? inv.amount : '',
      inv.assetCode || '',
      inv.status || '',
      safeFormatDate(inv.paidAt, 'yyyy-MM-dd HH:mm:ss', ''),
      inv.payerName || '',
      inv.payerEmail || '',
      safeFormatDate(inv.expiresAt, 'yyyy-MM-dd HH:mm:ss', ''),
      inv.memo || '',
      inv.paymentTxHash || '',
    ]);

  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\n');

  return csvContent;
}

/**
 * Triggers a browser download of an invoice CSV file.
 * Safely guards against non-browser (SSR) environments.
 */
export function downloadInvoiceCSV(invoices: Invoice[], filename?: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const csv = generateInvoiceCSV(invoices);
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  const defaultFilename = `invoices-${safeFormatDate(new Date(), 'yyyy-MM-dd-HHmmss', 'export')}.csv`;
  link.setAttribute('href', url);
  link.setAttribute('download', filename || defaultFilename);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generates standalone printable HTML for an invoice PDF.
 * Hardens boundary contracts for date tolerance, character escaping, and proof checks (issue #148).
 */
export function generateInvoicePDF(invoice: Invoice): string {
  if (!invoice || typeof invoice !== 'object') {
    throw new Error('Invoice object is required to generate PDF');
  }

  assertPaymentProofAvailable(invoice);
  const network =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'TESTNET' ? 'Testnet' : 'Mainnet';
  const isPaid = invoice.status === 'PAID';
  const warning = latePaymentWarning(invoice);

  const rawId = invoice.id || '';
  const displayId = rawId.substring(0, 8).toUpperCase();
  const safeStatus = (invoice.status || '').toLowerCase();
  const createdDateStr = safeFormatDate(invoice.createdAt, 'MMM dd, yyyy', 'N/A');
  const expiresDateStr = safeFormatDate(invoice.expiresAt, 'MMM dd, yyyy', 'N/A');
  const paidDateStr = safeFormatDate(invoice.paidAt, 'MMM dd, yyyy HH:mm', 'N/A');
  const downloadedDateStr = safeFormatDate(new Date(), 'PPpp', new Date().toISOString());

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://quittance.app';
  const verifyUrl = `${origin}/pay/${encodeURIComponent(rawId)}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_DOCUMENT_CSP}">
  <title>Payment Proof - Invoice #${escapeHtml(invoice.id)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: Arial, sans-serif; 
      padding: 20px; 
      color: #1f2937; 
      background: white; 
      font-size: 14px;
      line-height: 1.4;
    }
    @media print {
      .no-print { display: none !important; }
    }
    .header { 
      display: flex; 
      justify-content: space-between; 
      margin-bottom: 30px; 
      padding-bottom: 15px; 
      border-bottom: 2px solid #0f766e; 
    }
    .logo { 
      font-size: 24px; 
      font-weight: bold; 
      color: #0f766e; 
    }
    .invoice-title { 
      text-align: right; 
    }
    .invoice-title h1 { 
      font-size: 28px; 
      color: #111827; 
      margin-bottom: 5px; 
    }
    .invoice-number { 
      color: #4b5563; 
      font-size: 12px; 
    }
    .status-badge { 
      display: inline-block; 
      padding: 4px 8px; 
      border-radius: 4px; 
      font-size: 10px; 
      font-weight: 600; 
      text-transform: uppercase; 
      margin-top: 8px; 
    }
    .status-paid { background: #d1fae5; color: #065f46; border: 2px solid #059669; }
    .status-pending { background: #fef3c7; color: #92400e; border: 2px solid #d97706; }
    .status-expired { background: #fee2e2; color: #991b1b; border: 2px solid #dc2626;}
    .info-grid { 
      display: flex; 
      gap: 20px; 
      margin-bottom: 30px; 
    }
    .info-section { 
      flex: 1;
      padding: 15px; 
      background: #f9fafb; 
      border-radius: 6px; 
    }
    .info-section h2 { 
      font-size: 12px; 
      color: #4b5563; 
      text-transform: uppercase; 
      margin-bottom: 10px; 
      letter-spacing: 0.5px; 
    }
    .info-row { 
      margin-bottom: 8px; 
    }
    .info-label { 
      font-size: 11px; 
      color: #4b5563; 
      margin-bottom: 2px; 
    }
    .info-value { 
      font-size: 12px; 
      color: #111827; 
      font-weight: 500; 
    }
    .amount-section { 
      background: #0e7490; 
      padding: 20px; 
      border-radius: 8px; 
      text-align: center; 
      margin-bottom: 20px; 
    }
    .amount-label { 
      color: white; 
      font-size: 12px; 
      margin-bottom: 8px; 
    }
    .amount-value { 
      font-size: 36px; 
      font-weight: bold; 
      color: white; 
      margin-bottom: 5px; 
    }
    .amount-asset { 
      color: white; 
      font-size: 16px; 
      font-weight: 600; 
    }
    .details-table { 
      width: 100%; 
      margin-bottom: 20px; 
      border-collapse: collapse;
    }
    .details-table tr { 
      border-bottom: 1px solid #e5e7eb; 
    }
    .details-table th, .details-table td { 
      padding: 8px 0; 
      text-align: left;
    }
    .details-table th { 
      color: #4b5563; 
      font-size: 11px; 
      font-weight: 600;
      width: 30%; 
    }
    .details-table td { 
      color: #111827; 
      font-size: 12px; 
      font-weight: 500; 
    }
    .footer { 
      margin-top: 30px; 
      padding-top: 15px; 
      border-top: 1px solid #e5e7eb; 
      text-align: center; 
      color: #4b5563; 
      font-size: 11px; 
    }
    .blockchain-info { 
      background: #fef3c7; 
      padding: 10px; 
      border-radius: 6px; 
      margin-bottom: 15px; 
      border-left: 3px solid #f59e0b; 
    }
    .blockchain-info p { 
      font-size: 11px; 
      color: #92400e; 
      line-height: 1.4; 
    }
    .late-warning {
      background: #fffbeb;
      border: 1px solid #fbbf24;
      border-left: 3px solid #d97706;
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 15px;
    }
    .late-warning p {
      font-size: 10px;
      color: #92400e;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">Quittance</div>
    <div class="invoice-title">
      <h1>INVOICE PROOF</h1>
      <div class="invoice-number">#${escapeHtml(invoice.id.substring(0, 8).toUpperCase())}</div>
      <span class="status-badge status-${escapeHtml(invoice.status.toLowerCase())}" aria-label="Invoice Status: ${escapeHtml(invoice.status)}"> Status: ${escapeHtml(invoice.status)}</span>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-section">
      <h2>Bill To</h2>
      ${invoice.customerName ? `<div class="info-row"><div class="info-label">Customer Name</div><div class="info-value">${escapeHtml(invoice.customerName)}</div></div>` : ''}
      ${invoice.customerEmail ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value">${escapeHtml(invoice.customerEmail)}</div></div>` : ''}
      ${!invoice.customerName && !invoice.customerEmail ? `<div class="info-value">N/A</div>` : ''}
    </div>

    <div class="info-section">
      <h2>Invoice Details</h2>
      <div class="info-row">
        <div class="info-label">Issue Date</div>
        <div class="info-value">${escapeHtml(createdDateStr)}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Expires</div>
        <div class="info-value">${escapeHtml(expiresDateStr)}</div>
      </div>
      ${isPaid ? `<div class="info-row"><div class="info-label">Verified Payment Date</div><div class="info-value">${escapeHtml(paidDateStr)}</div></div>` : ''}
    </div>
  </div>

  ${invoice.sellerName || invoice.sellerEmail ? `
  <div class="info-section" style="margin-bottom: 20px;">
    <h2>Seller Information</h2>
    ${invoice.sellerName ? `<div class="info-row"><div class="info-label">Name</div><div class="info-value">${escapeHtml(invoice.sellerName)}</div></div>` : ''}
    ${invoice.sellerEmail ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value">${escapeHtml(invoice.sellerEmail)}</div></div>` : ''}
  </div>` : ''}

  ${isPaid && (invoice.payerName || invoice.payerEmail) ? `
  <div class="info-section" style="margin-bottom: 20px;">
    <h2>Payer Information</h2>
    ${invoice.payerName ? `<div class="info-row"><div class="info-label">Name</div><div class="info-value">${escapeHtml(invoice.payerName)}</div></div>` : ''}
    ${invoice.payerEmail ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value">${escapeHtml(invoice.payerEmail)}</div></div>` : ''}
  </div>` : ''}

  <div class="amount-section">
    <div class="amount-label">Amount ${isPaid ? 'Paid' : 'Due'}</div>
    <div class="amount-value">${invoice.amount !== null && invoice.amount !== undefined ? invoice.amount : ''}</div>
    <div class="amount-asset">${escapeHtml(invoice.assetCode || '')}</div>
  </div>

  ${invoice.description ? `<div class="info-section" style="margin-bottom: 20px;"><h2>Description</h2><p style="color: #1f2937; line-height: 1.6;">${escapeHtml(invoice.description)}</p></div>` : ''}

  <table class="details-table">
    <tr><th scope="row">Invoice ID</th><td style="font-family: monospace; font-size: 12px;">${escapeHtml(invoice.id)}</td></tr>
    <tr><th scope="row">Memo</th><td style="font-family: monospace;">${escapeHtml(invoice.memo)}</td></tr>
    <tr><th scope="row">Seller Address</th><td style="font-family: monospace; font-size: 11px; word-break: break-all;">${escapeHtml(invoice.sellerPublicKey)}</td></tr>
    ${isPaid && invoice.paymentTxHash ? `
    <tr><th scope="row">Verified Transaction Hash</th><td style="font-family: monospace; font-size: 11px; word-break: break-all;">${escapeHtml(invoice.paymentTxHash)}</td></tr>
    <tr><th scope="row">Payer Address</th><td style="font-family: monospace; font-size: 11px; word-break: break-all;">${escapeHtml(invoice.payerPublicKey || 'N/A')}</td></tr>
    ${invoice.payerName ? `<tr><th scope="row">Payer Name</th><td>${escapeHtml(invoice.payerName)}</td></tr>` : ''}
    ${invoice.payerEmail ? `<tr><th scope="row">Payer Email</th><td>${escapeHtml(invoice.payerEmail)}</td></tr>` : ''}` : ''}
    <tr><th scope="row">Network</th><td>${network}</td></tr>
  </table>

  ${isPaid ? `
  <div class="blockchain-info" role="region" aria-label="Payment Verification Status">
    <p><strong> [STATUS: PAID] Verified Settlement Record</strong></p>
    <p>This payment was verified against the Stellar ledger. Re-verify live status at any time:</p>
    <p style="margin-top: 4px; font-family: monospace; font-size: 11px; word-break: break-all;">
      <a href="${escapeHtml(verifyUrl)}" target="_blank" rel="noopener noreferrer" style="color: #0f766e; text-decoration: underline;">${escapeHtml(verifyUrl)}</a>
    </p>
  </div>` : ''}

  <div class="footer">
    <p><strong>Quittance</strong> - Stellar Payment Platform</p>
    <p>Verified At: ${escapeHtml(paidDateStr)} | Document Downloaded At: ${escapeHtml(downloadedDateStr)}</p>
    <p style="margin-top: 10px;">This is an automatically generated payment proof.</p>
  </div>

  <div class="no-print" style="position: fixed; top: 10px; right: 10px; background: #0f766e; color: white; padding: 15px; border-radius: 8px; z-index: 1000; max-width: 300px; font-family: Arial, sans-serif;">
    <h3 style="margin: 0 0 10px 0; font-size: 14px;">To Save as PDF or Print:</h3>
    <ol style="margin: 0; padding-left: 20px; font-size: 12px;">
      <li>Press Ctrl+P (Windows) or Cmd+P (Mac)</li>
      <li>Select "Destination" &rarr; "Save as PDF"</li>
      <li>Click "Save" or "Print"</li>
    </ol>
    <button type="button" onclick="window.print()" style="background: white; color: #0f766e; border: none; padding: 8px 16px; border-radius: 4px; margin-top: 10px; cursor: pointer; font-weight: bold; font-size: 12px;">
      Save as PDF / Print
    </button>
  </div>

</body>
</html>`;
}

export function openInvoicePDF(invoice: Invoice) {
  
  const triggerElement = document.activeElement as HTMLElement | null;

  const toastId = toast.loading('Preparing payment proof for printing...');

  try {
    const pdfContent = generateInvoicePDF(invoice);
    const printWindow = window.open('', '_blank', 'width=800,height=600');

    if (!printWindow) {
      toast.error('Pop-up blocked. Please allow pop-ups to print payment proof.', { id: toastId });
      triggerElement?.focus();
      return;
    }

    printWindow.document.write(pdfContent);
    printWindow.document.close();

    printWindow.onload = () => {
      toast.success('Payment proof ready. Opening print dialog...', { id: toastId });

      setTimeout(() => {
        printWindow.print();

        printWindow.onafterprint = () => {
          triggerElement?.focus();
        };

        setTimeout(() => {
          triggerElement?.focus();
        }, 1000);
      }, 500);
    };
  } catch (err) {
    toast.error('Failed to generate payment proof PDF.', { id: toastId });
    triggerElement?.focus();
  }

  return false;
}

/**
 * Opens the system email client to share an invoice link or payment proof.
 */
export function shareInvoiceByEmail(invoice: Invoice): void {
  if (typeof window === 'undefined') {
    return;
  }

  assertPaymentProofAvailable(invoice);
  if (!invoice.customerEmail) {
    throw new Error('Client email is required to send this invoice');
  }

  const rawId = invoice.id || '';
  const displayId = rawId.substring(0, 8).toUpperCase();
  const subject = `Invoice #${displayId} - ${invoice.amount} ${invoice.assetCode}`;
  const isPaid = invoice.status === 'PAID';

  let body = `Invoice Details:\n`;
  body += `Invoice ID: ${rawId}\n`;
  body += `Amount: ${invoice.amount} ${invoice.assetCode}\n`;
  body += `Status: ${invoice.status}\n`;

  if (invoice.customerName) body += `Client: ${invoice.customerName}\n`;
  if (invoice.description) body += `Description: ${invoice.description}\n`;

  if (isPaid && invoice.paymentTxHash) {
    body += `\nPayment Information:\n`;
    body += `Payment Date: ${safeFormatDate(invoice.paidAt, 'PPpp', '')}\n`;
    body += `Transaction Hash: ${invoice.paymentTxHash}\n`;
    if (invoice.payerPublicKey) body += `Payer Address: ${invoice.payerPublicKey}\n`;
    body += `Verified on Stellar Blockchain\n`;
  } else {
    body += `\nQuittance: ${window.location.origin}/pay/${rawId}\n`;
  }

  body += `\nPowered by Quittance`;

  const mailtoLink = buildMailtoUrl(invoice.customerEmail, subject, body);
  if (!mailtoLink) {
    throw new Error('Client email address is not valid');
  }
  window.location.href = mailtoLink;
}
