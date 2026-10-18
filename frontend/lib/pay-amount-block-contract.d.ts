export interface PayAmountViewModel {
  isValid: boolean;
  expired: boolean;
  status: string;
  isPaid: boolean;
  headerLabel: 'Invoice Amount' | 'Amount to Pay' | 'Payment Details';
  formattedAmount: string;
  assetCode: string;
  description: string | null;
  sellerName: string | null;
  sellerEmail: string | null;
  hasSellerInfo: boolean;
  paymentTxHash: string | null;
  expiryRemaining: string | null;
  formattedPaidAt: string | null;
}

export function resolvePayAmountViewModel(
  invoice: any,
  now?: Date | string | number
): PayAmountViewModel;
