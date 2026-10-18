/**
 * Invoice creation form validation contract (issues #259, #149).
 * Hardens boundary contracts for amount limits, decimal precision, email sanity,
 * and error ordering.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field order matches the form, so the first key is the first invalid field. */
const FIELD_ORDER = ['amount', 'sellerEmail', 'customerEmail'];

/** Maximum acceptable invoice amount (1 trillion units). */
const MAX_INVOICE_AMOUNT = 1e12;

/** Maximum allowable decimals (Stellar base token precision). */
const MAX_DECIMAL_PLACES = 7;

/** Maximum RFC 5321 email address length. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Validates invoice form input fields with hardened edge-case checks.
 *
 * @param {{ amount?: string | number, sellerEmail?: string, customerEmail?: string }} values
 * @returns {Partial<Record<'amount' | 'sellerEmail' | 'customerEmail', string>>}
 */
const validateInvoiceForm = (values) => {
  const errors = {};

  if (!values || typeof values !== 'object') {
    errors.amount = 'Enter an amount greater than 0.';
    return errors;
  }

  // 1. Amount validation
  const rawAmount =
    typeof values.amount === 'string'
      ? values.amount.trim()
      : values.amount !== null && values.amount !== undefined
      ? String(values.amount).trim()
      : '';

  if (!rawAmount) {
    errors.amount = 'Enter an amount greater than 0.';
  } else {
    // Check format (strictly digits and optional single decimal point)
    if (!/^\d+(\.\d+)?$/.test(rawAmount)) {
      errors.amount = 'Enter an amount greater than 0.';
    } else {
      const parsed = parseFloat(rawAmount);
      if (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
        errors.amount = 'Enter an amount greater than 0.';
      } else if (rawAmount.includes('.') && rawAmount.split('.')[1].length > MAX_DECIMAL_PLACES) {
        errors.amount = `Amount cannot have more than ${MAX_DECIMAL_PLACES} decimal places.`;
      } else if (parsed > MAX_INVOICE_AMOUNT) {
        errors.amount = 'Amount exceeds maximum allowed limit.';
      }
    }
  }

  // 2. Seller email validation (optional field, but if provided must be valid)
  const sellerEmail =
    typeof values.sellerEmail === 'string'
      ? values.sellerEmail.trim()
      : values.sellerEmail
      ? String(values.sellerEmail).trim()
      : '';

  if (sellerEmail) {
    if (sellerEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(sellerEmail)) {
      errors.sellerEmail = 'Enter a valid email address, like you@example.com.';
    }
  }

  // 3. Customer email validation (optional field, but if provided must be valid)
  const customerEmail =
    typeof values.customerEmail === 'string'
      ? values.customerEmail.trim()
      : values.customerEmail
      ? String(values.customerEmail).trim()
      : '';

  if (customerEmail) {
    if (customerEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(customerEmail)) {
      errors.customerEmail = 'Enter a valid client email address, like client@example.com.';
    }
  }

  return errors;
};

/**
 * Returns the first invalid field identifier according to standard form focus order.
 *
 * @param {Record<string, string> | null | undefined} errors
 * @returns {string | null}
 */
const firstInvalidField = (errors) => {
  if (!errors || typeof errors !== 'object') {
    return null;
  }
  return FIELD_ORDER.find((field) => Boolean(errors[field])) || null;
};

module.exports = {
  validateInvoiceForm,
  firstInvalidField,
  MAX_INVOICE_AMOUNT,
  MAX_DECIMAL_PLACES,
};
