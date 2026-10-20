/**
 * Accessibility regressions for dense forms, tables and error recovery (#257).
 *
 * `a11y-core-pages.test.js` proves every core page is axe-clean in a snapshot.
 * This file covers what a snapshot cannot: what happens over time when a
 * participant uses the keyboard, gets something wrong, and recovers.
 *
 *  - Dense form: the invoice form, submitted from the keyboard with one and
 *    with several invalid fields, then corrected and resubmitted.
 *  - Error recovery: the API-unavailable state and its Retry button, pressed
 *    from the keyboard while the retry is in flight and when it fails again.
 *  - Table: the payment proof's details table, as a screen reader meets it.
 *  - Reduced motion: the global CSS fallback and the landing animation config.
 *
 * Everything renders the shipped components through `support/a11y-harness.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBundle, installDom, getDom, render, runAxe, formatViolations } = require('./support/a11y-harness');

installDom();

const React = require('react');
const { act } = React;
const bundle = loadBundle();

const ROOT = path.resolve(__dirname, '..');
const SELLER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

function assertNoViolations(violations, label) {
  assert.equal(violations.length, 0, `${label} has axe violation(s):\n${formatViolations(violations)}`);
}

function connectWallet() {
  bundle.useWalletStore.setState({
    publicKey: SELLER,
    balance: '100.00',
    connected: true,
    network: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
    freighterAvailable: true,
  });
}

/** Types into a React-controlled input the way a browser does: native setter, then an input event. */
async function type(input, value) {
  const { window } = getDom();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/** Lets promise-driven state updates commit. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => getDom().window.setTimeout(resolve, 0));
  });
}

/** Presses Enter in a field: the implicit submission a keyboard user relies on. */
async function submitFromKeyboard(form) {
  const { window } = getDom();
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

/** Every id an element points at with aria-describedby must exist, or the description is silently lost. */
function assertDescriptionsResolve(container) {
  for (const element of container.querySelectorAll('[aria-describedby]')) {
    for (const id of element.getAttribute('aria-describedby').split(/\s+/).filter(Boolean)) {
      assert.ok(
        container.ownerDocument.getElementById(id),
        `#${element.id} is described by #${id}, which is not in the document`
      );
    }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Dense form: keyboard submit, focus, error announcement, recovery
// ---------------------------------------------------------------------------

test('the form error summary is a live region from the first render, and starts empty', async () => {
  const { container, unmount } = await render(React.createElement(bundle.InvoiceForm, { userWallet: SELLER }));
  try {
    const summary = container.querySelector(`#${bundle.INVOICE_FORM_ERROR_SUMMARY_ID}`);
    assert.ok(summary, 'the summary must exist before any error, or the first one may not be announced');
    assert.equal(summary.getAttribute('role'), 'alert');
    assert.equal(summary.getAttribute('aria-atomic'), 'true');
    assert.equal(summary.textContent, '');
  } finally {
    unmount();
  }
});

test('a keyboard submit with one invalid field focuses it, marks it, and announces it once', async () => {
  connectWallet();
  const { container, unmount } = await render(React.createElement(bundle.InvoiceForm, { userWallet: SELLER }));
  try {
    const form = container.querySelector('form');
    const summary = container.querySelector(`#${bundle.INVOICE_FORM_ERROR_SUMMARY_ID}`);
    const summaryNode = summary;

    await submitFromKeyboard(form);

    const amount = container.querySelector('#invoice-amount');
    assert.equal(getDom().window.document.activeElement, amount, 'focus must move to the first invalid field');
    assert.equal(amount.getAttribute('aria-invalid'), 'true');
    const errorId = amount.getAttribute('aria-describedby');
    assert.equal(errorId, 'invoice-amount-error');
    assert.match(container.querySelector(`#${errorId}`).textContent, /Enter an amount/);

    assert.equal(
      container.querySelector(`#${bundle.INVOICE_FORM_ERROR_SUMMARY_ID}`),
      summaryNode,
      'the live region must be updated in place, not re-inserted'
    );
    assert.match(summary.textContent, /^Invoice not created\. 1 field needs attention: Enter an amount/);
    assertDescriptionsResolve(container);
    assertNoViolations(await runAxe(container), 'invoice form with one error');
  } finally {
    unmount();
  }
});

test('several invalid fields: focus goes to the first in form order, each is described, the summary counts them', async () => {
  connectWallet();
  const { container, unmount } = await render(React.createElement(bundle.InvoiceForm, { userWallet: SELLER }));
  try {
    await type(container.querySelector('#invoice-seller-email'), 'not-an-email');
    await type(container.querySelector('#invoice-customer-email'), 'also@bad');
    await submitFromKeyboard(container.querySelector('form'));

    assert.equal(getDom().window.document.activeElement.id, 'invoice-amount');
    for (const id of ['invoice-amount', 'invoice-seller-email', 'invoice-customer-email']) {
      const field = container.querySelector(`#${id}`);
      assert.equal(field.getAttribute('aria-invalid'), 'true', `${id} must be marked invalid`);
      assert.ok(field.getAttribute('aria-describedby').split(' ').includes(`${id}-error`));
    }
    // The client-email hint must survive alongside its error.
    assert.ok(
      container.querySelector('#invoice-customer-email').getAttribute('aria-describedby').includes('invoice-customer-email-hint')
    );
    assert.match(
      container.querySelector(`#${bundle.INVOICE_FORM_ERROR_SUMMARY_ID}`).textContent,
      /3 fields need attention/
    );
    assertDescriptionsResolve(container);
    assertNoViolations(await runAxe(container), 'invoice form with three errors');
  } finally {
    unmount();
  }
});

test('recovery: once corrected, stale errors clear even when the API then fails', async () => {
  connectWallet();
  bundle.resetResponses();
  bundle.setResponse('/invoices', () => {
    const error = new Error('Request failed with status code 500');
    error.response = { status: 500, data: { success: false, error: 'Internal error' } };
    throw error;
  });
  const { container, unmount } = await render(React.createElement(bundle.InvoiceForm, { userWallet: SELLER }));
  try {
    const form = container.querySelector('form');
    await submitFromKeyboard(form);
    assert.equal(container.querySelector('#invoice-amount').getAttribute('aria-invalid'), 'true');

    await type(container.querySelector('#invoice-amount'), '12.5');
    await submitFromKeyboard(form);

    const amount = container.querySelector('#invoice-amount');
    assert.equal(amount.getAttribute('aria-invalid'), 'false', 'a corrected field must not stay marked invalid');
    assert.equal(amount.getAttribute('aria-describedby'), null);
    assert.equal(container.querySelector('#invoice-amount-error'), null);
    assert.equal(container.querySelector(`#${bundle.INVOICE_FORM_ERROR_SUMMARY_ID}`).textContent, '');
  } finally {
    unmount();
    bundle.resetResponses();
  }
});

test('the submit button stays focusable and reports busy while the invoice is being created', async () => {
  connectWallet();
  const pending = deferred();
  let requests = 0;
  bundle.resetResponses();
  bundle.setResponse('/invoices', () => {
    requests += 1;
    return pending.promise;
  });
  const { container, unmount } = await render(React.createElement(bundle.InvoiceForm, { userWallet: SELLER }));
  try {
    const form = container.querySelector('form');
    await type(container.querySelector('#invoice-amount'), '3');
    const submit = container.querySelector('button[type="submit"]');
    submit.focus();
    await submitFromKeyboard(form);

    assert.equal(submit.getAttribute('aria-busy'), 'true');
    assert.equal(submit.getAttribute('aria-disabled'), 'true');
    assert.equal(submit.hasAttribute('disabled'), false, 'a disabled button drops focus to <body> in Chrome');
    assert.equal(getDom().window.document.activeElement, submit);

    await submitFromKeyboard(form);
    assert.equal(requests, 1, 'pressing Enter again while busy must not send a second request');

    await act(async () => {
      pending.resolve({ data: { data: { id: 'inv_created' } } });
      await pending.promise;
    });
    await flush();
    assert.equal(submit.getAttribute('aria-busy'), 'false');
  } finally {
    unmount();
    bundle.resetResponses();
  }
});

// ---------------------------------------------------------------------------
// Error recovery: API-unavailable state and Retry
// ---------------------------------------------------------------------------

test('Retry keeps keyboard focus and reports busy while it runs, and ignores repeat presses', async () => {
  const pending = deferred();
  let retries = 0;
  const onRetry = () => {
    retries += 1;
    return pending.promise;
  };
  const { container, rerender, unmount } = await render(
    React.createElement(bundle.ApiErrorState, { message: 'Network unreachable.', onRetry })
  );
  try {
    const button = container.querySelector('button');
    assert.equal(button.textContent.trim(), 'Retry');
    button.focus();

    await act(async () => button.click());
    assert.equal(button.textContent.trim(), 'Retrying...');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.hasAttribute('disabled'), false);
    assert.equal(getDom().window.document.activeElement, button, 'focus must not be lost mid-retry');

    await act(async () => button.click());
    assert.equal(retries, 1, 'a press while retrying must be ignored');

    // The retry fails again: the same alert region carries the new message.
    const region = container.querySelector('[role="alert"]');
    await act(async () => {
      pending.reject(new Error('still down'));
      await pending.promise.catch(() => undefined);
    });
    await rerender(React.createElement(bundle.ApiErrorState, { message: 'Still unreachable. Try again shortly.', onRetry }));

    assert.equal(container.querySelector('[role="alert"]'), region, 'the alert must be updated, not replaced');
    assert.match(region.textContent, /Still unreachable/);
    assert.equal(button.textContent.trim(), 'Retry');
    assert.equal(button.getAttribute('aria-busy'), 'false');
    assert.equal(getDom().window.document.activeElement, button);
    assertNoViolations(await runAxe(container), 'API error state after a failed retry');
  } finally {
    unmount();
  }
});

test('the error state hides its decorative icons from assistive technology', async () => {
  const { container, unmount } = await render(
    React.createElement(bundle.ApiErrorState, { message: 'Down.', onRetry: () => undefined })
  );
  try {
    for (const svg of container.querySelectorAll('svg')) {
      assert.equal(svg.getAttribute('aria-hidden'), 'true');
    }
  } finally {
    unmount();
  }
});

// ---------------------------------------------------------------------------
// Table: the payment proof's details
// ---------------------------------------------------------------------------

test('the payment proof details table is named and every row is headed', async () => {
  const { generateInvoicePDF } = require('../lib/export.ts');
  const html = generateInvoicePDF({
    id: 'inv_table_a11y',
    amount: 42,
    assetCode: 'USDC',
    status: 'PAID',
    memo: 'QT-TABLE-1',
    sellerPublicKey: SELLER,
    payerPublicKey: SELLER,
    paymentTxHash: 'b'.repeat(64),
    createdAt: '2026-03-01T10:00:00.000Z',
    expiresAt: '2026-03-08T10:00:00.000Z',
    paidAt: '2026-03-02T12:30:00.000Z',
    latePaymentWarningCode: 'PAYMENT_RECEIVED_AFTER_EXPIRY',
  });

  const { document, DOMParser } = getDom().window;
  const container = document.createElement('div');
  container.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  document.body.appendChild(container);
  try {
    const table = container.querySelector('table.details-table');
    assert.equal(table.querySelector('caption')?.textContent, 'Payment proof details');
    const rows = table.querySelectorAll('tr');
    assert.ok(rows.length >= 6);
    for (const row of rows) {
      const header = row.querySelector('th');
      assert.ok(header && header.textContent.trim(), 'every proof row needs a header cell');
      assert.equal(header.getAttribute('scope'), 'row');
      assert.equal(row.querySelectorAll('td').length, 1);
    }
    assert.match(container.textContent, /Payment received after invoice expiry/);
    assertNoViolations(await runAxe(container), 'payment proof document');
  } finally {
    container.remove();
  }
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

test('reduced motion stops animation and transitions app-wide', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
  // Nested in @layer base: capture up to the brace that closes the media query.
  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\}\s*)\}/.exec(css);
  assert.ok(block, 'globals.css must answer prefers-reduced-motion: reduce');
  const rules = block[1];
  assert.match(rules, /\*,\s*\*::before,\s*\*::after/, 'the fallback must reach every element and pseudo-element');
  for (const declaration of [
    /animation-duration:\s*0\.01ms\s*!important/,
    /animation-iteration-count:\s*1\s*!important/,
    /transition-duration:\s*0\.01ms\s*!important/,
  ]) {
    assert.match(rules, declaration);
  }
  // Smooth scrolling is a page-level setting (`html { scroll-behavior }`), so that is where it is undone.
  assert.match(rules, /html\s*\{\s*scroll-behavior:\s*auto;?\s*\}/);
});

test('the landing animations follow the OS reduced-motion setting', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  assert.match(page, /<MotionConfig reducedMotion="user">/);
});

test('busy spinners are decorative: each sits next to text that says the same thing', () => {
  for (const file of ['components/ApiErrorState.tsx', 'components/InvoiceForm.tsx']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/<(RefreshCw|Loader2)\b[^>]*animate-spin[^>]*>/g)) {
      assert.match(match[0], /aria-hidden/, `${file}: ${match[1]} spinner must be aria-hidden`);
    }
  }
});

test('the invoice form summary text is built in form order and is empty with no errors', () => {
  assert.equal(bundle.invoiceFormErrorSummary({}), '');
  assert.equal(
    bundle.invoiceFormErrorSummary({ customerEmail: 'C.', amount: 'A.' }),
    'Invoice not created. 2 fields need attention: A. C.'
  );
});
