/**
 * Client-side fail-closed projection of the server expiry lifecycle (issues #231, #150).
 * Hardens boundary contracts for date parsing, status transitions, and immutability.
 */

/**
 * Safely parses an expiry value into a numeric Unix millisecond timestamp.
 *
 * Handles ISO-8601 strings, Date instances, and epoch numeric timestamps
 * (normalizing 10-digit epoch seconds to 13-digit milliseconds).
 *
 * @param {string | number | Date | null | undefined} expiresAt
 * @returns {number | null} Unix millisecond timestamp or null if invalid/missing
 */
function expiryTimestamp(expiresAt) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') {
    return null;
  }

  // Handle epoch seconds vs milliseconds if passed as number
  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return expiresAt < 1e11 ? Math.floor(expiresAt * 1000) : Math.floor(expiresAt);
  }

  // Handle Date instance or date string
  try {
    const parsed = new Date(expiresAt).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes reference time 'now' into a finite millisecond timestamp.
 * Fallbacks to Date.now() if invalid or not supplied.
 *
 * @param {number | string | Date} now
 * @returns {number}
 */
function normalizeNow(now) {
  if (now === undefined || now === null) {
    return Date.now();
  }
  if (typeof now === 'number' && Number.isFinite(now)) {
    return now;
  }
  const parsed = new Date(now).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Determines whether an invoice has reached or exceeded its expiration.
 *
 * Fail-closed rules:
 * - Invoices explicitly marked 'EXPIRED' always return true.
 * - Invoices with status other than 'PENDING' (e.g. 'PAID', 'CANCELLED') never expire.
 * - If expiresAt <= now, returns true.
 * - Returns false for null/undefined invoices or unresolvable timestamps.
 *
 * @param {{ status?: string, expiresAt?: any }} invoice
 * @param {number | string | Date} now
 * @returns {boolean}
 */
function hasInvoiceExpired(invoice, now = Date.now()) {
  if (!invoice || typeof invoice !== 'object') {
    return false;
  }

  // Status-based early checks
  if (invoice.status === 'EXPIRED') {
    return true;
  }
  if (invoice.status !== 'PENDING') {
    return false;
  }

  const expiresAt = expiryTimestamp(invoice.expiresAt);
  if (expiresAt === null) {
    return false;
  }

  const current = normalizeNow(now);
  return expiresAt <= current;
}

/**
 * Returns the effective lifecycle status of an invoice.
 *
 * Returns 'EXPIRED' if an invoice has expired; otherwise returns the declared status.
 *
 * @param {{ status?: string, expiresAt?: any }} invoice
 * @param {number | string | Date} now
 * @returns {string | undefined}
 */
function effectiveInvoiceStatus(invoice, now = Date.now()) {
  if (!invoice || typeof invoice !== 'object') {
    return undefined;
  }
  return hasInvoiceExpired(invoice, now) ? 'EXPIRED' : invoice.status;
}

/**
 * Returns an invoice with its status updated to 'EXPIRED' if it has expired.
 * Preserves object immutability: returns the original reference if unchanged.
 *
 * @param {T} invoice
 * @param {number | string | Date} now
 * @returns {T}
 */
function applyExpiryStatus(invoice, now = Date.now()) {
  if (!invoice || typeof invoice !== 'object') {
    return invoice;
  }
  if (effectiveInvoiceStatus(invoice, now) === invoice.status) {
    return invoice;
  }
  return { ...invoice, status: 'EXPIRED' };
}

/**
 * Applies expiry lifecycle transitions across a collection of invoices.
 * Returns an empty array if input is not an array.
 *
 * @param {Array<any>} invoices
 * @param {number | string | Date} now
 * @returns {Array<any>}
 */
function applyExpiryLifecycle(invoices, now = Date.now()) {
  if (!Array.isArray(invoices)) {
    return [];
  }
  return invoices.map((invoice) => applyExpiryStatus(invoice, now));
}

/**
 * Checks if an invoice is in an actionable state (ready to receive payments).
 * An invoice is actionable only if its effective status is 'PENDING' and no
 * transaction hash has been registered.
 *
 * @param {{ status?: string, paymentTxHash?: string, expiresAt?: any }} invoice
 * @param {number | string | Date} now
 * @returns {boolean}
 */
function isActionableInvoice(invoice, now = Date.now()) {
  if (!invoice || typeof invoice !== 'object') {
    return false;
  }

  const effective = effectiveInvoiceStatus(invoice, now);
  if (effective !== 'PENDING') {
    return false;
  }

  const hash = invoice.paymentTxHash;
  if (hash && typeof hash === 'string' && hash.trim().length > 0) {
    return false;
  }

  return true;
}

module.exports = {
  INVOICE_STATUSES,
  allowedTransitions,
  canTransition,
  isTerminalStatus,
  canCancelInvoice,
  canPayInvoice,
  expiryTimestamp,
  hasInvoiceExpired,
  effectiveInvoiceStatus,
  applyExpiryStatus,
  applyExpiryLifecycle,
  isActionableInvoice,
};
