/**
 * Accessibility coverage for keyboard, focus and async status states on the
 * pay page (issue #310). The announcement contract is exercised through the
 * real pay-state reducer; component wiring is pinned against the sources, as
 * the other component contract tests in this folder do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  INITIAL_PAY_ANNOUNCEMENT,
  PAY_FOCUS_IDS,
  PAY_STATUS_REGION_IDS,
  nextPayAnnouncement,
} = require('../lib/pay-status-a11y');
const { initialPaymentState, paymentReducer } = require('../lib/payment-page-state');
const { WALLET_ERRORS, executePaymentContract } = require('../lib/payment-button-contract');

const FUTURE = '2999-01-01T00:00:00.000Z';
const PENDING = { id: 'inv-1', status: 'PENDING', expiresAt: FUTURE };
const PAID = { ...PENDING, status: 'PAID', paymentTxHash: 'a'.repeat(64) };
const EXPIRED = { ...PENDING, status: 'EXPIRED' };

/** Feeds pay-state events through the reducer and the announcer, like PayStatusRegion does. */
function run(events, invoice = PENDING) {
  let state = initialPaymentState(null);
  let announcement = nextPayAnnouncement(INITIAL_PAY_ANNOUNCEMENT, state);
  const history = [];
  for (const event of [{ type: 'INVOICE_LOADED', invoice }, ...events]) {
    state = paymentReducer(state, event);
    announcement = nextPayAnnouncement(announcement, state);
    history.push(announcement);
  }
  return history;
}

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the first loaded invoice is a silent baseline, whatever its status', () => {
  for (const invoice of [PENDING, PAID, EXPIRED]) {
    const [loaded] = run([], invoice);
    assert.equal(loaded.polite, '');
    assert.equal(loaded.assertive, '');
    assert.equal(loaded.focusId, null);
    assert.equal(loaded.seen, true);
  }
});

test('normal path: waiting, verifying and settled states are announced politely', () => {
  const [, paying, verifying, paid] = run([
    { type: 'PAY_STARTED' },
    { type: 'PAY_SENT', txHash: 'a'.repeat(64) },
    { type: 'POLL_RESULT', invoice: PAID },
  ]);
  assert.equal(paying.polite, 'Waiting for you to confirm the payment in Freighter.');
  assert.equal(verifying.polite, 'Verifying the transaction on the Stellar network.');
  assert.equal(paid.polite, 'Payment verified. Your payment proof is ready.');
  for (const step of [paying, verifying, paid]) assert.equal(step.assertive, '');
});

test('focus moves to the payment proof only when an in-flight payment settles', () => {
  const settled = run([{ type: 'VERIFY_STARTED' }, { type: 'VERIFY_SUCCEEDED', invoice: PAID }]).at(-1);
  assert.equal(settled.focusId, PAY_FOCUS_IDS.proof);

  const observed = run([{ type: 'POLL_RESULT', invoice: PAID }]).at(-1);
  assert.equal(observed.polite, 'Payment verified. Your payment proof is ready.');
  assert.equal(observed.focusId, null, 'focus stays put when the payer was not acting');
});

test('failure path: errors go to the assertive region and clear the polite one', () => {
  const [, verifying, failed] = run([{ type: 'VERIFY_STARTED' }, { type: 'VERIFY_FAILED', error: 'Memo mismatch' }]);
  assert.equal(verifying.polite, 'Verifying the transaction on the Stellar network.');
  assert.equal(failed.polite, '');
  assert.equal(failed.assertive, 'Memo mismatch.');
  assert.equal(failed.focusId, null, 'the verify panel returns focus to its own input');
});

test('retry path: a repeated identical failure is re-announced with its attempt number', () => {
  const history = run([
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Transaction not found on Stellar' },
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Transaction not found on Stellar' },
    { type: 'VERIFY_FAILED', error: 'Transaction not found on Stellar' },
    { type: 'VERIFY_FAILED', error: 'Amount mismatch' },
  ]);
  const failures = history.filter((a) => a.status === 'error').map((a) => a.assertive);
  assert.deepEqual(failures, [
    'Transaction not found on Stellar.',
    'Transaction not found on Stellar. Attempt 2.',
    'Transaction not found on Stellar. Attempt 3.',
    'Amount mismatch.',
  ]);
  for (let i = 1; i < failures.length; i++) assert.notEqual(failures[i], failures[i - 1]);
  assert.equal(history[3].status, 'verifying');
  assert.equal(history[3].assertive, '', 'the retry clears the previous failure');
});

test('retry path: settling resets the failure count', () => {
  const history = run([
    { type: 'VERIFY_FAILED', error: 'Memo mismatch' },
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_SUCCEEDED', invoice: PAID },
  ]);
  const paid = history.at(-1);
  assert.equal(paid.failures, 0);
  assert.equal(paid.lastError, null);
});

test('authorization path: a denied wallet is announced with a way forward', async () => {
  const result = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => false,
      sendPayment: async () => assert.fail('must not send without wallet authorization'),
    },
    { destination: 'G' + 'A'.repeat(55), amount: '1', memo: 'QT-1' }
  );
  assert.equal(result.error, WALLET_ERRORS.ACCESS_DENIED);

  const denied = run([{ type: 'PAY_STARTED' }, { type: 'PAY_FAILED', error: result.error }]).at(-1);
  assert.equal(
    denied.assertive,
    'Freighter access was denied. Approve Quittance in Freighter and try again, or pay with the QR code.'
  );

  const missing = run([{ type: 'PAY_STARTED' }, { type: 'PAY_FAILED', error: WALLET_ERRORS.NOT_INSTALLED }]).at(-1);
  assert.match(missing.assertive, /^Freighter is not installed\. Install Freighter, or pay with the QR code/);
});

test('an invoice that expires mid-session is announced', () => {
  const expired = run([{ type: 'POLL_RESULT', invoice: EXPIRED }]).at(-1);
  assert.equal(expired.polite, 'This invoice has expired and can no longer be paid.');
});

test('the reducer is pure and tolerates malformed input', () => {
  const prev = Object.freeze({ ...INITIAL_PAY_ANNOUNCEMENT, seen: true });
  const state = { status: 'error', error: 'Memo mismatch', invoice: PENDING };
  assert.deepEqual(nextPayAnnouncement(prev, state), nextPayAnnouncement(prev, state));
  assert.equal(nextPayAnnouncement(undefined, null).seen, false);
  assert.equal(nextPayAnnouncement(prev, { status: 'SOMETHING_NEW' }).status, 'idle');
  assert.equal(nextPayAnnouncement(prev, { status: 'error' }).assertive, 'Payment could not be completed.');
});

test('status regions are persistent live regions without aria-busy', () => {
  const region = source('components/PayStatusRegion.tsx');
  assert.match(region, /id=\{PAY_STATUS_REGION_IDS\.polite\} role="status" aria-live="polite"/);
  assert.match(region, /id=\{PAY_STATUS_REGION_IDS\.assertive\} role="alert" className/, 'no aria-live on role="alert" (double speaking on iOS VoiceOver)');
  assert.match(region, /if \(announced\.current === state\) return;/, 'StrictMode re-run must not re-announce');
  assert.doesNotMatch(region, /&&\s*\(?\s*<div[^>]*role=/, 'regions must not mount conditionally');
  assert.doesNotMatch(region, /aria-busy/);
  assert.notEqual(PAY_STATUS_REGION_IDS.polite, PAY_STATUS_REGION_IDS.assertive);
  assert.match(source('app/pay/[id]/page.tsx'), /<PayStatusRegion state=\{page\.paymentState\} \/>/);
});

test('keyboard: Enter submits verification and the busy button keeps focus', () => {
  const panel = source('components/PayVerifyPanel.tsx');
  assert.match(panel, /<form onSubmit=\{handleSubmit\}/);
  assert.match(panel, /type="submit" aria-disabled=\{verifying\} aria-busy=\{verifying\}/);
  assert.doesNotMatch(panel, /\sdisabled=\{verifying\}/);
  assert.match(panel, /if \(verifying\) return;/);

  const button = source('components/PaymentButton.tsx');
  assert.match(button, /aria-disabled=\{loading\}/);
  assert.match(button, /disabled=\{!destination \|\| !amount \|\| invoiceStatus !== 'PENDING'\}/);
  assert.match(button, /if \(loading\) return;/);
});

test('focus and errors: the hash field is invalid, described, and refocused on failure', () => {
  const panel = source('components/PayVerifyPanel.tsx');
  assert.match(panel, /id=\{PAY_FOCUS_IDS\.verifyInput\}/);
  assert.match(panel, /aria-invalid=\{Boolean\(error\)\}/);
  assert.match(panel, /aria-describedby=\{error \? `tx-hash-hint \$\{PAY_FOCUS_IDS\.verifyError\}` : 'tx-hash-hint'\}/);
  assert.match(panel, /if \(!\(await onVerify\(\)\)\) inputRef\.current\?\.focus\(\);/);

  const proof = source('components/PayProofPanel.tsx');
  assert.match(proof, /id=\{PAY_FOCUS_IDS\.proof\} tabIndex=\{-1\}/);
});

test('decorative spinners are hidden from assistive technology', () => {
  for (const file of ['components/PayVerifyPanel.tsx', 'components/PaymentButton.tsx', 'components/PayMonitorPanel.tsx']) {
    for (const icon of source(file).match(/<Loader2[^>]*\/>/g) ?? []) {
      assert.match(icon, /aria-hidden="true"/, `${file}: ${icon}`);
    }
  }
});
