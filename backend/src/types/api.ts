import { Response } from 'express';
import type { VerificationCode } from '../services/payment-verification';
import {
  ErrorCategory,
  DOMAIN_ERROR_TAXONOMY,
  classifyError,
} from '../errors/error-taxonomy';
import { redactErrorMessage } from '../security/redaction';

// Shared response envelope used by both the MVP and the Postgres server.
// Both servers send the same success/failure shape so clients stay
// storage-agnostic: a frontend pointed at server-mvp.ts behaves exactly the
// same against server.ts (only persistence duration changes).
// sendSuccess / sendFailure wrap this envelope; they are shared helpers, so
// HTTP status codes and envelope keys are also pinned across backends.
export interface ApiPagination {
  limit: number;
  offset: number;
  total: number;
  /** Keyset cursor for the next page; null when this is the last page. */
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
  code?: string;
  warning?: string;
  pagination?: ApiPagination;
  correlationId?: string;
  /** Schema version of the data payload, when applicable. */
  apiVersion?: string;
}

/**
 * Stable machine-readable codes for failures that are not payment-verification
 * rejections. Clients branch on these, never on the human-readable `error`.
 */
export type ApiErrorCode =
  | 'INVALID_TRANSITION'
  | 'INVOICE_NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_WALLET_PROOF'
  | 'SESSION_UNAVAILABLE'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'IDEMPOTENCY_KEY_EXPIRED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'IDEMPOTENCY_STORE_UNAVAILABLE'
  | 'MISSING_RECIPIENT_EMAIL'
  | 'INVOICE_NOT_PAID'
  | 'EMAIL_RATE_LIMIT_EXCEEDED'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'INVALID_EMAIL_RECIPIENT'
  | 'CRLF_INJECTION_DETECTED'
  | 'DISPOSABLE_EMAIL_REJECTED'
  | 'PENDING_INVOICE_LIMIT_EXCEEDED'
  | 'EXCEEDED_INVOICE_EMAIL_LIMIT'
  // Bulk import (issue #53)
  | 'INVALID_IMPORT_REQUEST'
  | 'INVALID_IMPORT_PAYLOAD'
  | 'INVALID_EMAIL'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_QUOTA_REQUEST';

export interface ApiFailure {
  success: false;
  error: string;
  code?: VerificationCode | string;
  category?: ErrorCategory;
  retryable?: boolean;
  recoveryAction?: string;
  correlationId?: string;
  timestamp?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(
  data: T,
  extra?: { message?: string; pagination?: ApiPagination; correlationId?: string; apiVersion?: string }
): ApiSuccess<T> {
  const body: ApiSuccess<T> = { success: true, data };

  if (extra?.message) {
    body.message = extra.message;
  }
  if (extra?.code) {
    body.code = extra.code;
  }
  if (extra?.warning) {
    body.warning = extra.warning;
  }
  if (extra?.pagination) {
    body.pagination = extra.pagination;
  }
  if (extra?.correlationId) {
    body.correlationId = extra.correlationId;
  }
  if (extra?.apiVersion) {
    body.apiVersion = extra.apiVersion;
  }

  return body;
}

export function apiFailure(
  error: string,
  extra?: {
    code?: string;
    category?: ErrorCategory;
    retryable?: boolean;
    recoveryAction?: string;
    correlationId?: string;
  }
): ApiFailure {
  const code = extra?.code;
  const taxonomy = code ? DOMAIN_ERROR_TAXONOMY[code] : undefined;

  return {
    success: false,
    error: redactErrorMessage(error),
    ...(code ? { code: code as VerificationCode } : {}),
    category: extra?.category || taxonomy?.category,
    retryable: extra?.retryable !== undefined ? extra.retryable : taxonomy?.retryable,
    recoveryAction: extra?.recoveryAction || taxonomy?.recoveryAction,
    ...(extra?.correlationId ? { correlationId: extra.correlationId } : {}),
    timestamp: new Date().toISOString(),
  };
}

export function sendSuccess<T>(
  res: Response,
  status: number,
  data: T,
  extra?: { message?: string; pagination?: ApiPagination; correlationId?: string; apiVersion?: string }
): void {
  const corrId = extra?.correlationId || (res.req as any)?.correlationId;
  res.status(status).json(apiSuccess(data, { ...extra, correlationId: corrId }));
}

export function sendFailure(
  res: Response,
  status: number,
  error: string | any,
  extra?: {
    code?: string;
    category?: ErrorCategory;
    retryable?: boolean;
    recoveryAction?: string;
    correlationId?: string;
  }
): void {
  const corrId = extra?.correlationId || (res.req as any)?.correlationId;

  if (typeof error === 'object' && error !== null) {
    const classified = classifyError(error);
    const message =
      classified.customMessage ||
      (typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : classified.userSafeMessage);

    res.status(status || classified.httpStatus).json(
      apiFailure(message, {
        code: classified.code,
        category: classified.category,
        retryable: classified.retryable,
        recoveryAction: classified.recoveryAction,
        correlationId: corrId,
      })
    );
    return;
  }

  res.status(status).json(apiFailure(error, { ...extra, correlationId: corrId }));
}

export function sendVerificationFailure(
  res: Response,
  status: number,
  code: VerificationCode,
  error: string,
  correlationId?: string
): void {
  const corrId = correlationId || (res.req as any)?.correlationId;
  const taxonomy = DOMAIN_ERROR_TAXONOMY[code];

  res.status(status).json({
    success: false,
    code,
    error: redactErrorMessage(error),
    ...(taxonomy
      ? {
          category: taxonomy.category,
          retryable: taxonomy.retryable,
          recoveryAction: taxonomy.recoveryAction,
        }
      : {}),
    ...(corrId ? { correlationId: corrId } : {}),
    timestamp: new Date().toISOString(),
  });
}

/**
 * The envelope a verification rejection is returned in.
 *
 * `success` is the literal `false` rather than `boolean` so this discriminates
 * from a success envelope at the type level instead of only at runtime.
 */
export interface VerificationFailureBody {
  success: false;
  code: VerificationCode;
  error: string;
}

/** Build a verification failure envelope with a stable code and its message. */
export function verificationFailureBody(
  code: VerificationCode,
  error: string
): VerificationFailureBody {
  return { success: false, code, error };
}

export default {
  apiSuccess,
  apiFailure,
  sendSuccess,
  sendFailure,
  sendVerificationFailure,
};
