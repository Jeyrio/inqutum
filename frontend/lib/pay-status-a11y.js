/**
 * Pay-page status announcements and focus targets (issue #310).
 *
 * The pay flow is asynchronous: the payer waits on Freighter, then on Horizon
 * verification, and either outcome can fail or be retried. Toasts alone are
 * transient and do not move focus, so this module turns each pay-state
 * transition from `payment-page-state.js` into what assistive technology should
 * hear (WCAG 2.1 SC 4.1.3 Status Messages) and where focus should land.
 *
 * Two live regions stay mounted for the life of the page — a live region that
 * is inserted together with its text is not reliably announced:
 *
 *   polite     role="status" (implicit aria-live="polite", aria-atomic="true";
 *              aria-live="polite" is repeated for compatibility, as MDN advises)
 *              waiting, verifying, settled outcomes
 *   assertive  role="alert"  (implicit aria-live="assertive", aria-atomic="true")
 *              failures, including wallet authorization failures
 *
 * Rules:
 *  - The first loaded invoice is a silent baseline: its state is already on screen.
 *  - Every failure clears the polite region and fills the assertive one; every
 *    other state clears the assertive one. A retry therefore always changes the
 *    region text, and a repeated identical failure adds "Attempt N." so it is
 *    re-announced instead of being swallowed as an unchanged region.
 *  - Focus moves only when the control holding it disappears: settling to `paid`
 *    unmounts the payment controls, so focus goes to the payment proof.
 *  - `aria-busy` is deliberately not set on the regions: assistive technology may
 *    hold back a busy region's updates, which would silence "Verifying…".
 *
 * `nextPayAnnouncement` is a pure reducer (O(1) time and space) and must be fed
 * once per pay-state object (PayStatusRegion guards against StrictMode re-runs).
 */

const { PAY_STATES } = require('./payment-page-state');
const { WALLET_ERRORS } = require('./payment-button-contract');

const PAY_STATUS_REGION_IDS = Object.freeze({
  polite: 'pay-status-polite',
  assertive: 'pay-status-assertive',
});

const PAY_FOCUS_IDS = Object.freeze({
  verifyInput: 'tx-hash',
  verifyError: 'tx-hash-error',
  proof: 'payment-proof',
});

const POLITE_COPY = Object.freeze({
  [PAY_STATES.IDLE]: '',
  [PAY_STATES.PAYING]: 'Waiting for you to confirm the payment in Freighter.',
  [PAY_STATES.VERIFYING]: 'Verifying the transaction on the Stellar network.',
  [PAY_STATES.PAID]: 'Payment verified. Your payment proof is ready.',
  [PAY_STATES.EXPIRED]: 'This invoice has expired and can no longer be paid.',
  [PAY_STATES.ERROR]: '',
});

/** Next steps for failures the payer can resolve outside the page. */
const ERROR_GUIDANCE = Object.freeze({
  [WALLET_ERRORS.ACCESS_DENIED]: 'Approve Quittance in Freighter and try again, or pay with the QR code.',
  [WALLET_ERRORS.NOT_INSTALLED]: 'Install Freighter, or pay with the QR code or the manual payment details.',
});

const INITIAL_PAY_ANNOUNCEMENT = Object.freeze({
  seen: false,
  status: PAY_STATES.IDLE,
  polite: '',
  assertive: '',
  failures: 0,
  lastError: null,
  focusId: null,
});

const ACTIVE_STATES = [PAY_STATES.PAYING, PAY_STATES.VERIFYING];

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

function nextPayAnnouncement(prev, state) {
  const previous = prev ?? INITIAL_PAY_ANNOUNCEMENT;
  const status = Object.prototype.hasOwnProperty.call(POLITE_COPY, state?.status) ? state.status : PAY_STATES.IDLE;

  if (!previous.seen) {
    return { ...INITIAL_PAY_ANNOUNCEMENT, status, seen: Boolean(state?.invoice) };
  }

  if (status === PAY_STATES.ERROR) {
    const error = String(state.error || 'Payment could not be completed');
    const failures = error === previous.lastError ? previous.failures + 1 : 1;
    const assertive = [sentence(error), ERROR_GUIDANCE[error], failures > 1 ? `Attempt ${failures}.` : '']
      .filter(Boolean)
      .join(' ');
    return { seen: true, status, polite: '', assertive, failures, lastError: error, focusId: null };
  }

  const settled = status === PAY_STATES.PAID;
  return {
    seen: true,
    status,
    polite: POLITE_COPY[status],
    assertive: '',
    failures: settled ? 0 : previous.failures,
    lastError: settled ? null : previous.lastError,
    focusId: settled && ACTIVE_STATES.includes(previous.status) ? PAY_FOCUS_IDS.proof : null,
  };
}

module.exports = {
  PAY_STATUS_REGION_IDS,
  PAY_FOCUS_IDS,
  INITIAL_PAY_ANNOUNCEMENT,
  nextPayAnnouncement,
};
