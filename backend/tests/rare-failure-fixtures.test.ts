import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RareFailureFixtures,
  createValidNativePaymentFixture,
  createValidAssetPaymentFixture,
  createSubStroopUnderpaidFixture,
  createMaliciousAssetIssuerCloneFixture,
  createNetworkPassphraseMismatchFixture,
  createMultiOperationPaymentFixture,
  createExpiredInvoiceSettlementRaceFixture,
  createDeadLetterJobEscalationFixture,
  createStaleJobLockRecoveryFixture,
  createTransientHorizonRateLimitFixture,
  createMaintainerMissingSecondApproverFixture,
  createMaintainerExpiredTtlFixture,
  createWebhookStaleTimestampFixture,
  createWebhookForgedHmacFixture,
  createCorruptedAuditChainFixture,
} from '../src/sandbox/rare-failure-fixtures';
import {
  verifyHorizonPayment,
  checkInvoiceIsPayable,
} from '../src/services/payment-verification';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { computeBackoffMs } from '../src/jobs/job-types';
import {
  MaintainerApprovalService,
  ApprovalError,
} from '../src/ops/maintainer-approval';
import {
  verifyWebhookSignature,
  isTimestampStale,
} from '../src/webhooks/webhook-verification';
import { MemoryAuditStore } from '../src/audit/audit-service';

describe('Rare Failure & Recovery Fixture Generators (Issue #299)', () => {
  /* ------------------------------------------------------------------------ */
  /* Normal Paths                                                             */
  /* ------------------------------------------------------------------------ */
  describe('Normal Paths', () => {
    it('verifies valid native (XLM) payment fixture successfully', () => {
      const fixture = createValidNativePaymentFixture();
      const result = verifyHorizonPayment(fixture.verifyInput);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.assetCode, 'XLM');
        assert.equal(result.value.amount, '100.0000000');
        assert.equal(result.value.memo, 'INV-NORMAL-XLM-100');
      }
    });

    it('verifies valid issued token (USDC) payment fixture successfully', () => {
      const fixture = createValidAssetPaymentFixture();
      const result = verifyHorizonPayment(fixture.verifyInput);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.assetCode, 'USDC');
        assert.equal(result.value.assetIssuer, RareFailureFixtures.accounts.authenticUsdcIssuer);
        assert.equal(result.value.amount, '50.0000000');
      }
    });

    it('enqueues and claims normal queued job fixture in job store', async () => {
      const store = new MemoryJobStore();
      const job = RareFailureFixtures.normal.queuedJob();
      await store.enqueue(job);

      const claimed = await store.claimNext('worker-01', new Date(), 30_000);
      assert.ok(claimed);
      assert.equal(claimed.id, job.id);
      assert.equal(claimed.status, 'running');
      assert.equal(claimed.lockedBy, 'worker-01');
    });

    it('validates normal webhook delivery with valid HMAC and fresh timestamp', () => {
      const webhook = RareFailureFixtures.normal.webhook();
      const valid = verifyWebhookSignature(
        webhook.payload,
        webhook.signature,
        webhook.secret,
        webhook.timestamp
      );
      assert.equal(valid, true);
      assert.equal(isTimestampStale(webhook.timestamp, 300), false);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Failure Paths (Rare & Subtle Domain Edge Cases)                         */
  /* ------------------------------------------------------------------------ */
  describe('Failure Paths', () => {
    it('rejects sub-stroop underpaid payment exceeding tolerance window with AMOUNT_MISMATCH', () => {
      const fixture = createSubStroopUnderpaidFixture(2); // 2 stroops short
      const result = verifyHorizonPayment(fixture.verifyInput);

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'AMOUNT_MISMATCH');
      }
    });

    it('rejects malicious clone issuer of USDC with ASSET_MISMATCH', () => {
      const fixture = createMaliciousAssetIssuerCloneFixture();
      const result = verifyHorizonPayment(fixture.verifyInput);

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'ASSET_MISMATCH');
      }
    });

    it('rejects cross-network replay with NETWORK_MISMATCH', () => {
      const fixture = createNetworkPassphraseMismatchFixture();
      const result = verifyHorizonPayment(fixture.verifyInput);

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'NETWORK_MISMATCH');
      }
    });

    it('isolates target payment among multiple operations or fails if missing', () => {
      const validMulti = createMultiOperationPaymentFixture(true);
      const validResult = verifyHorizonPayment(validMulti.verifyInput);
      assert.equal(validResult.ok, true);

      const invalidMulti = createMultiOperationPaymentFixture(false);
      const invalidResult = verifyHorizonPayment(invalidMulti.verifyInput);
      assert.equal(invalidResult.ok, false);
      if (!invalidResult.ok) {
        assert.equal(invalidResult.code, 'DESTINATION_MISMATCH');
      }
    });

    it('rejects expired invoice settlement race with INVOICE_EXPIRED', () => {
      const raceFixture = createExpiredInvoiceSettlementRaceFixture();
      const payableCheck = checkInvoiceIsPayable(raceFixture.invoice.status);

      assert.equal(payableCheck.ok, false);
      if (!payableCheck.ok) {
        assert.equal(payableCheck.code, 'INVOICE_EXPIRED');
      }
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Retry & Recovery Paths                                                  */
  /* ------------------------------------------------------------------------ */
  describe('Retry & Recovery Paths', () => {
    it('manages dead-letter escalation and requeues dead job successfully', async () => {
      const store = new MemoryJobStore();
      const { job } = createDeadLetterJobEscalationFixture();
      await store.enqueue(job);

      const beforeRequeue = await store.get(job.id);
      assert.equal(beforeRequeue?.status, 'dead');
      assert.equal(beforeRequeue?.attempts, 3);
      assert.equal(beforeRequeue?.errors.length, 3);

      // Requeue dead-letter job
      const requeued = await store.requeueDead(job.id, new Date());
      assert.ok(requeued);
      assert.equal(requeued.status, 'queued');
      assert.equal(requeued.attempts, 0); // Reset for retry budget
      assert.equal(requeued.lockedUntil, null);
    });

    it('reclaims stale lease from crashed worker on next claim cycle', async () => {
      const store = new MemoryJobStore();
      const staleJob = createStaleJobLockRecoveryFixture();
      await store.enqueue(staleJob);

      // Claiming with a current timestamp reclaims the job whose lease expired
      const reclaimed = await store.claimNext('worker-recovered-pid-1000', new Date(), 30_000);
      assert.ok(reclaimed);
      assert.equal(reclaimed.id, staleJob.id);
      assert.equal(reclaimed.status, 'running');
      assert.equal(reclaimed.lockedBy, 'worker-recovered-pid-1000');
    });

    it('computes exponential backoff correctly for transient rate limit retries', () => {
      const rateLimitFixture = createTransientHorizonRateLimitFixture();
      assert.equal(rateLimitFixture.status, 429);
      assert.equal(rateLimitFixture.headers['retry-after'], '3');

      const policy = {
        maxAttempts: 5,
        baseDelayMs: 1000,
        backoffFactor: 2,
        maxDelayMs: 30000,
      };

      assert.equal(computeBackoffMs(policy, 1), 1000);
      assert.equal(computeBackoffMs(policy, 2), 2000);
      assert.equal(computeBackoffMs(policy, 3), 4000);
      assert.equal(computeBackoffMs(policy, 4), 8000);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Authorization Paths                                                     */
  /* ------------------------------------------------------------------------ */
  describe('Authorization Paths', () => {
    it('enforces dual maintainer approval and prevents execution without second approver', async () => {
      const secret = 'valid_maintainer_secret_key_123456';
      const service = new MaintainerApprovalService({ secret, risk: null });
      service.registerExecutor('invoice.cancel', async () => ({ cancelled: true }));

      const intent = service.requestIntent({
        action: 'invoice.cancel',
        target: 'inv-123',
        reason: 'Seller requested cancellation due to fraud',
        requestedBy: RareFailureFixtures.accounts.maintainerLead,
      });

      // Attempting to execute while pending requires second approver
      await assert.rejects(
        () =>
          service.execute(intent.id, {
            executedBy: RareFailureFixtures.accounts.maintainerLead,
            confirmation: intent.confirmationPhrase,
          }),
        (err: ApprovalError) => {
          assert.equal(err.code, 'APPROVAL_REQUIRED');
          return true;
        }
      );

      // Requester cannot approve their own intent
      assert.throws(
        () => service.approve(intent.id, RareFailureFixtures.accounts.maintainerLead),
        (err: ApprovalError) => {
          assert.equal(err.code, 'SELF_APPROVAL');
          return true;
        }
      );

      // Second approver approves
      service.approve(intent.id, RareFailureFixtures.accounts.maintainerSec);

      // Now execution succeeds
      const receipt = await service.execute(intent.id, {
        executedBy: RareFailureFixtures.accounts.maintainerLead,
        confirmation: intent.confirmationPhrase,
      });

      assert.equal(receipt.outcome, 'succeeded');
      assert.equal(receipt.approvedBy, RareFailureFixtures.accounts.maintainerSec);
    });

    it('rejects execution of expired maintainer intent with INTENT_EXPIRED', async () => {
      let currentTime = new Date('2026-01-01T00:00:00.000Z');
      const secret = 'valid_maintainer_secret_key_123456';
      const service = new MaintainerApprovalService({
        secret,
        risk: null,
        now: () => currentTime,
      });
      service.registerExecutor('job.requeue_dead', async () => ({ requeued: true }));

      const intent = service.requestIntent({
        action: 'job.requeue_dead',
        target: 'job-123',
        reason: 'Requeue dead job after investigation',
        requestedBy: RareFailureFixtures.accounts.maintainerLead,
      });

      // Fast forward time past 15 minute TTL
      currentTime = new Date('2026-01-01T00:20:00.000Z');

      await assert.rejects(
        () =>
          service.execute(intent.id, {
            executedBy: RareFailureFixtures.accounts.maintainerLead,
            confirmation: intent.confirmationPhrase,
          }),
        (err: ApprovalError) => {
          assert.equal(err.code, 'INTENT_EXPIRED');
          return true;
        }
      );
    });

    it('rejects stale webhook timestamp exceeding replay window', () => {
      const staleWebhook = createWebhookStaleTimestampFixture();
      const isStale = isTimestampStale(staleWebhook.timestamp, 300);
      assert.equal(isStale, true);
    });

    it('rejects forged webhook signature', () => {
      const forgedWebhook = createWebhookForgedHmacFixture();
      const valid = verifyWebhookSignature(
        forgedWebhook.payload,
        forgedWebhook.signature,
        forgedWebhook.secret,
        forgedWebhook.timestamp
      );
      assert.equal(valid, false);
    });

    it('detects corrupted node in audit trail cryptographic chain', () => {
      const auditStore = new MemoryAuditStore();
      const e1 = auditStore.recordEvent({
        action: 'INVOICE_CREATED',
        actor: { type: 'seller', id: 'G1' },
        scope: { entityType: 'invoice', entityId: 'inv-1' },
      });
      const e2 = auditStore.recordEvent({
        action: 'PAYMENT_VERIFIED',
        actor: { type: 'payer', id: 'G2' },
        scope: { entityType: 'invoice', entityId: 'inv-1' },
      });

      const initialVerification = auditStore.verifyChain();
      assert.equal(initialVerification.valid, true);
      assert.equal(initialVerification.checked, 2);

      // Tamper with e1 hash in place
      (e1 as any).hash = 'corrupted_hash_' + '0'.repeat(50);
      const afterTamper = auditStore.verifyChain();
      assert.equal(afterTamper.valid, false);
      assert.equal(afterTamper.failure?.reason, 'event_hash');
      assert.equal(afterTamper.failure?.index, 0);
    });
  });
});
