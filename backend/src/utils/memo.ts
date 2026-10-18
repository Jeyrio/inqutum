import { nanoid } from 'nanoid';
import { hasInvoiceMemoPrefix } from './memo-prefix-check';

export { hasInvoiceMemoPrefix } from './memo-prefix-check';

export const STELLAR_MEMO_MAX_BYTES = 28;

/**
 * Generate a unique memo for invoice
 * Format: INV-TIMESTAMP-RANDOM
 */
export const generateInvoiceMemo = (): string => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, '0');
  return `INV-${timestamp}-${random}`;
};

/**
 * Validate memo format
 */
export const isValidMemo = (memo: string): boolean => {
  return (
    typeof memo === 'string' &&
    Buffer.byteLength(memo, 'utf8') <= STELLAR_MEMO_MAX_BYTES &&
    /^INV-[A-Z0-9]+-[A-Z0-9]+$/.test(memo)
  );
};

/**
 * Generate short payment reference
 */
export const generateShortReference = (): string => {
  return nanoid(10).toUpperCase();
};

export default {
  generateInvoiceMemo,
  isValidMemo,
  generateShortReference,
};

