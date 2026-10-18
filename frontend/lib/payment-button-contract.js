const { normalizePayerDetails, describeVerifyError } = require('./payment-page-state');

/** Wallet authorization outcomes; shared with the pay-page announcements. */
const WALLET_ERRORS = Object.freeze({
  NOT_INSTALLED: 'Freighter is not installed',
  ACCESS_DENIED: 'Freighter access was denied',
});

/**
 * Validates parameters for PaymentButton before initiating wallet interaction.
 *
 * @param {{
 *   destination?: string;
 *   amount?: string | number;
 *   memo?: string;
 *   assetCode?: string;
 *   invoiceStatus?: string;
 *   payerName?: string;
 *   payerEmail?: string;
 * }} params
 * @returns {{ ok: true; payer: { payerName?: string; payerEmail?: string }; numAmount: number } | { ok: false; error: string; code: string }}
 */
function validatePaymentRequest(params) {
  const invoiceStatus = params?.invoiceStatus ?? 'PENDING';
  if (invoiceStatus !== 'PENDING') {
    const error =
      invoiceStatus === 'EXPIRED'
        ? 'This invoice has expired and cannot be paid'
        : 'This invoice is not available for payment';
    const code = invoiceStatus === 'EXPIRED' ? 'INVOICE_EXPIRED' : 'INVOICE_NOT_PENDING';
    return { ok: false, error, code };
  }

  const destination = typeof params?.destination === 'string' ? params.destination.trim() : '';
  if (!destination) {
    return { ok: false, error: 'Destination address is required', code: 'INVALID_DESTINATION' };
  }

  const rawAmount = params?.amount;
  if (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '') {
    return { ok: false, error: 'Payment amount is required', code: 'INVALID_AMOUNT' };
  }
  const numAmount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return { ok: false, error: 'Payment amount must be a positive number', code: 'INVALID_AMOUNT' };
  }

  const payer = normalizePayerDetails({
    payerName: params?.payerName,
    payerEmail: params?.payerEmail,
  });
  if (!payer.ok) {
    return { ok: false, error: payer.error, code: 'INVALID_PAYER_EMAIL' };
  }

  return { ok: true, payer: payer.value, numAmount };
}

/**
 * Classifies an error from wallet or Stellar payment.
 *
 * @param {any} error
 * @param {string} [assetCode='XLM']
 * @returns {{ title: string; description: string; isTrustline: boolean; duration?: number }}
 */
function classifyPaymentError(error, assetCode = 'XLM') {
  const rawMsg = error?.message || '';
  const isTrustline =
    assetCode !== 'XLM' && String(rawMsg).toLowerCase().includes('trustline');
  const title = isTrustline ? `${assetCode} trustline required` : 'Payment failed';
  const description = rawMsg || 'Try again';
  return {
    title,
    description,
    isTrustline,
    duration: isTrustline ? 10000 : undefined,
  };
}

/**
 * Executes the payment flow with dependency injection for regression testing.
 *
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.checkWalletConnection
 * @param {() => Promise<boolean>} deps.requestWalletAccess
 * @param {(dest: string, amt: string, memo: string, assetCode?: string, issuer?: string) => Promise<string>} deps.sendPayment
 * @param {(invoiceId: string, txHash: string, payer: any) => Promise<any>} [deps.verifyInvoice]
 * @param {() => void} [deps.showFreighterInstallPrompt]
 * @param {() => void} [deps.onStart]
 * @param {(txHash: string) => void} [deps.onSuccess]
 * @param {(message: string) => void} [deps.onError]
 * @param {{
 *   loading?: (msg: string, opts?: any) => void;
 *   success?: (msg: string, opts?: any) => void;
 *   error?: (msg: string, opts?: any) => void;
 *   warning?: (msg: string, opts?: any) => void;
 * }} [deps.toast]
 * @param {object} params
 * @param {string} params.destination
 * @param {string} params.amount
 * @param {string} params.memo
 * @param {string} [params.assetCode]
 * @param {string} [params.assetIssuer]
 * @param {string} [params.invoiceId]
 * @param {string} [params.payerName]
 * @param {string} [params.payerEmail]
 * @param {'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED'} [params.invoiceStatus]
 * @returns {Promise<{ success: boolean; txHash?: string; verified?: boolean; error?: string; warning?: string }>}
 */
async function executePaymentContract(deps, params) {
  const toastId = 'payment-flow';
  const validation = validatePaymentRequest(params);
  if (!validation.ok) {
    deps.toast?.error?.(validation.error);
    deps.onError?.(validation.error);
    return { success: false, error: validation.error };
  }

  deps.onStart?.();

  let freighterInstalled = false;
  try {
    freighterInstalled = await deps.checkWalletConnection();
  } catch {
    freighterInstalled = false;
  }

  if (!freighterInstalled) {
    deps.showFreighterInstallPrompt?.();
    const msg = WALLET_ERRORS.NOT_INSTALLED;
    deps.onError?.(msg);
    return { success: false, error: msg };
  }

  let allowed = false;
  try {
    allowed = await deps.requestWalletAccess();
  } catch {
    allowed = false;
  }

  if (!allowed) {
    const msg = WALLET_ERRORS.ACCESS_DENIED;
    deps.toast?.error?.(msg);
    deps.onError?.(msg);
    return { success: false, error: msg };
  }

  deps.toast?.loading?.('Confirm in wallet...', { id: toastId });

  let txHash;
  try {
    txHash = await deps.sendPayment(
      params.destination,
      params.amount,
      params.memo,
      params.assetCode,
      params.assetIssuer
    );
  } catch (err) {
    const classified = classifyPaymentError(err, params.assetCode);
    deps.toast?.error?.(classified.title, {
      id: toastId,
      description: classified.description,
      duration: classified.duration,
    });
    deps.onError?.(classified.title);
    return { success: false, error: classified.title };
  }

  if (params.invoiceId && deps.verifyInvoice) {
    deps.toast?.loading?.('Verifying payment...', { id: toastId });
    try {
      await deps.verifyInvoice(params.invoiceId, txHash, validation.payer);
      deps.toast?.success?.('Payment verified', {
        id: toastId,
        description: `TX: ${txHash.slice(0, 8)}...${txHash.slice(-8)}`,
      });
      deps.onSuccess?.(txHash);
      return { success: true, txHash, verified: true };
    } catch (verifyErr) {
      const desc = describeVerifyError(verifyErr, 'Refresh the page or wait for status to update');
      deps.toast?.warning?.('Payment sent but verification failed', {
        id: toastId,
        description: desc,
      });
      deps.onSuccess?.(txHash);
      return { success: true, txHash, verified: false, warning: desc };
    }
  }

  deps.toast?.success?.('Payment successful', {
    id: toastId,
    description: `TX: ${txHash.slice(0, 8)}...${txHash.slice(-8)}`,
  });
  deps.onSuccess?.(txHash);
  return { success: true, txHash, verified: true };
}

module.exports = {
  WALLET_ERRORS,
  validatePaymentRequest,
  classifyPaymentError,
  executePaymentContract,
};
