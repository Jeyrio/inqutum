import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN_ERROR_TAXONOMY,
  AppError,
  classifyError,
  buildUserSafeErrorResponse,
} from '../src/errors/error-taxonomy';
import { VERIFICATION_MESSAGES } from '../src/services/payment-verification';

describe('Structured Error Taxonomy & User-Safe Rendering (Issue #48)', () => {
  describe('Canonical Error Taxonomy Completeness', () => {
    it('covers all verification failure codes with category, retryability, and recovery actions', () => {
      const verificationCodes = Object.keys(VERIFICATION_MESSAGES);

      for (const code of verificationCodes) {
        const taxonomy = DOMAIN_ERROR_TAXONOMY[code];
        assert.ok(taxonomy, `Taxonomy must contain verification code ${code}`);
        assert.equal(taxonomy.code, code);
        assert.ok(
          ['VALIDATION', 'AUTHORIZATION', 'SETTLEMENT', 'LIFECYCLE', 'NOT_FOUND', 'NETWORK', 'RATE_LIMIT', 'INTERNAL'].includes(
            taxonomy.category
          ),
          `Invalid category for ${code}`
        );
        assert.equal(typeof taxonomy.httpStatus, 'number');
        assert.equal(typeof taxonomy.retryable, 'boolean');
        assert.ok(taxonomy.userSafeMessage.length > 0);
        assert.ok(taxonomy.recoveryAction.length > 0);
      }
    });

    it('classifies AppError instances with custom details', () => {
      const error = new AppError('MEMO_MISMATCH', 'Custom memo mismatch message', {
        expected: 'INV-123',
        actual: 'INV-999',
      });

      assert.equal(error.code, 'MEMO_MISMATCH');
      assert.equal(error.category, 'SETTLEMENT');
      assert.equal(error.retryable, false);
      assert.equal(error.httpStatus, 400);
      assert.equal(error.message, 'Custom memo mismatch message');
      assert.deepEqual(error.details, { expected: 'INV-123', actual: 'INV-999' });
    });

    it('classifies network timeouts and Horizon failures as retryable', () => {
      const networkError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
        code: 'ECONNREFUSED',
      });
      const classified = classifyError(networkError);

      assert.equal(classified.code, 'HORIZON_UNAVAILABLE');
      assert.equal(classified.category, 'NETWORK');
      assert.equal(classified.retryable, true);
      assert.equal(classified.httpStatus, 503);
    });

    it('classifies Zod validation errors cleanly', () => {
      const zodError = {
        name: 'ZodError',
        issues: [{ path: ['amount'], message: 'Expected number, received string' }],
      };
      const classified = classifyError(zodError);

      assert.equal(classified.code, 'VALIDATION_FAILED');
      assert.equal(classified.category, 'VALIDATION');
      assert.equal(classified.retryable, false);
      assert.equal(classified.customMessage, 'amount: Expected number, received string');
    });
  });

  describe('User-Safe Error Response Rendering', () => {
    it('produces user-safe payloads without leaking stack traces or internal secrets', () => {
      const internalErr = new Error('Database connection failed at postgres://user:password@internal-db:5432/main');
      const response = buildUserSafeErrorResponse(internalErr, 'req-trace-999');

      assert.equal(response.success, false);
      assert.equal(response.code, 'INTERNAL_ERROR');
      assert.equal(response.category, 'INTERNAL');
      assert.equal(response.retryable, true);
      assert.equal(response.correlationId, 'req-trace-999');
      assert.ok(!response.error.includes('postgres://'));
      assert.ok(!response.error.includes('password'));
      assert.ok(response.recoveryAction.length > 0);
      assert.ok(response.timestamp.length > 0);
    });

    it('preserves stable verification codes and returns actionable recovery guidance', () => {
      const memoErr = { code: 'MEMO_MISMATCH' };
      const response = buildUserSafeErrorResponse(memoErr, 'req-corr-456');

      assert.equal(response.success, false);
      assert.equal(response.code, 'MEMO_MISMATCH');
      assert.equal(response.category, 'SETTLEMENT');
      assert.equal(response.retryable, false);
      assert.equal(response.error, VERIFICATION_MESSAGES.MEMO_MISMATCH);
      assert.equal(
        response.recoveryAction,
        'Include the exact invoice memo in your transaction memo field before sending.'
      );
      assert.equal(response.correlationId, 'req-corr-456');
    });

    it('handles lifecycle errors like INVOICE_EXPIRED and INVOICE_ALREADY_PAID', () => {
      const expiredErr = { code: 'INVOICE_EXPIRED' };
      const response = buildUserSafeErrorResponse(expiredErr);

      assert.equal(response.code, 'INVOICE_EXPIRED');
      assert.equal(response.category, 'LIFECYCLE');
      assert.equal(response.retryable, false);
      assert.match(response.recoveryAction, /Contact the seller/);
    });
  });
});
