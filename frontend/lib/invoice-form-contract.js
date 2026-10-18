const {
  validateInvoiceForm,
  firstInvalidField,
} = require('./invoice-form-validation');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates the full invoice creation input and builds a sanitized payload.
 *
 * @param {{
 *   amount: string | number;
 *   assetCode?: string;
 *   assetIssuer?: string;
 *   expiresInDays?: number | string;
 *   sellerName?: string;
 *   sellerEmail?: string;
 *   customerName?: string;
 *   customerEmail?: string;
 *   description?: string;
 * }} values
 * @param {string | null | undefined} userWallet
 * @returns {
 *   | {
 *       ok: true;
 *       payload: {
 *         amount: number;
 *         assetCode: string;
 *         assetIssuer?: string;
 *         expiresInDays: number;
 *         sellerPublicKey: string;
 *         sellerName?: string;
 *         sellerEmail?: string;
 *         description?: string;
 *         customerName?: string;
 *         customerEmail?: string;
 *       };
 *     }
 *   | {
 *       ok: false;
 *       walletError?: string;
 *       errors: Record<string, string>;
 *       firstInvalid: string | null;
 *       code: string;
 *     }
 * }
 */
function validateCreateInvoiceInput(values, userWallet) {
  const wallet = typeof userWallet === 'string' ? userWallet.trim() : '';
  if (!wallet) {
    return {
      ok: false,
      walletError: 'Connect your wallet first',
      errors: {},
      firstInvalid: null,
      code: 'WALLET_REQUIRED',
    };
  }

  const rawAmount = String(values?.amount ?? '').trim();
  const rawSellerEmail = String(values?.sellerEmail ?? '').trim();
  const rawCustomerEmail = String(values?.customerEmail ?? '').trim();

  const errors = validateInvoiceForm({
    amount: rawAmount,
    sellerEmail: rawSellerEmail,
    customerEmail: rawCustomerEmail,
  });

  const days = Number(values?.expiresInDays ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    errors.expiresInDays = 'Payment window must be between 1 and 30 days.';
  }

  const description = String(values?.description ?? '').trim();
  if (description.length > 500) {
    errors.description = 'Description cannot exceed 500 characters.';
  }

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      firstInvalid: firstInvalidField(errors),
      code: 'VALIDATION_FAILED',
    };
  }

  const parsedAmount = parseFloat(rawAmount);
  const assetCode = (values?.assetCode ? String(values.assetCode).trim().toUpperCase() : 'XLM') || 'XLM';

  const sellerName = String(values?.sellerName ?? '').trim();
  const customerName = String(values?.customerName ?? '').trim();

  return {
    ok: true,
    payload: {
      amount: parsedAmount,
      assetCode,
      assetIssuer: values?.assetIssuer || undefined,
      expiresInDays: days,
      sellerPublicKey: wallet,
      sellerName: sellerName || undefined,
      sellerEmail: rawSellerEmail || undefined,
      description: description || undefined,
      customerName: customerName || undefined,
      customerEmail: rawCustomerEmail || undefined,
    },
  };
}

module.exports = {
  validateCreateInvoiceInput,
};
