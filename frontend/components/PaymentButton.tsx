'use client';

import { useEffect, useRef, useState } from 'react';
import {
  sendPayment,
  checkWalletConnection,
  requestWalletAccess,
  getFreighterNetwork,
  isWrongNetwork,
  NETWORK_DISPLAY_NAME,
  EXPECTED_WALLET_NETWORK,
} from '@/lib/stellar';
import { toast } from 'sonner';
import { Wallet, Loader2 } from 'lucide-react';
import { invoiceApi } from '@/lib/api';
import { showFreighterInstallPrompt } from '@/components/FreighterInstallPrompt';
import { describeVerifyError } from '@/lib/payment-page-state';
import {
  WALLET_ERRORS,
  validatePaymentRequest,
  classifyPaymentError,
} from '@/lib/payment-button-contract';

interface PaymentButtonProps {
  destination: string;
  amount: string;
  memo: string;
  assetCode?: string;
  assetIssuer?: string;
  invoiceId?: string;
  payerName?: string;
  payerEmail?: string;
  invoiceStatus?: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  /** Fired when the payer commits to paying, before the wallet is opened. */
  onStart?: () => void;
  onSuccess?: (txHash: string) => void;
  /** Fired when the attempt ends without a confirmed payment. */
  onError?: (message: string) => void;
}

const PAY_TOAST_ID = 'payment-flow';

export default function PaymentButton({
  destination,
  amount,
  memo,
  assetCode = 'XLM',
  assetIssuer,
  invoiceId,
  payerName,
  payerEmail,
  invoiceStatus = 'PENDING',
  onStart,
  onSuccess,
  onError,
}: PaymentButtonProps) {
  const [loading, setLoading] = useState(false);
  const {
    publicKey,
    connected,
    network,
    freighterAvailable,
    accountSwitchEpoch,
    pendingAccountSwitch,
  } =
    useWalletStore();
  const paymentEpochRef = useRef(accountSwitchEpoch);
  const paymentAccountRef = useRef(publicKey);

  useEffect(() => {
    if (
      loading &&
      (accountSwitchEpoch !== paymentEpochRef.current ||
        shouldInvalidateUnsignedPayment(paymentAccountRef.current, publicKey, loading))
    ) {
      setLoading(false);
      // Freighter may still have its signing dialog open. Keep the attempt's
      // original epoch so its eventual pre-broadcast check rejects the stale
      // transaction even if the user confirms the newly active account first.
      return;
    }
    if (!loading) paymentEpochRef.current = accountSwitchEpoch;
  }, [accountSwitchEpoch, loading, publicKey]);
  const gate = walletGate(
    { freighterAvailable, connected, publicKey, network },
    EXPECTED_WALLET_NETWORK
  );

  const handlePayment = async () => {
    if (loading) return;

    const validation = validatePaymentRequest({
      destination,
      amount,
      memo,
      assetCode,
      invoiceStatus,
      payerName,
      payerEmail,
    });
    if (!validation.ok) {
      toast.error(validation.error);
      onError?.(validation.error);
      return;
    }

    paymentEpochRef.current = accountSwitchEpoch;
    paymentAccountRef.current = publicKey;
    const attemptEpoch = accountSwitchEpoch;
    setLoading(true);
    onStart?.();

    try {
      let freighterInstalled = false;
      try {
        freighterInstalled = await checkWalletConnection();
      } catch {
        freighterInstalled = false;
      }
      if (!freighterInstalled) {
        showFreighterInstallPrompt();
        toast.info('Non-Freighter wallet? Use the QR code or manual payment details below.', {
          duration: 8000,
        });
        onError?.(WALLET_ERRORS.NOT_INSTALLED);
        return;
      }

      let allowed = false;
      try {
        allowed = await requestWalletAccess();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        toast.error(WALLET_ERRORS.ACCESS_DENIED);
        onError?.(WALLET_ERRORS.ACCESS_DENIED);
        return;
      }

      const netDetails = await getFreighterNetwork();
      const wrong = isWrongNetwork(netDetails?.networkPassphrase || netDetails?.network);
      if (wrong) {
        showFreighterWrongNetworkPrompt(NETWORK_DISPLAY_NAME);
        const wrongMsg = `Wallet is connected to the wrong network. Please switch to ${NETWORK_DISPLAY_NAME} in Freighter.`;
        toast.error(wrongMsg);
        onError?.(wrongMsg);
        return;
      }

      toast.loading('Confirm in wallet...', { id: PAY_TOAST_ID });
      if (useWalletStore.getState().accountSwitchEpoch !== paymentEpochRef.current) {
        throw new Error('Freighter account changed during payment');
      }
      const txHash = await sendPayment(
        destination,
        amount,
        memo,
        assetCode,
        assetIssuer,
        (sourceAccount) => {
          const current = useWalletStore.getState();
          return (
            current.publicKey === sourceAccount &&
            current.accountSwitchEpoch === attemptEpoch
          );
        }
      );

      if (invoiceId) {
        toast.loading('Verifying payment...', { id: PAY_TOAST_ID });
        try {
          await invoiceApi.verify(invoiceId, txHash, validation.payer);
          toast.success('Payment verified', {
            id: PAY_TOAST_ID,
            description: `TX: ${txHash.slice(0, 8)}...${txHash.slice(-8)}`,
          });
        } catch (error) {
          // The payment is on the ledger even though verification did not
          // complete, so this is a warning and the flow still reports success.
          console.error('Verification failed:', error);
          // Surface the shared rejection message rather than a generic warning.
          toast.warning('Payment sent but verification failed', {
            id: PAY_TOAST_ID,
            description: describeVerifyError(
              error,
              'Refresh the page or wait for status to update'
            ),
          });
        }
      } else {
        toast.success('Payment successful', {
          id: PAY_TOAST_ID,
          description: `TX: ${txHash.slice(0, 8)}...${txHash.slice(-8)}`,
        });
      }

      onSuccess?.(txHash);
    } catch (error: any) {
      const { title, description, duration } = classifyPaymentError(error, assetCode);
      toast.error(title, {
        id: PAY_TOAST_ID,
        description,
        duration,
      });
      onError?.(title);
    } finally {
      setLoading(false);
    }
  };

  return (
    /*
     * The accessible name spells out the amount and asset (issue #289). "Pay
     * with Freighter" on its own does not say what is about to leave the
     * payer's wallet, and the amount lives in a separate panel rendered with
     * `bg-clip-text`, so a screen-reader user confirming a payment had no way
     * to hear the figure from the control itself.
     *
     * `aria-busy` reports the in-flight attempt; the label change to
     * "Processing..." covers the visual side.
     */
    <button
      type="button"
      onClick={handlePayment}
      // While a payment is in flight the button stays focusable (aria-disabled, guarded in
      // handlePayment); `disabled` makes some browsers (Chromium) move focus to <body>.
      disabled={!destination || !amount || invoiceStatus !== 'PENDING'}
      aria-disabled={loading}
      aria-busy={loading}
      data-payment-state={loading ? 'processing' : gate.status}
      aria-label={
        loading
          ? `Processing payment of ${amount} ${assetCode}`
          : gate.ready
            ? `Pay ${amount} ${assetCode} with Freighter`
            : gate.message
      }
      className="btn btn-primary w-full flex items-center justify-center gap-2 text-lg py-4"
    >
      {loading ? (
        <>
          <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
          Processing...
        </>
      ) : (
        <>
          <Wallet className="w-6 h-6" aria-hidden="true" />
          Pay with Freighter
        </>
      )}
    </button>
  );
}
