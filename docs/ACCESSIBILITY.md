# Accessibility

The primary workflow (landing → create invoice → invoice detail → pay page →
dashboard) targets WCAG 2.1 AA for keyboard use, screen readers, visible focus
and form errors.

## Automated checks

`eslint-plugin-jsx-a11y` (recommended rules) runs as part of the frontend lint,
so CI fails on unlabelled form controls, invalid ARIA, click handlers on
non-interactive elements and similar static issues:

```bash
cd frontend
npm run lint
node --test tests/invoice-form-validation.test.js   # inline form error rules
node --test tests/pay-status-a11y.test.js           # pay-page announcements, keyboard and focus
```

Static linting cannot see focus order, contrast or live announcements, so run
the manual pass below for any change to these screens.

## Conventions

- **Landmarks:** every page renders one `<main id="main-content">` and one
  `<h1>`. The first Tab stop is the "Skip to main content" link from
  `app/layout.tsx`.
- **Labels:** every input has a `<label htmlFor>`. When there is no visible
  label, use `aria-label`. Icon buttons whose text is hidden on small screens
  use `sr-only sm:not-sr-only`, not `hidden sm:inline`, so they keep an
  accessible name.
- **Form errors:** validation lives in `lib/invoice-form-validation.js`. Invalid
  fields get `aria-invalid="true"` and `aria-describedby` pointing at a
  `.field-error` paragraph. On submit, focus moves to the first invalid field.
  Toasts are only for outcomes (created / failed), not field validation.
- **Focus:** `*:focus-visible` draws a solid `--teal` ring (≥3:1 against paper
  and white). Do not remove it with `outline: none` without a replacement.
- **Contrast:** white text sits on `--teal` (#0f766e, ~5.5:1), not on
  `cyan-500` (~2.4:1, fails AA).
- **Toggle buttons:** filter chips expose `aria-pressed`.

## Async status, keyboard and focus on the pay page

The pay flow waits on Freighter and then on Horizon, and either step can fail,
be retried, or be refused by the wallet. These rules (issue #310) satisfy
WCAG 2.1 SC 4.1.3 Status Messages and SC 2.4.3 Focus Order. They live in one
pure module, `lib/pay-status-a11y.js`, and are covered by
`tests/pay-status-a11y.test.js`.

- **Two persistent live regions** (`components/PayStatusRegion.tsx`):
  `role="status"` (polite) for waiting, verifying and settled states, and
  `role="alert"` (assertive) for failures. Both are rendered whenever the
  invoice is shown. MDN advises establishing a live region before updating it,
  because some browser and screen reader combinations do not announce a region
  inserted together with its text. Following MDN, the status region repeats
  `aria-live="polite"` for compatibility. The alert region gets no `aria-live`,
  because MDN reports that combining the two double-speaks in VoiceOver on iOS.
  Both are `sr-only`. Toasts and the inline field error remain the visual
  feedback.
- **Silent baseline:** the state of the invoice when the page loads is already
  on screen, so it is not announced. Only transitions after that are.
- **Failures and retries:** a failure clears the polite region and fills the
  assertive one. Every other state clears the assertive one. Retrying the same
  failure appends "Attempt N." so the region text changes and is announced
  again. A different failure, or a successful payment, resets the count.
- **Wallet authorization:** "Freighter access was denied" and "Freighter is not
  installed" are announced with a way forward (approve in Freighter, or pay
  with the QR code). The strings come from `WALLET_ERRORS` in
  `lib/payment-button-contract.js`, so the button and the announcement cannot
  drift apart.
- **Keyboard:** manual verification is a `<form>`, so Enter in the hash field
  submits. Busy buttons (Verify, Pay with Freighter) use `aria-disabled` plus
  `aria-busy`, not `disabled`. What happens when a focused button becomes
  disabled varies by browser. ally.js measured Chrome moving focus to `<body>`,
  while Firefox and Safari kept it. `aria-disabled` keeps the button focusable
  everywhere. The click handlers ignore activation while busy. `.btn` gives
  `[aria-disabled="true"]` the same 50% opacity as `disabled`, with a wait
  cursor.
- **Focus:** after a failed verification, focus returns to the hash field. The
  field gets `aria-invalid="true"` and `aria-describedby` pointing at the hint
  and the inline `.field-error`. When an in-flight payment settles, the payment
  controls unmount, so focus moves to the payment proof section (`tabIndex=-1`).
  Focus never moves when a payment is noticed by polling while the payer was
  not acting.
- **No `aria-busy` on the live regions:** assistive technology may hold back
  updates to a busy region, which would silence "Verifying…".
- **Decorative spinners** (`Loader2`) carry `aria-hidden="true"`. The button text
  already says "Verifying..." or "Processing...".

### Operational edge cases

| Case | Behaviour |
|------|-----------|
| Payment confirmed by polling while idle | Polite "Payment verified…" announcement. Focus stays where the payer left it. |
| Invoice expires mid-session | Polite "This invoice has expired…" announcement. The controls unmount with the page view. |
| Verify succeeds but the reloaded invoice has no `paymentTxHash` yet | The proof section is not rendered, so the focus call does nothing. The next poll or reload renders it. |
| Backend unreachable during verify | The verify failure is announced. `ApiErrorState` keeps its own `role="alert"` and Retry button. |
| Same invalid hash submitted twice | Each submission dispatches `VERIFY_FAILED`, and the second one is announced as "Attempt 2." |
| React StrictMode (`reactStrictMode: true` in `next.config.js`) | In development React re-runs mount effects and double-invokes reducers. `PayStatusRegion` feeds each pay-state object once (ref guard), so the on-load status is not announced. `nextPayAnnouncement` is pure, so a double-invoked reducer returns the same value. |

### Rollback

The change is additive. Live regions, focus targets and the
`WALLET_ERRORS` constants change no API, reducer state or toast. To roll back,
remove `<PayStatusRegion>` from `app/pay/[id]/page.tsx` and revert
`PayVerifyPanel`, `PaymentButton` and `PayProofPanel`. `lib/pay-status-a11y.js`
has no other consumers.

## Manual verification

Run `npm run dev` in `frontend/` (the MVP backend or mock API is fine) and check:

1. **Keyboard only:** from page load, Tab once. The skip link appears, and Enter
   moves focus into the main content. Tab through the create form, submit, open
   the invoice, and reach the pay page actions without a mouse. Every focused
   element shows the teal ring.
2. **Form errors:** submit the create form with an empty amount and
   `client@` as the client email. Focus lands on the amount field. The screen
   reader announces the field as invalid, followed by its error text. Fix the
   amount and resubmit. Focus moves to the client email field.
3. **Screen reader (VoiceOver: Ctrl+Opt+U, NVDA: Insert+F7):** the headings list
   starts with one h1 per page. The landmarks list includes `main`. Dashboard
   filter buttons are announced as "toggle button, pressed" / "not pressed".
4. **Zoom:** at 200% browser zoom, no content is clipped and nothing needs
   horizontal scrolling on the create form.
5. **Contrast spot check:** use DevTools' contrast picker on any new colour
   pairing. Text needs ≥4.5:1. Focus rings and borders need ≥3:1.
6. **Pay page async states (screen reader on):** open a pending invoice's pay
   page. Type a short hash in "Transaction hash" and press Enter. The error is
   announced, the field is announced as invalid with its error text, and focus
   stays in the field. Press Enter again and hear "Attempt 2." Activate "Pay
   with Freighter" and reject the request in Freighter. Hear the denial and the
   QR-code fallback, and confirm focus is still on the button. Approve a real
   testnet payment. Hear "Verifying…" and then "Payment verified…", with focus
   on the payment proof.
