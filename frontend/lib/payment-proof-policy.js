/**
 * Payment-proof availability policy (issue #177).
 *
 * Hardened contract for when a payment proof may be exported:
 * - Fails closed on missing, null, or non-object invoices.
 * - Status comparison is case-insensitive to survive API casing drift.
 * - Only an explicit 'PAID' status unlocks proof export; anything else refuses.
 * - `assertPaymentProofAvailable` throws a descriptive error, never a raw TypeError.
 */

const PAID = 'PAID';
const EXPIRED = 'EXPIRED';

function normalizeStatus(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  const status = invoice.status;
  if (typeof status !== 'string') return null;
  return status.trim().toUpperCase();
}

function canExportPaymentProof(invoice) {
  return normalizeStatus(invoice) === PAID;
}

function assertPaymentProofAvailable(invoice) {
  if (canExportPaymentProof(invoice)) return;
  const status = normalizeStatus(invoice);
  throw new Error(
    status === EXPIRED
      ? 'Payment proof is unavailable because this invoice expired unpaid'
      : 'Payment proof is available only after the invoice is paid'
  );
}

module.exports = { canExportPaymentProof, assertPaymentProofAvailable };
