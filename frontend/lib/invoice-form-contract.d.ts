import type { InvoiceFormField } from './invoice-form-validation';

export interface CreateInvoicePayload {
  amount: number;
  assetCode: string;
  assetIssuer?: string;
  expiresInDays: number;
  sellerPublicKey: string;
  sellerName?: string;
  sellerEmail?: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
}

export interface CreateInvoiceValidationSuccess {
  ok: true;
  payload: CreateInvoicePayload;
}

export interface CreateInvoiceValidationFailure {
  ok: false;
  walletError?: string;
  errors: Record<string, string>;
  firstInvalid: InvoiceFormField | string | null;
  code: string;
}

export type CreateInvoiceValidationResult =
  | CreateInvoiceValidationSuccess
  | CreateInvoiceValidationFailure;

export function validateCreateInvoiceInput(
  values: {
    amount: string | number;
    assetCode?: string;
    assetIssuer?: string;
    expiresInDays?: number | string;
    sellerName?: string;
    sellerEmail?: string;
    customerName?: string;
    customerEmail?: string;
    description?: string;
  },
  userWallet: string | null | undefined
): CreateInvoiceValidationResult;
