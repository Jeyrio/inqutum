import { z } from 'zod';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  DEFAULT_INVOICE_EXPIRY_DAYS,
  MAX_INVOICE_EXPIRY_DAYS,
  MIN_INVOICE_EXPIRY_DAYS,
} from '../domain/invoice-expiry';
import { NATIVE_ASSET_CODE, requiresIssuer } from './asset-helpers';
import { SUPPORTED_STELLAR_NETWORKS } from '../config/stellar';
import { DEFAULT_POLICY } from '../domain/policy';
import { sanitizePlainText } from '../security/content-safety';

// Schemas used identically by both servers. Zod validates the create+verify
// payloads before they ever reach the InvoiceStorage layer, so the memory
// and Postgres backends receive the same seller name/email, assetCode +
// assetIssuer, customer name/email, expiresInDays and metadata fields.
// Rejections are serialized through the shared failure envelope
// (`{ success:false, error }`) from types/api.ts, matching the verify path's
// `code` + `error` shape so every client reads one consistent contract.
// Stellar public key validation
export const stellarPublicKeySchema = z.string()
  .length(56)
  .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format');

/**
 * Invoice creation schema.
 *
 * A credit asset must carry its issuer (issue #246). Without one the invoice
 * names an asset nobody pinned, which verification refuses to settle — so
 * accepting it at creation would only produce an invoice that can never be
 * paid. `XLM` is the exception: it is the native asset and has no issuer.
 */
/**
 * Free-text fields are length-checked as submitted, then stripped of markup,
 * control and bidi characters. A value that is empty after stripping is dropped.
 */
const plainText = (max: number, multiline = false) =>
  z
    .string()
    .max(max)
    .transform((value) => sanitizePlainText(value, { multiline }) || undefined);

export const createInvoiceSchema = z
  .object({
    amount: z.number().positive().max(DEFAULT_POLICY.invoice.maxAmount),
    assetCode: z.string().default('XLM').optional(),
    assetIssuer: stellarPublicKeySchema.optional(),
    description: plainText(500, true).optional(),
    customerName: plainText(255).optional(),
    customerEmail: z.string().email().optional(),
    sellerName: plainText(255).optional(),
    sellerEmail: z.string().email().optional(),
    network: z.enum(SUPPORTED_STELLAR_NETWORKS).optional(),
    expiresInDays: z.number()
      .int()
      .min(MIN_INVOICE_EXPIRY_DAYS)
      .max(MAX_INVOICE_EXPIRY_DAYS)
      .default(DEFAULT_INVOICE_EXPIRY_DAYS),
    sellerPublicKey: stellarPublicKeySchema,
    // Import key. Also accepted on the create route so a caller can claim a key
    // for a single invoice; updates stay limited to descriptive fields, so a
    // claimed key can never rewrite amounts or ownership.
    externalId: externalIdSchema.optional(),
  })
  .refine(
    (invoice) => !requiresIssuer(invoice.assetCode) || Boolean(invoice.assetIssuer),
    {
      path: ['assetIssuer'],
      message:
        'assetIssuer is required for issued assets; only XLM may omit it. An asset is identified by its code and issuer together.',
    },
  )
  .refine(
    (invoice) => invoice.assetCode !== NATIVE_ASSET_CODE || !invoice.assetIssuer,
    {
      path: ['assetIssuer'],
      message: 'XLM is the native asset and must not carry an issuer.',
    },
  );

// Payment verification schema
export const paymentSchema = z.object({
  invoiceId: z.string().uuid(),
  txHash: z.string().length(64),
  payerPublicKey: stellarPublicKeySchema,
  amount: z.number().positive(),
});

// Invoice cancellation schema
export const cancelInvoiceSchema = z.object({
  sellerPublicKey: stellarPublicKeySchema.optional(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;

/**
 * One row of a bulk import file (issue #53).
 *
 * Deliberately the same schema as `createInvoiceSchema`, exported separately so
 * the import pipeline and its tests can name the row type without implying a
 * different validation contract. An imported row can therefore never name an
 * asset, amount or seller the create endpoint would have rejected.
 */
export const importRowSchema = createInvoiceSchema;
export type ImportRow = z.infer<typeof importRowSchema>;

export default {
  createInvoiceSchema,
  paymentSchema,
  cancelInvoiceSchema,
  stellarPublicKeySchema,
};
