const { assertPaymentProofAvailable, canExportPaymentProof } = require('./payment-proof-policy.js');
const { PRINT_DOCUMENT_CSP, escapeHtml } = require('./safe-content.js');

function safeFormatDate(value, pattern, fallback = '') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) {
      return fallback;
    }
    return d.toISOString();
  } catch {
    return fallback;
  }
}

function generateInvoicePDF(invoice) {
  if (!invoice || typeof invoice !== 'object') {
    throw new Error('Invoice object is required to generate PDF');
  }

  assertPaymentProofAvailable(invoice);
  const network =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'TESTNET' ? 'Testnet' : 'Mainnet';
  const isPaid = invoice.status === 'PAID';

  const rawId = invoice.id || '';
  const displayId = rawId.substring(0, 8).toUpperCase();
  const createdDateStr = safeFormatDate(invoice.createdAt, 'MMM dd, yyyy', 'N/A');
  const expiresDateStr = safeFormatDate(invoice.expiresAt, 'MMM dd, yyyy', 'N/A');
  const paidDateStr = safeFormatDate(invoice.paidAt, 'MMM dd, yyyy HH:mm', 'N/A');
  const downloadedDateStr = safeFormatDate(new Date(), 'PPpp', new Date().toISOString());

  const origin =
    typeof window !== 'undefined' && window.location && window.location.origin
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
    body { font-family: Arial, sans-serif; padding: 20px; color: #1f2937; background: white; font-size: 14px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">Quittance</div>
    <div class="invoice-title">
      <h1>INVOICE PROOF</h1>
      <div class="invoice-number">#${escapeHtml(displayId)}</div>
      <span class="status-badge status-${escapeHtml((invoice.status || '').toLowerCase())}"> Status: ${escapeHtml(invoice.status)}</span>
    </div>
  </div>

  <div class="amount-section">
    <div class="amount-label">Amount ${isPaid ? 'Paid' : 'Due'}</div>
    <div class="amount-value">${invoice.amount !== null && invoice.amount !== undefined ? invoice.amount : ''}</div>
    <div class="amount-asset">${escapeHtml(invoice.assetCode || '')}</div>
  </div>

  <table class="details-table">
    <tr><th scope="row">Invoice ID</th><td>${escapeHtml(invoice.id)}</td></tr>
    <tr><th scope="row">Memo</th><td>${escapeHtml(invoice.memo)}</td></tr>
    <tr><th scope="row">Seller Address</th><td>${escapeHtml(invoice.sellerPublicKey)}</td></tr>
    ${isPaid && invoice.paymentTxHash ? `
    <tr><th scope="row">Verified Transaction Hash</th><td>${escapeHtml(invoice.paymentTxHash)}</td></tr>
    <tr><th scope="row">Payer Address</th><td>${escapeHtml(invoice.payerPublicKey || 'N/A')}</td></tr>` : ''}
    <tr><th scope="row">Network</th><td>${network}</td></tr>
  </table>

  ${isPaid ? `
  <div class="blockchain-info" role="region" aria-label="Payment Verification Status">
    <p><strong> [STATUS: PAID] Verified Settlement Record</strong></p>
    <p>This payment was verified against the Stellar ledger. Re-verify live status at any time:</p>
    <p style="margin-top: 4px; font-family: monospace; font-size: 11px; word-break: break-all;">
      <a href="${escapeHtml(verifyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(verifyUrl)}</a>
    </p>
  </div>` : ''}

  <div class="footer">
    <p><strong>Quittance</strong> - Stellar Payment Platform</p>
    <p>Verified At: ${escapeHtml(paidDateStr)} | Document Downloaded At: ${escapeHtml(downloadedDateStr)}</p>
  </div>
</body>
</html>`;
}

module.exports = {
  generateInvoicePDF,
  assertPaymentProofAvailable,
  canExportPaymentProof,
};
