/**
 * User-facing description of a failed Horizon request. Kept dependency-free
 * so node tests can load it without the Stellar SDK; `lib/stellar.ts`
 * re-exports it for the app.
 */
/** Transport-level failure codes (axios / Node) meaning Horizon was not reached. */
const NETWORK_ERROR_CODES = ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'];

/**
 * True when the request never reached Horizon: a network error code, or no
 * response and nothing else to say. An error that carries its own message
 * (e.g. "Invalid account") is not an outage.
 */
const isHorizonUnreachable = (error) =>
  NETWORK_ERROR_CODES.includes(error?.code) || (!error?.response && !error?.message);

const describeStellarNetworkError = (error) => {
  if (error?.message?.includes('Not Found') || error?.response?.status === 404) {
    return 'Account needs funding on the selected Stellar network.';
  }
  if (isHorizonUnreachable(error)) {
    return 'Stellar Horizon is temporarily unreachable. Your wallet can stay connected; retry shortly.';
  }
  return error?.message || 'Stellar network request failed.';
};

module.exports = { NETWORK_ERROR_CODES, describeStellarNetworkError, isHorizonUnreachable };
