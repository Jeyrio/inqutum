/**
 * Canonical Horizon payment verification (issue #224).
 *
 * Every verify path — MVP `/api/invoices/:id/verify`, the Postgres invoice
 * controller, and `stellar.service` — routes through this module so the four
 * checks (memo, destination, amount, asset) and the network guard stay
 * identical, and so every rejection carries the same code and message.
 *
 * The module is pure: callers fetch the transaction and operations from
 * Horizon and hand them in. See README.md "Payment verification contract".
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  assetsMatch,
  formatAssetIdentity,
  resolveInvoiceAsset,
  resolvePaymentAsset,
} from '../utils/asset-helpers';
import { sanitizePlainText } from '../security/content-safety';
import { amountsMatch as stroopAmountsMatch } from '../utils/verify-amount-tolerance';
import { isFeatureEnabled } from '../config/feature-flags';

export const VERIFICATION_CONTRACT_VERSION = '1.0.0';

import {
  messageForCode,
  VERIFICATION_CODES,
  VERIFICATION_MESSAGES,
} from '../../../shared/verification';
import type { VerificationCode } from '../../../shared/verification';
export type { VerificationCode, VerificationFailureBody } from '../../../shared/verification';
export {
  VERIFICATION_CHECKS,
  CHECK_REJECTION_CODES,
  VERIFICATION_MESSAGES,
  VERIFICATION_CODES,
  messageForCode,
} from '../../../shared/verification';

export interface VerificationFailure {
  ok: false;
  code: VerificationCode;
  error: string;
}

export interface VerificationSuccess<T> {
  ok: true;
  value: T;
}

export type VerificationResult<T> = VerificationSuccess<T> | VerificationFailure;

/** Amount precision used by Stellar (7 decimal places). */
export const STROOP_PRECISION = 7;
const MAX_PAYER_FIELD_LENGTH = 255;
// Conservative allow-list: no markup, quotes, `?`/`&`/`%` (mailto/query injection) or whitespace.
const PAYER_EMAIL_PATTERN = /^[A-Za-z0-9._+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;

export function failure(code: VerificationCode): VerificationFailure {
  return { ok: false, code, error: VERIFICATION_MESSAGES[code] };
}

/** A Stellar transaction hash is 64 hexadecimal characters. */
export function isValidTxHash(txHash: unknown): boolean {
  return typeof txHash === 'string' && TX_HASH_PATTERN.test(txHash.trim());
}

/** Reject missing or malformed hashes before spending a Horizon round trip. */
export function checkTxHash(txHash: unknown): VerificationResult<string> {
  if (typeof txHash !== 'string' || txHash.trim().length === 0) {
    return failure('MISSING_TX_HASH');
  }

  const normalized = txHash.trim();
  if (!isValidTxHash(normalized)) {
    return failure('INVALID_TX_HASH');
  }

  return { ok: true, value: normalized };
}

export interface PayerInfo {
  payerName?: string;
  payerEmail?: string;
}

/** Validate and normalize the optional payer fields sent with a verify request. */
export function checkPayerInfo(input: PayerInfo | Record<string, any>): VerificationResult<PayerInfo> {
  const { payerName, payerEmail } = input ?? {};

  if (payerName !== undefined && typeof payerName !== 'string') {
    return failure('INVALID_PAYER_NAME');
  }
  if (payerEmail !== undefined && typeof payerEmail !== 'string') {
    return failure('INVALID_PAYER_EMAIL');
  }

  const normalizedPayerName = (payerName !== undefined && sanitizePlainText(payerName)) || undefined;
  const normalizedPayerEmail = payerEmail?.trim() || undefined;

  if (normalizedPayerEmail && !PAYER_EMAIL_PATTERN.test(normalizedPayerEmail)) {
    return failure('INVALID_PAYER_EMAIL');
  }
  if (
    (normalizedPayerName?.length || 0) > MAX_PAYER_FIELD_LENGTH ||
    (normalizedPayerEmail?.length || 0) > MAX_PAYER_FIELD_LENGTH
  ) {
    return failure('PAYER_INFO_TOO_LONG');
  }

  return {
    ok: true,
    value: { payerName: normalizedPayerName, payerEmail: normalizedPayerEmail },
  };
}

/** Front-door status gate; terminal cancellation settlement is handled by storage policy. */
export function checkInvoiceIsPayable(status: string): VerificationResult<null> {
  if (status === 'PAID') {
    return failure('INVOICE_ALREADY_PAID');
  }
  if (status === 'EXPIRED') {
    return failure('INVOICE_EXPIRED');
  }
  if (status !== 'PENDING') {
    return failure('INVOICE_NOT_PENDING');
  }
  return { ok: true, value: null };
}

/** What the invoice says the payment must look like. */
export interface ExpectedPayment {
  memo: string;
  /**
   * Memo type the invoice requires. Defaults to `text` when a memo is expected and
   * to `none` when the expected memo is empty (a standalone check that requires no memo).
   */
  memoType?: MemoType;
  amount: string | number;
  destination: string;
  assetCode: string;
  assetIssuer?: string;
  /** Network the invoice must be paid on, e.g. `TESTNET`. Server-configured. */
  network?: string;
}

export interface HorizonTransactionLike {
  memo?: string | null;
  memo_type?: string | null;
  envelope_type?: string | null;
  inner_transaction?: HorizonTransactionLike | null;
}

export interface HorizonOperationLike {
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  to_muxed_id?: string | number;
}

export interface VerifiedPayment {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo: string;
  settledAt?: Date;
}

export interface VerifyPaymentInput {
  txHash: string;
  expected: ExpectedPayment;
  transaction: HorizonTransactionLike;
  operations: HorizonOperationLike[];
  /**
   * Network the caller observed the transaction on, e.g. `TESTNET`. Clients send
   * their own network so a testnet payment cannot settle a pubnet invoice.
   * Skipped when either side is unknown.
   */
  network?: string;
}

export function transactionSettlementTime(transaction: HorizonTransactionLike): Date | undefined {
  return parseSettlementTime(transaction?.created_at) ?? undefined;
}

/**
 * Invoice destinations are exact Stellar addresses. Muxed addresses retain
 * their sub-account id; a base G address never matches an M address.
 */
export function normalizeDestination(destination: unknown, muxedId?: unknown): string {
  if (typeof destination !== 'string') return '';
  const normalized = destination.trim();
  // An M address carries its own sub-account id in the string itself.
  if (normalized.startsWith('M')) {
    return normalized;
  }
  if (muxedId === undefined || muxedId === null || String(muxedId).trim() === '') {
    return normalized;
  }
  if (normalized.startsWith('G')) {
    try {
      const muxed = new StellarSdk.MuxedAccount(
        new StellarSdk.Account(normalized, '0'),
        String(muxedId),
      );
      return muxed.accountId();
    } catch {
      // Preserve a deterministic non-match for malformed fixture data.
      return `${normalized}:${String(muxedId).trim()}`;
    }
  }
  return `${normalized}:${String(muxedId).trim()}`;
}

function transactionForVerification(transaction: HorizonTransactionLike): HorizonTransactionLike {
  return transaction?.envelope_type === 'fee_bump'
    ? transaction.inner_transaction ?? transaction
    : transaction;
}

/**
 * Exact stroop match unless the `paymentAmountTolerance` flag is on, which
 * widens the window to ±1 stroop. Checked server-side on every verification.
 */
export function amountsMatch(actual: unknown, expected: string | number): boolean {
  const toleranceStroops = isFeatureEnabled('paymentAmountTolerance') ? 1 : 0;
  return stroopAmountsMatch(expected, actual, toleranceStroops);
}

/**
 * Verify a Horizon transaction against what an invoice expects.
 *
 * Policy: any plain `payment` operation that matches the invoice settles it;
 * unrelated operations are ignored. Path payments are never accepted. Fee-bump
 * envelopes use the inner transaction for memo and operations, while the hash
 * supplied by the caller (the outer transaction hash) is persisted.
 * Checks run in a fixed order: tx hash, network, payment operation, memo,
 * destination, amount, asset.
 */
export function verifyHorizonPayment(input: VerifyPaymentInput): VerificationResult<VerifiedPayment> {
  const hashCheck = checkTxHash(input.txHash);
  if (!hashCheck.ok) {
    return hashCheck;
  }

  const { expected, operations, network } = input;
  const transaction = transactionForVerification(input.transaction);

  if (expected.network && network && expected.network !== network) {
    return failure('NETWORK_MISMATCH');
  }

  const paymentOps = (operations || []).filter((operation) => operation.type === 'payment');
  if (paymentOps.length === 0) {
    return failure('NO_PAYMENT_OPERATION');
  }

  // Type AND value must agree (see utils/memo-compare.ts): a hash or id memo that
  // stringifies like the invoice memo is not a payment for this invoice.
  if (!memosMatch({ type: expected.memoType ?? (expected.memo ? 'text' : 'none'), value: expected.memo }, horizonMemo(transaction))) {
    return failure('MEMO_MISMATCH');
  }

  const destinationMatch = paymentOps.find((operation) =>
    normalizeDestination(operation.to, operation.to_muxed_id) ===
      normalizeDestination(expected.destination)
  );
  if (!destinationMatch) {
    return failure('DESTINATION_MISMATCH');
  }

  const amountMatch = paymentOps.find(
    (operation) =>
      normalizeDestination(operation.to, operation.to_muxed_id) ===
        normalizeDestination(expected.destination) &&
      amountsMatch(operation.amount, expected.amount),
  );
  if (!amountMatch) {
    return failure('AMOUNT_MISMATCH');
  }

  const invoiceAsset = resolveInvoiceAsset({
    assetCode: expected.assetCode,
    assetIssuer: expected.assetIssuer,
  });
  const assetMatch = paymentOps.find(
    (operation) =>
      normalizeDestination(operation.to, operation.to_muxed_id) ===
        normalizeDestination(expected.destination) &&
      amountsMatch(operation.amount, expected.amount) &&
      assetsMatch(
        invoiceAsset,
        resolvePaymentAsset({
          assetType: operation.asset_type,
          assetCode: operation.asset_code,
          assetIssuer: operation.asset_issuer,
        }),
      ),
  );
  if (!assetMatch) {
    return failure('ASSET_MISMATCH');
  }

  const paymentOp = assetMatch;
  const paidAsset = resolvePaymentAsset({
    assetType: paymentOp.assetType,
    assetCode: paymentOp.assetCode,
    assetIssuer: paymentOp.assetIssuer,
  });

  if (!assetsMatch(invoiceAsset, paidAsset)) {
    return failure('ASSET_MISMATCH');
  }

  const paidAssetCode = paymentOp.assetType === 'native' ? 'XLM' : paymentOp.assetCode ?? '';
  const settledAt = transactionSettlementTime(transaction);

  return {
    ok: true,
    value: {
      txHash: hashCheck.value,
      from: paymentOp.from,
      to: paymentOp.to,
      amount: paymentOp.amount,
      assetCode: paidAssetCode,
      assetIssuer: paymentOp.assetType === 'native' ? undefined : paymentOp.assetIssuer,
      memo: transaction?.memo ?? '',
      ...(settledAt ? { settledAt } : {}),
    },
  };
}

export { formatAssetIdentity, resolveInvoiceAsset, resolvePaymentAsset };

export default {
  VERIFICATION_MESSAGES,
  VERIFICATION_CODES,
  messageForCode,
  failure,
  isValidTxHash,
  checkTxHash,
  checkPayerInfo,
  checkInvoiceIsPayable,
  transactionSettlementTime,
  verifyHorizonPayment,
};
