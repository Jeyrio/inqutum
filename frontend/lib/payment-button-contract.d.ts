export declare const WALLET_ERRORS: {
  readonly NOT_INSTALLED: 'Freighter is not installed';
  readonly ACCESS_DENIED: 'Freighter access was denied';
};

export interface PaymentValidationSuccess {
  ok: true;
  payer: {
    payerName?: string;
    payerEmail?: string;
  };
  numAmount: number;
}

export interface PaymentValidationFailure {
  ok: false;
  error: string;
  code: string;
}

export type PaymentValidationResult = PaymentValidationSuccess | PaymentValidationFailure;

export function validatePaymentRequest(params?: {
  destination?: string;
  amount?: string | number;
  memo?: string;
  assetCode?: string;
  invoiceStatus?: string;
  payerName?: string;
  payerEmail?: string;
}): PaymentValidationResult;

export function classifyPaymentError(
  error: any,
  assetCode?: string
): {
  title: string;
  description: string;
  isTrustline: boolean;
  duration?: number;
};

export interface PaymentExecutionResult {
  success: boolean;
  txHash?: string;
  verified?: boolean;
  error?: string;
  warning?: string;
}

export function executePaymentContract(
  deps: {
    checkWalletConnection: () => Promise<boolean>;
    requestWalletAccess: () => Promise<boolean>;
    sendPayment: (
      destination: string,
      amount: string,
      memo: string,
      assetCode?: string,
      assetIssuer?: string
    ) => Promise<string>;
    verifyInvoice?: (invoiceId: string, txHash: string, payer: any) => Promise<any>;
    showFreighterInstallPrompt?: () => void;
    onStart?: () => void;
    onSuccess?: (txHash: string) => void;
    onError?: (message: string) => void;
    toast?: {
      loading?: (msg: string, opts?: any) => void;
      success?: (msg: string, opts?: any) => void;
      error?: (msg: string, opts?: any) => void;
      warning?: (msg: string, opts?: any) => void;
    };
  },
  params: {
    destination: string;
    amount: string;
    memo: string;
    assetCode?: string;
    assetIssuer?: string;
    invoiceId?: string;
    payerName?: string;
    payerEmail?: string;
    invoiceStatus?: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  }
): Promise<PaymentExecutionResult>;
