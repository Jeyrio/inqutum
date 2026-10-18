/**
 * Business rule policy (issue #79).
 *
 * Limits that used to live as literals in handlers and schemas (invoice
 * amount cap, expiry window, accepted assets) are read from one typed policy
 * and evaluated here. Every rule returns a user-safe code and message, so callers
 * can pass a denial straight to the client.
 */
import {
  DEFAULT_INVOICE_EXPIRY_DAYS,
  MAX_INVOICE_EXPIRY_DAYS,
  MIN_INVOICE_EXPIRY_DAYS,
} from './invoice-expiry';

export interface BusinessPolicy {
  invoice: {
    /** Smallest amount an invoice may ask for. Must be greater than zero. */
    minAmount: number;
    /** Largest amount an invoice may ask for (inclusive). */
    maxAmount: number;
    minExpiryDays: number;
    maxExpiryDays: number;
    defaultExpiryDays: number;
    /** Asset codes a seller may invoice in. Empty means any asset. */
    allowedAssets: string[];
  };
}

export type PolicyCode =
  | 'AMOUNT_TOO_LOW'
  | 'AMOUNT_TOO_HIGH'
  | 'EXPIRY_OUT_OF_RANGE'
  | 'ASSET_NOT_ALLOWED';

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: PolicyCode; message: string; details?: Record<string, unknown> };

export const DEFAULT_POLICY: BusinessPolicy = Object.freeze({
  invoice: Object.freeze({
    minAmount: 0.0000001,
    maxAmount: 1_000_000_000,
    minExpiryDays: MIN_INVOICE_EXPIRY_DAYS,
    maxExpiryDays: MAX_INVOICE_EXPIRY_DAYS,
    defaultExpiryDays: DEFAULT_INVOICE_EXPIRY_DAYS,
    allowedAssets: Object.freeze([]) as unknown as string[],
  }),
}) as BusinessPolicy;

const ALLOW: PolicyDecision = { allowed: true };

const deny = (code: PolicyCode, message: string, details?: Record<string, unknown>): PolicyDecision => ({
  allowed: false,
  code,
  message,
  ...(details ? { details } : {}),
});

export interface InvoiceRequest {
  amount: number;
  assetCode?: string;
  expiresInDays?: number;
}

/** First failing rule wins, in the order a user would fix them. */
export function evaluateInvoiceRequest(
  request: InvoiceRequest,
  policy: BusinessPolicy = DEFAULT_POLICY
): PolicyDecision {
  const { minAmount, maxAmount, minExpiryDays, maxExpiryDays, allowedAssets } = policy.invoice;

  if (!Number.isFinite(request.amount) || request.amount < minAmount) {
    return deny('AMOUNT_TOO_LOW', `Amount must be at least ${minAmount}.`, { min: minAmount });
  }
  if (request.amount > maxAmount) {
    return deny('AMOUNT_TOO_HIGH', `Amount must be at most ${maxAmount}.`, { max: maxAmount });
  }

  const asset = (request.assetCode ?? 'XLM').toUpperCase();
  if (allowedAssets.length > 0 && !allowedAssets.includes(asset)) {
    return deny('ASSET_NOT_ALLOWED', `${asset} is not accepted. Use one of: ${allowedAssets.join(', ')}.`, {
      allowed: [...allowedAssets],
    });
  }

  if (request.expiresInDays !== undefined) {
    const days = request.expiresInDays;
    if (!Number.isInteger(days) || days < minExpiryDays || days > maxExpiryDays) {
      return deny(
        'EXPIRY_OUT_OF_RANGE',
        `Expiry must be a whole number of days between ${minExpiryDays} and ${maxExpiryDays}.`,
        { min: minExpiryDays, max: maxExpiryDays }
      );
    }
  }

  return ALLOW;
}

const positiveNumber = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Policy with environment overrides applied. Unset or invalid values fall back
 * to the default instead of throwing, so a typo cannot loosen a limit to NaN.
 */
export function loadPolicy(env: NodeJS.ProcessEnv = process.env): BusinessPolicy {
  const d = DEFAULT_POLICY;
  const assets = (env.POLICY_ALLOWED_ASSETS ?? '')
    .split(',')
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean);

  return {
    invoice: {
      ...d.invoice,
      minAmount: positiveNumber(env.POLICY_MIN_INVOICE_AMOUNT) ?? d.invoice.minAmount,
      maxAmount: positiveNumber(env.POLICY_MAX_INVOICE_AMOUNT) ?? d.invoice.maxAmount,
      allowedAssets: assets.length > 0 ? assets : [],
    },
  };
}
