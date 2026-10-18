import type { PayStatus, PaymentState } from './payment-page-state';

export declare const PAY_STATUS_REGION_IDS: {
  readonly polite: 'pay-status-polite';
  readonly assertive: 'pay-status-assertive';
};

export declare const PAY_FOCUS_IDS: {
  readonly verifyInput: 'tx-hash';
  readonly verifyError: 'tx-hash-error';
  readonly proof: 'payment-proof';
};

export interface PayAnnouncement {
  seen: boolean;
  status: PayStatus;
  polite: string;
  assertive: string;
  failures: number;
  lastError: string | null;
  focusId: string | null;
}

export declare const INITIAL_PAY_ANNOUNCEMENT: Readonly<PayAnnouncement>;

export function nextPayAnnouncement(
  prev: PayAnnouncement | null | undefined,
  state: Pick<PaymentState, 'status' | 'error' | 'invoice'> | null | undefined
): PayAnnouncement;
