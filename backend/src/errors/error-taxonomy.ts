/**
 * Structured Domain Error Taxonomy for Quittance.
 *
 * Defines standardized error categories, domain error codes, HTTP status mappings,
 * retryability metadata, user-safe error messages, and actionable recovery guidance.
 */

import { VerificationCode, VERIFICATION_MESSAGES } from '../services/payment-verification';
import { redactErrorMessage, sanitizeObject } from '../security/redaction';

export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTHORIZATION'
  | 'SETTLEMENT'
  | 'LIFECYCLE'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'INTERNAL';

export interface DomainErrorDefinition {
  code: string;
  category: ErrorCategory;
  httpStatus: number;
  retryable: boolean;
  userSafeMessage: string;
  recoveryAction: string;
}

/**
 * Canonical taxonomy mapping for all verification codes and domain errors.
 */
export const DOMAIN_ERROR_TAXONOMY: Record<string, DomainErrorDefinition> = {
  // --- Settlement / Verification Codes ---
  MISSING_TX_HASH: {
    code: 'MISSING_TX_HASH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.MISSING_TX_HASH,
    recoveryAction: 'Provide a 64-character transaction hash from your Stellar wallet after submitting payment.',
  },
  INVALID_TX_HASH: {
    code: 'INVALID_TX_HASH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVALID_TX_HASH,
    recoveryAction: 'Verify that the transaction hash contains exactly 64 hexadecimal characters.',
  },
  INVALID_PAYER_NAME: {
    code: 'INVALID_PAYER_NAME',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVALID_PAYER_NAME,
    recoveryAction: 'Enter a valid text string for the payer name or leave it empty.',
  },
  INVALID_PAYER_EMAIL: {
    code: 'INVALID_PAYER_EMAIL',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVALID_PAYER_EMAIL,
    recoveryAction: 'Enter a valid email address (e.g. name@domain.com) or leave it empty.',
  },
  PAYER_INFO_TOO_LONG: {
    code: 'PAYER_INFO_TOO_LONG',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.PAYER_INFO_TOO_LONG,
    recoveryAction: 'Shorten payer name and email to under 255 characters.',
  },
  INVOICE_ALREADY_PAID: {
    code: 'INVOICE_ALREADY_PAID',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVOICE_ALREADY_PAID,
    recoveryAction: 'This invoice is already settled. You can download or email your quittance proof.',
  },
  INVOICE_EXPIRED: {
    code: 'INVOICE_EXPIRED',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVOICE_EXPIRED,
    recoveryAction: 'The payment window has elapsed. Contact the seller to issue a new invoice.',
  },
  INVOICE_NOT_PENDING: {
    code: 'INVOICE_NOT_PENDING',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVOICE_NOT_PENDING,
    recoveryAction: 'Only pending invoices can accept payment. Check invoice status on dashboard.',
  },
  VERIFY_RATE_LIMIT_EXCEEDED: {
    code: 'VERIFY_RATE_LIMIT_EXCEEDED',
    category: 'RATE_LIMIT',
    httpStatus: 429,
    retryable: true,
    userSafeMessage: VERIFICATION_MESSAGES.VERIFY_RATE_LIMIT_EXCEEDED,
    recoveryAction: 'Too many verification attempts for this invoice. Wait a minute, then retry.',
  },
  TRANSACTION_CLOSE_TIME_UNAVAILABLE: {
    code: 'TRANSACTION_CLOSE_TIME_UNAVAILABLE',
    category: 'NETWORK',
    httpStatus: 503,
    retryable: true,
    userSafeMessage: VERIFICATION_MESSAGES.TRANSACTION_CLOSE_TIME_UNAVAILABLE,
    recoveryAction: 'The ledger close time is not available yet. Retry verification shortly.',
  },
  TX_HASH_ALREADY_USED: {
    code: 'TX_HASH_ALREADY_USED',
    category: 'SETTLEMENT',
    httpStatus: 409,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.TX_HASH_ALREADY_USED,
    recoveryAction: 'This transaction already paid another invoice. Send a new payment for this invoice.',
  },
  TRANSACTION_NOT_FOUND: {
    code: 'TRANSACTION_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: true,
    userSafeMessage: VERIFICATION_MESSAGES.TRANSACTION_NOT_FOUND,
    recoveryAction: 'Stellar ledger close takes ~5 seconds. Please wait a moment and retry verification.',
  },
  NO_PAYMENT_OPERATION: {
    code: 'NO_PAYMENT_OPERATION',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.NO_PAYMENT_OPERATION,
    recoveryAction: 'Ensure your transaction contains a direct payment operation to the seller address.',
  },
  MEMO_MISMATCH: {
    code: 'MEMO_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.MEMO_MISMATCH,
    recoveryAction: 'Include the exact invoice memo in your transaction memo field before sending.',
  },
  DESTINATION_MISMATCH: {
    code: 'DESTINATION_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.DESTINATION_MISMATCH,
    recoveryAction: 'Send funds directly to the seller public key specified in the invoice.',
  },
  AMOUNT_MISMATCH: {
    code: 'AMOUNT_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.AMOUNT_MISMATCH,
    recoveryAction: 'Send the exact invoice amount (matched at Stellar 7-decimal stroop precision).',
  },
  ASSET_MISMATCH: {
    code: 'ASSET_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.ASSET_MISMATCH,
    recoveryAction: 'Pay with the designated asset. For non-native tokens, verify both asset code and issuer.',
  },
  NETWORK_MISMATCH: {
    code: 'NETWORK_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.NETWORK_MISMATCH,
    recoveryAction: 'Switch your Freighter wallet to the matching Stellar network (Testnet or Public).',
  },

  // --- General Domain Errors ---
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Invalid input provided',
    recoveryAction: 'Review the input parameters, ensuring valid numbers, addresses, and formats.',
  },
  SELLER_REQUIRED: {
    code: 'SELLER_REQUIRED',
    category: 'AUTHORIZATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'sellerPublicKey query parameter is required',
    recoveryAction: 'Connect your Freighter wallet to supply the seller public key.',
  },
  INVALID_STATUS: {
    code: 'INVALID_STATUS',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'status filter is not a known invoice status',
    recoveryAction: 'Filter by PENDING, PAID, EXPIRED or CANCELLED, or omit status to list every invoice.',
  },
  INVALID_CURSOR: {
    code: 'INVALID_CURSOR',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'cursor is not valid; restart from the first page',
    recoveryAction: 'Drop the cursor and request the first page again.',
  },
  UNAUTHORIZED_SELLER: {
    code: 'UNAUTHORIZED_SELLER',
    category: 'AUTHORIZATION',
    httpStatus: 403,
    retryable: false,
    userSafeMessage: 'You are not authorized to modify this invoice',
    recoveryAction: 'Connect the Freighter wallet that created this invoice.',
  },
  INVOICE_NOT_FOUND: {
    code: 'INVOICE_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'Invoice not found',
    recoveryAction: 'Check the invoice ID in the URL and ensure it has not been deleted.',
  },
  INVOICE_CANNOT_CANCEL: {
    code: 'INVOICE_CANNOT_CANCEL',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Only pending invoices can be cancelled',
    recoveryAction: 'Invoices that are already paid or expired cannot be cancelled.',
  },
  CORS_ORIGIN_DENIED: {
    code: 'CORS_ORIGIN_DENIED',
    category: 'AUTHORIZATION',
    httpStatus: 403,
    retryable: false,
    userSafeMessage: 'Origin is not allowed by Quittance CORS policy',
    recoveryAction: 'Configure the frontend origin in FRONTEND_URL environment variables.',
  },
  HORIZON_UNAVAILABLE: {
    code: 'HORIZON_UNAVAILABLE',
    category: 'NETWORK',
    httpStatus: 503,
    retryable: true,
    userSafeMessage: 'Stellar Horizon is temporarily unreachable',
    recoveryAction: 'Stellar network is experiencing a transient delay. Please retry in a few seconds.',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    category: 'RATE_LIMIT',
    httpStatus: 429,
    retryable: true,
    userSafeMessage: 'Too many requests. Please slow down.',
    recoveryAction: 'Wait a few seconds before retrying the operation.',
  },
  CONFLICT: {
    code: 'CONFLICT',
    category: 'LIFECYCLE',
    httpStatus: 409,
    retryable: true,
    userSafeMessage: 'Invoice was modified by another session. Please refresh and try again.',
    recoveryAction: 'Refresh the invoice to get the latest version, then retry the operation.',
  },
  SERVICE_UNAVAILABLE: {
    code: 'SERVICE_UNAVAILABLE',
    category: 'NETWORK',
    httpStatus: 503,
    retryable: true,
    userSafeMessage: 'The service is temporarily unavailable.',
    recoveryAction: 'Please retry shortly.',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    category: 'INTERNAL',
    httpStatus: 500,
    retryable: true,
    userSafeMessage: 'An internal server error occurred',
    recoveryAction: 'Please retry your request. If the problem persists, contact support with the correlation ID.',
  },
};

/**
 * Typed Application Domain Error class.
 */
export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly details?: any;

  constructor(
    codeOrDef: string | DomainErrorDefinition,
    customMessage?: string,
    details?: any
  ) {
    const def =
      typeof codeOrDef === 'string'
        ? DOMAIN_ERROR_TAXONOMY[codeOrDef] || DOMAIN_ERROR_TAXONOMY.INTERNAL_ERROR
        : codeOrDef;

    super(customMessage || def.userSafeMessage);
    this.name = 'AppError';
    this.code = def.code;
    this.category = def.category;
    this.httpStatus = def.httpStatus;
    this.retryable = def.retryable;
    this.recoveryAction = def.recoveryAction;
    this.details = details;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

/**
 * Classify any error into a structured DomainErrorDefinition.
 */
export function classifyError(error: any): DomainErrorDefinition & { customMessage?: string } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      category: error.category,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      userSafeMessage: error.message,
      recoveryAction: error.recoveryAction,
    };
  }

  const code = error?.code as string | undefined;
  if (code && DOMAIN_ERROR_TAXONOMY[code]) {
    return DOMAIN_ERROR_TAXONOMY[code];
  }

  // Zod validation errors
  if (error?.name === 'ZodError' || Array.isArray(error?.issues)) {
    const firstIssue = error?.issues?.[0];
    const field = firstIssue?.path?.join('.') || 'input';
    const message = firstIssue?.message || 'Invalid input';
    return {
      ...DOMAIN_ERROR_TAXONOMY.VALIDATION_FAILED,
      customMessage: `${field}: ${message}`,
    };
  }

  // Common network / connection errors
  if (
    error?.code === 'ECONNREFUSED' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ECONNRESET' ||
    error?.message?.includes('Horizon') ||
    error?.message?.includes('network')
  ) {
    return DOMAIN_ERROR_TAXONOMY.HORIZON_UNAVAILABLE;
  }

  // Specific message heuristics
  if (typeof error?.message === 'string') {
    const msg = error.message;
    if (msg.includes('not found') || msg.includes('Invoice not found')) {
      return DOMAIN_ERROR_TAXONOMY.INVOICE_NOT_FOUND;
    }
    if (msg.includes('sellerPublicKey') || msg.includes('Seller public key')) {
      return DOMAIN_ERROR_TAXONOMY.SELLER_REQUIRED;
    }
    if (msg.includes('already processed') || msg.includes('cannot be cancelled')) {
      return DOMAIN_ERROR_TAXONOMY.INVOICE_CANNOT_CANCEL;
    }
    if (msg.includes('expired')) {
      return DOMAIN_ERROR_TAXONOMY.INVOICE_EXPIRED;
    }
  }

  return DOMAIN_ERROR_TAXONOMY.INTERNAL_ERROR;
}

/**
 * Build a user-safe API error response payload.
 */
export function buildUserSafeErrorResponse(
  error: any,
  correlationId?: string
): {
  success: false;
  error: string;
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  recoveryAction: string;
  correlationId?: string;
  timestamp: string;
  details?: any;
} {
  const classified = classifyError(error);

  let userMessage = classified.userSafeMessage;
  if (classified.customMessage) {
    userMessage = classified.customMessage;
  } else if (classified.code !== 'INTERNAL_ERROR' && typeof error?.message === 'string' && error.message.length > 0 && !error.message.includes('\n')) {
    userMessage = error.message;
  }

  userMessage = redactErrorMessage(userMessage);

  return {
    success: false,
    error: userMessage,
    code: classified.code,
    category: classified.category,
    retryable: classified.retryable,
    recoveryAction: classified.recoveryAction,
    ...(correlationId ? { correlationId } : {}),
    ...(error?.details ? { details: sanitizeObject(error.details) } : {}),
    timestamp: new Date().toISOString(),
  };
}

/** HTTP status for a code; unknown codes are internal errors (500). */
export function getErrorStatusCode(code: string): number {
  return DOMAIN_ERROR_TAXONOMY[code]?.httpStatus ?? 500;
}

/** Whether retrying the same request may succeed. Unknown codes are not. */
export function isRecoverableError(code: string): boolean {
  return DOMAIN_ERROR_TAXONOMY[code]?.retryable ?? false;
}

/** A code and message as the flat shape callers log and return. */
export function categorizeError(
  code: string,
  message: string
): { code: string; message: string; category: ErrorCategory; statusCode: number; recoverable: boolean } {
  const definition = DOMAIN_ERROR_TAXONOMY[code];
  return {
    code,
    message,
    category: definition?.category ?? 'INTERNAL',
    statusCode: getErrorStatusCode(code),
    recoverable: isRecoverableError(code),
  };
}
