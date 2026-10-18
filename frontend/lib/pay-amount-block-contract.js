const { hasInvoiceExpired } = require('./invoice-lifecycle');

/**
 * Format amount with fixed decimals (7 decimals for Stellar precision).
 *
 * @param {number | string} amount
 * @param {number} [decimals=7]
 * @returns {string}
 */
function formatAmount(amount, decimals = 7) {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(num) || num < 0) return (0).toFixed(decimals);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format date safely without throwing on invalid input.
 *
 * @param {string | Date} date
 * @returns {string | null}
 */
function formatDate(date) {
  try {
    const d = typeof date === 'string' ? new Date(date) : date;
    if (!d || !Number.isFinite(d.getTime())) return null;
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

/**
 * Calculate time remaining before invoice expires.
 *
 * @param {string | Date} expiresAt
 * @param {Date | string | number} [now]
 * @returns {string | null}
 */
function getTimeRemaining(expiresAt, now = Date.now()) {
  try {
    const nowMs = new Date(now).getTime();
    const expiryMs = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt.getTime();
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs)) return null;
    const diff = expiryMs - nowMs;

    if (diff <= 0) return 'Expired';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  } catch {
    return null;
  }
}

/**
 * Resolves the view model and state for the PayAmountBlock component.
 *
 * @param {any} invoice
 * @param {Date | string | number} [now]
 * @returns {{
 *   isValid: boolean;
 *   expired: boolean;
 *   status: string;
 *   isPaid: boolean;
 *   headerLabel: 'Invoice Amount' | 'Amount to Pay' | 'Payment Details';
 *   formattedAmount: string;
 *   assetCode: string;
 *   description: string | null;
 *   sellerName: string | null;
 *   sellerEmail: string | null;
 *   hasSellerInfo: boolean;
 *   paymentTxHash: string | null;
 *   expiryRemaining: string | null;
 *   formattedPaidAt: string | null;
 * }}
 */
function resolvePayAmountViewModel(invoice, now = Date.now()) {
  if (!invoice || typeof invoice !== 'object') {
    return {
      isValid: false,
      expired: false,
      status: 'UNKNOWN',
      isPaid: false,
      headerLabel: 'Payment Details',
      formattedAmount: formatAmount(0, 7),
      assetCode: 'XLM',
      description: null,
      sellerName: null,
      sellerEmail: null,
      hasSellerInfo: false,
      paymentTxHash: null,
      expiryRemaining: null,
      formattedPaidAt: null,
    };
  }

  const isExpiredByDate = hasInvoiceExpired(invoice, now);
  const expired = invoice.status === 'EXPIRED' || isExpiredByDate;
  const status = invoice.status || (expired ? 'EXPIRED' : 'PENDING');
  const isPaid = status === 'PAID';

  const rawAmount =
    typeof invoice.amount === 'number'
      ? invoice.amount
      : parseFloat(String(invoice.amount ?? '0'));
  const safeAmount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;
  const formattedAmount = formatAmount(safeAmount, 7);

  const rawAsset = typeof invoice.assetCode === 'string' ? invoice.assetCode.trim() : '';
  const assetCode = rawAsset ? rawAsset.toUpperCase() : 'XLM';

  const description =
    typeof invoice.description === 'string' && invoice.description.trim()
      ? invoice.description.trim()
      : null;

  const sellerName =
    typeof invoice.sellerName === 'string' && invoice.sellerName.trim()
      ? invoice.sellerName.trim()
      : null;

  const sellerEmail =
    typeof invoice.sellerEmail === 'string' && invoice.sellerEmail.trim()
      ? invoice.sellerEmail.trim()
      : null;

  const hasSellerInfo = Boolean(sellerName || sellerEmail);

  const paymentTxHash =
    typeof invoice.paymentTxHash === 'string' && invoice.paymentTxHash.trim()
      ? invoice.paymentTxHash.trim()
      : null;

  let expiryRemaining = null;
  if (status === 'PENDING' && invoice.expiresAt && !expired) {
    const remaining = getTimeRemaining(invoice.expiresAt, now);
    if (remaining && remaining !== 'Expired') {
      expiryRemaining = remaining;
    }
  }

  let formattedPaidAt = null;
  if (isPaid && invoice.paidAt) {
    formattedPaidAt = formatDate(invoice.paidAt);
  }

  const headerLabel = expired ? 'Invoice Amount' : 'Amount to Pay';

  return {
    isValid: true,
    expired,
    status,
    isPaid,
    headerLabel,
    formattedAmount,
    assetCode,
    description,
    sellerName,
    sellerEmail,
    hasSellerInfo,
    paymentTxHash,
    expiryRemaining,
    formattedPaidAt,
  };
}

module.exports = {
  formatAmount,
  formatDate,
  getTimeRemaining,
  resolvePayAmountViewModel,
};
