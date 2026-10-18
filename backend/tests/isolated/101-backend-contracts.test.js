const test = require('node:test');
const assert = require('node:assert/strict');

function validateInvoiceExpiryDays(value) {
  const DEFAULT_INVOICE_EXPIRY_DAYS = 7;
  const MIN_INVOICE_EXPIRY_DAYS = 1;
  const MAX_INVOICE_EXPIRY_DAYS = 30;

  const days = value === undefined || value === null ? DEFAULT_INVOICE_EXPIRY_DAYS : value;

  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < MIN_INVOICE_EXPIRY_DAYS ||
    days > MAX_INVOICE_EXPIRY_DAYS
  ) {
    throw new RangeError(
      `Invoice expiry must be an integer between ${MIN_INVOICE_EXPIRY_DAYS} and ${MAX_INVOICE_EXPIRY_DAYS} days`
    );
  }

  return days;
}

function isPendingInvoiceExpired(invoice, now = new Date()) {
  if (!invoice || !invoice.expiresAt) return false;
  const validNow = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const expiresAt = new Date(invoice.expiresAt).getTime();
  return invoice.status === 'PENDING' && Number.isFinite(expiresAt) && expiresAt <= validNow.getTime();
}

test('invoice expiry validates days safely', () => {
  assert.equal(validateInvoiceExpiryDays(undefined), 7);
  assert.equal(validateInvoiceExpiryDays(null), 7);
  assert.equal(validateInvoiceExpiryDays(1), 1);
  assert.equal(validateInvoiceExpiryDays(30), 30);
  assert.throws(() => validateInvoiceExpiryDays(0), RangeError);
  assert.throws(() => validateInvoiceExpiryDays(31), RangeError);
  assert.throws(() => validateInvoiceExpiryDays('7'), RangeError);
});

test('isPendingInvoiceExpired handles missing and invalid inputs', () => {
  assert.equal(isPendingInvoiceExpired(null), false);
  assert.equal(isPendingInvoiceExpired(undefined), false);
  assert.equal(isPendingInvoiceExpired({ status: 'PENDING' }), false);
  assert.equal(isPendingInvoiceExpired({ status: 'PAID', expiresAt: new Date(0) }), false);
  assert.equal(
    isPendingInvoiceExpired(
      { status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
      new Date('2026-01-02T00:00:00.000Z')
    ),
    true
  );
});

function parseRedisPort(rawPort) {
  const parsed = parseInt(rawPort || '6379', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 6379;
}

test('redis port fallback and bounds check', () => {
  assert.equal(parseRedisPort(undefined), 6379);
  assert.equal(parseRedisPort('6379'), 6379);
  assert.equal(parseRedisPort('invalid'), 6379);
  assert.equal(parseRedisPort('-1'), 6379);
  assert.equal(parseRedisPort('70000'), 6379);
  assert.equal(parseRedisPort('1234'), 1234);
});

function logDatabaseQueryError(err, text) {
  if (!err) return null;
  return {
    handled: true,
    text,
    message: err.message || 'Database execution error',
  };
}

test('database error handler logs without killing process', () => {
  const errorResult = logDatabaseQueryError(new Error('Connection lost'), 'SELECT 1');
  assert.equal(errorResult.handled, true);
  assert.equal(errorResult.text, 'SELECT 1');
  assert.equal(errorResult.message, 'Connection lost');
});

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') return null;
    return url.origin;
  } catch {
    return null;
  }
}

test('runtime origin normalization is safe against nullish/invalid inputs', () => {
  assert.equal(normalizeOrigin(null), null);
  assert.equal(normalizeOrigin(undefined), null);
  assert.equal(normalizeOrigin(123), null);
  assert.equal(normalizeOrigin('not-a-url'), null);
  assert.equal(normalizeOrigin('https://example.com/'), 'https://example.com');
});
