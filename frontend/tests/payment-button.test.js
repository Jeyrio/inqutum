const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePaymentRequest,
  classifyPaymentError,
  executePaymentContract,
} = require('../lib/payment-button-contract');

const validParams = {
  destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  amount: '25.5',
  memo: 'INV-1234',
  assetCode: 'XLM',
  invoiceId: 'inv-uuid-1',
  payerName: 'Alice',
  payerEmail: 'alice@example.com',
  invoiceStatus: 'PENDING',
};

// ------------------------------------------------------------- Validation Tests

test('valid payment parameters pass validation', () => {
  const result = validatePaymentRequest(validParams);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.numAmount, 25.5);
    assert.deepEqual(result.payer, {
      payerName: 'Alice',
      payerEmail: 'alice@example.com',
    });
  }
});

test('rejects payment on expired invoice with exact message', () => {
  const result = validatePaymentRequest({
    ...validParams,
    invoiceStatus: 'EXPIRED',
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVOICE_EXPIRED');
    assert.equal(result.error, 'This invoice has expired and cannot be paid');
  }
});

test('rejects payment on non-pending invoice with exact message', () => {
  for (const status of ['PAID', 'CANCELLED', 'UNKNOWN']) {
    const result = validatePaymentRequest({
      ...validParams,
      invoiceStatus: status,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'INVOICE_NOT_PENDING');
      assert.equal(result.error, 'This invoice is not available for payment');
    }
  }
});

test('rejects missing or empty destination', () => {
  for (const destination of ['', '   ', null, undefined]) {
    const result = validatePaymentRequest({
      ...validParams,
      destination,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_DESTINATION');
      assert.equal(result.error, 'Destination address is required');
    }
  }
});

test('rejects missing, zero, negative or non-numeric amounts', () => {
  for (const amount of ['', '0', '-5', 'abc', null, undefined, '   ']) {
    const result = validatePaymentRequest({
      ...validParams,
      amount,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_AMOUNT');
    }
  }
});

test('rejects invalid payer email format', () => {
  const result = validatePaymentRequest({
    ...validParams,
    payerEmail: 'not-an-email',
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_PAYER_EMAIL');
    assert.equal(result.error, 'Enter a valid payer email');
  }
});

test('allows omitted optional payer metadata', () => {
  const result = validatePaymentRequest({
    ...validParams,
    payerName: '',
    payerEmail: '',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.payer, {
      payerName: undefined,
      payerEmail: undefined,
    });
  }
});

// ------------------------------------------------ Error Classification Tests

test('classifies trustline error for non-XLM asset with extended duration', () => {
  const err = new Error('op_no_trust: Destination requires a trustline');
  const classified = classifyPaymentError(err, 'USDC');
  assert.equal(classified.title, 'USDC trustline required');
  assert.equal(classified.isTrustline, true);
  assert.equal(classified.duration, 10000);
  assert.match(classified.description, /trustline/);
});

test('does not classify XLM errors as trustline requirement', () => {
  const err = new Error('some trustline error');
  const classified = classifyPaymentError(err, 'XLM');
  assert.equal(classified.title, 'Payment failed');
  assert.equal(classified.isTrustline, false);
  assert.equal(classified.duration, undefined);
});

test('classifies generic error with fallback message', () => {
  const classified = classifyPaymentError(null, 'XLM');
  assert.equal(classified.title, 'Payment failed');
  assert.equal(classified.description, 'Try again');
});

// ---------------------------------------- Payment Execution & Lifecycle Tests

test('handles missing Freighter extension gracefully', async () => {
  let promptShown = false;
  let reportedError = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => false,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'tx123',
      showFreighterInstallPrompt: () => {
        promptShown = true;
      },
      onError: (err) => {
        reportedError = err;
      },
    },
    validParams
  );

  assert.equal(res.success, false);
  assert.equal(promptShown, true);
  assert.equal(reportedError, 'Freighter is not installed');
});

test('handles extension throwing during connection check as unavailable', async () => {
  let promptShown = false;
  let reportedError = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => {
        throw new Error('Freighter extension crashed');
      },
      requestWalletAccess: async () => true,
      sendPayment: async () => 'tx123',
      showFreighterInstallPrompt: () => {
        promptShown = true;
      },
      onError: (err) => {
        reportedError = err;
      },
    },
    validParams
  );

  assert.equal(res.success, false);
  assert.equal(promptShown, true);
  assert.equal(reportedError, 'Freighter is not installed');
});

test('handles wallet access denial with safe recovery path', async () => {
  let reportedError = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => false,
      sendPayment: async () => 'tx123',
      onError: (err) => {
        reportedError = err;
      },
    },
    validParams
  );

  assert.equal(res.success, false);
  assert.equal(reportedError, 'Freighter access was denied');
});

test('handles payment rejection in wallet with safe retry path', async () => {
  let reportedError = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => {
        throw new Error('User declined transaction');
      },
      onError: (err) => {
        reportedError = err;
      },
    },
    validParams
  );

  assert.equal(res.success, false);
  assert.equal(reportedError, 'Payment failed');
});

test('successful payment without invoiceId invokes onSuccess and toasts success', async () => {
  let started = false;
  let succeededHash = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'a'.repeat(64),
      onStart: () => {
        started = true;
      },
      onSuccess: (h) => {
        succeededHash = h;
      },
    },
    { ...validParams, invoiceId: undefined }
  );

  assert.equal(started, true);
  assert.equal(res.success, true);
  assert.equal(res.txHash, 'a'.repeat(64));
  assert.equal(succeededHash, 'a'.repeat(64));
});

test('successful payment and verification invokes onSuccess', async () => {
  let verified = false;
  let succeededHash = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'b'.repeat(64),
      verifyInvoice: async (id, hash, payer) => {
        assert.equal(id, 'inv-uuid-1');
        assert.equal(hash, 'b'.repeat(64));
        assert.equal(payer.payerEmail, 'alice@example.com');
        verified = true;
        return { status: 'PAID' };
      },
      onSuccess: (h) => {
        succeededHash = h;
      },
    },
    validParams
  );

  assert.equal(res.success, true);
  assert.equal(res.verified, true);
  assert.equal(verified, true);
  assert.equal(succeededHash, 'b'.repeat(64));
});

test('degraded verification dependency still resolves success so user is not double-charged', async () => {
  let toastWarning = null;
  let succeededHash = null;

  const res = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'c'.repeat(64),
      verifyInvoice: async () => {
        const err = new Error('Network timeout contacting verification service');
        err.response = { data: { error: 'Verification service temporarily unavailable' } };
        throw err;
      },
      toast: {
        warning: (title, opts) => {
          toastWarning = { title, description: opts?.description };
        },
      },
      onSuccess: (h) => {
        succeededHash = h;
      },
    },
    validParams
  );

  assert.equal(res.success, true);
  assert.equal(res.verified, false);
  assert.equal(succeededHash, 'c'.repeat(64));
  assert.equal(toastWarning?.title, 'Payment sent but verification failed');
  assert.equal(toastWarning?.description, 'Verification service temporarily unavailable');
});
