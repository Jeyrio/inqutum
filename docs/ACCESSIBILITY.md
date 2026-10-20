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
node --test tests/a11y-core-pages.test.js           # axe over every core page and component
node --test tests/a11y-regression-flows.test.js     # dense form, retry, proof table, reduced motion
```

The last two load `.ts` modules through Node's type stripping: use Node 24 (as
CI does), or Node 22 with `NODE_OPTIONS=--experimental-strip-types`.

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

## Dense forms, tables and error recovery (issue #257)

`tests/a11y-core-pages.test.js` proves each page is axe-clean in a snapshot.
`tests/a11y-regression-flows.test.js` covers what a snapshot cannot: what
happens over time when a participant uses the keyboard, makes a mistake and
recovers. It renders the shipped components through `tests/support/a11y-harness.js`.

| Area | Behaviour pinned by the test |
|------|------------------------------|
| Invoice form, keyboard submit | Enter submits. Focus moves to the first invalid field in form order, which gets `aria-invalid="true"` and `aria-describedby` → its `.field-error`. Every `aria-describedby` id resolves. axe-clean in the error state. |
| Invoice form, announcement | `#invoice-form-error-summary` (`role="alert"`, `aria-atomic`) is mounted from the first render and only its text changes: "Invoice not created. N fields need attention: …". The same node is updated, so it is announced reliably and only once per submit. |
| Invoice form, recovery | Once the input validates, field errors clear before the request is sent, so an API failure after a corrected submit does not leave fixed fields marked invalid. |
| Busy buttons | Submit, Retry and "Load more invoices" use `aria-disabled` + `aria-busy`, not `disabled`, so a keyboard user keeps focus while the request runs. Handlers ignore presses while busy (one request, not two). |
| API-unavailable state | Retry keeps focus and reports busy. When the retry fails, the same `role="alert"` node carries the new message rather than being replaced. Decorative icons are `aria-hidden`. |
| Payment proof table | The details table has a `<caption>` ("Payment proof details", visually hidden), every row has a `th scope="row"` and one `td`, and the printed document is axe-clean, including the late-payment notice. |
| Reduced motion | `globals.css` cuts animation and transition durations to near zero and turns off smooth scrolling under `prefers-reduced-motion: reduce`. The landing page's `motion` animations use `<MotionConfig reducedMotion="user">`. Spinners are `aria-hidden` next to text that says the same thing. |

### Operational edge cases and failure modes

| Case | Behaviour |
|------|-----------|
| Submit with several invalid fields | One assertive announcement listing every message; focus goes to the first. The listener does not have to tab through the form to find out what went wrong. |
| Fix one field, leave another invalid | The summary is rebuilt from the remaining errors on the next submit; the fixed field loses `aria-invalid`. |
| Double Enter while creating | The second submit is ignored (`loading` guard), and the button never loses focus. |
| API down during create | Field errors are already clear; `ApiErrorState` appears with its own alert. The toast is still shown for sighted users. |
| Retry fails again | The alert text changes in place; focus stays on Retry. |
| Reduced motion with JS animation | `MotionConfig` skips transforms; content still fades in, so nothing stays invisible. `transitionend`/`animationend` still fire because durations are near zero, not `none`. |
| Print / PDF of the proof | The caption uses an inline `.visually-hidden` class, so it is not printed but is read by a screen reader in the print preview window. |
| Test environment | jsdom does no layout, so focus-ring visibility, reflow and real reduced-motion rendering stay in the manual pass below. |

### Rollback

Every change is presentational or additive: no API, schema, stored record or
reducer state changes. To roll back, revert the form summary region and the
`setErrors({})` line in `InvoiceForm.tsx`, the `aria-disabled` swaps in
`InvoiceForm.tsx`, `ApiErrorState.tsx` and the dashboard, the proof table
caption in `lib/export.ts`/`lib/export.js`, and the `MotionConfig` wrapper in
`app/page.tsx`, then delete `tests/a11y-regression-flows.test.js`. The
reduced-motion CSS and the other restored rules predate this issue and should
stay.

### Restored after the #328 merge

#328 re-applied a stale branch over the frontend. The core pages stopped
compiling, and earlier accessibility work was silently reverted. Because the
pages did not compile, `a11y-core-pages.test.js` could not load, so nothing
reported it. These were restored from `26edbb8` (the last commit before #328)
while keeping #328's real additions (dashboard "Load more", `PayStatusRegion`,
the `Boundary` wrappers, the payment-button account-switch guard, the form error
and print styles):

- `<main id={MAIN_CONTENT_ID} tabIndex={-1}>` skip-link targets and the page
  `h1`s on the landing, dashboard, invoice and pay pages; the layout skip link,
  `Toaster closeButton` and `WalletSessionSync`.
- The dashboard result-count live region and the labelled search field.
- Accessible names and `aria-hidden` icons on the invoice header and cards.
- `aria-disabled` + `aria-describedby` reasons on unavailable email buttons.
- The asset `<select>` id that its `<label>` points at.
- `[tabindex='-1']` focus rule, disabled-button contrast tokens and the
  reduced-motion block in `globals.css`.
- Missing imports and helpers that made components throw at render
  (`UserProfile`, `PaymentButton`, `PaymentStatus`, `PaymentReceipt`,
  `invoice-lifecycle.js`, `use-payment-page.ts`, `export.ts`).

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
7. **Dense form and recovery (screen reader on):** leave the amount empty, type
   `nope` as your email and `a@b` as the client email, press Enter. Hear
   "Invoice not created. 3 fields need attention…" once, with focus on the
   amount. Fix all three and stop the backend before resubmitting: the fields
   are no longer announced as invalid and the API error is announced. Press
   Retry from the keyboard: focus stays on it while "Retrying..." shows.
8. **Reduced motion:** enable "Reduce motion" in the OS. The landing hero no
   longer slides in, and the Retry/Create spinners do not spin.
