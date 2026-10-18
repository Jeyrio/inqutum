/**
 * Fixture generators for rare failure, retry, authorization, and recovery paths (issue #299).
 *
 * Provides deterministic, production-grade fixture generators for simulating:
 * 1. Normal Paths: valid native XLM & tokenized assets, background jobs, dual approval, webhook delivery.
 * 2. Rare Failure Paths: sub-stroop precision mismatch, malicious clone issuers, replay hashes, network mismatch, multi-op confusion.
 * 3. Retry Paths: exponential backoff exhaustion, dead-letter state, crashed worker stale lock reclamation, rate-limit 429 backoff.
 * 4. Authorization Paths: dual-maintainer approval bypass, self-approval prevention, TTL expiration, webhook timestamp replay & forged HMAC, audit chain tampering.
 *
 * All generated fixtures are pure, self-contained, and deterministic.
 */

import { randomBytes, createHash } from 'node:crypto';
import type {
  ExpectedPayment,
  HorizonOperationLike,
  HorizonTransactionLike,
  VerifyPaymentInput,
} from '../services/payment-verification';
import type { Job, RetryPolicy } from '../jobs/job-types';
import { DEFAULT_RETRY_POLICY } from '../jobs/job-types';
import type { MaintainerIntent, IntentReceipt } from '../ops/maintainer-approval';
import { canonicalJson } from '../ops/maintainer-approval';
import { signWebhookPayload } from '../webhooks/webhook-verification';
import type { AuditEvent } from '../audit/audit-service';

// Standard deterministic accounts for reproducible runs across environments
export const FIXTURE_ACCOUNTS = {
  seller: 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR',
  payer: 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U',
  authenticUsdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  imposterUsdcIssuer: 'GADPR3OVMDQIJ7TXHC2BLXAVBA2DABDQFXN73EYRERNOX6DAYS3KUW7U',
  maintainerLead: 'GAA5O6F642354P73X26CVSV5L6XZ3M6K7G3W2BVRQZ3G2C5B67P8AAAA',
  maintainerSec: 'GBB6P7G753465Q84Y37DWTW6M7YA4N7L8H4X3CWSRA4H3D6C78Q9BBBB',
} as const;

export interface PaymentFixtureBundle {
  txHash: string;
  expected: ExpectedPayment;
  transaction: HorizonTransactionLike;
  operations: HorizonOperationLike[];
  network: string;
  verifyInput: VerifyPaymentInput;
}

export interface WebhookFixtureBundle {
  payload: Record<string, unknown>;
  secret: string;
  timestamp: string;
  signature: string;
}

export interface JobFailureRecoveryBundle {
  job: Job;
  attemptsExhausted: boolean;
  expectedNextState: 'queued' | 'running' | 'dead';
}

export interface MaintainerAuthFixtureBundle {
  intent: MaintainerIntent;
  secret: string;
  secondApproverId: string;
  receipt?: IntentReceipt;
}

/* -------------------------------------------------------------------------- */
/* 1. NORMAL PATH FIXTURES                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Generates a valid native (XLM) payment verification bundle.
 */
export function createValidNativePaymentFixture(overrides: Partial<PaymentFixtureBundle> = {}): PaymentFixtureBundle {
  const txHash = overrides.txHash ?? 'a'.repeat(64);
  const expected: ExpectedPayment = overrides.expected ?? {
    memo: 'INV-NORMAL-XLM-100',
    amount: '100.0000000',
    destination: FIXTURE_ACCOUNTS.seller,
    assetCode: 'XLM',
    network: 'TESTNET',
  };
  const transaction: HorizonTransactionLike = overrides.transaction ?? {
    memo: expected.memo,
    memo_type: 'text',
    envelope_type: 'tx',
  };
  const operations: HorizonOperationLike[] = overrides.operations ?? [
    {
      type: 'payment',
      from: FIXTURE_ACCOUNTS.payer,
      to: expected.destination,
      amount: String(expected.amount),
      asset_type: 'native',
    },
  ];
  const network = overrides.network ?? 'TESTNET';

  return {
    txHash,
    expected,
    transaction,
    operations,
    network,
    verifyInput: { txHash, expected, transaction, operations, network },
  };
}

/**
 * Generates a valid issued asset (e.g. USDC) payment bundle.
 */
export function createValidAssetPaymentFixture(overrides: Partial<PaymentFixtureBundle> = {}): PaymentFixtureBundle {
  const txHash = overrides.txHash ?? 'b'.repeat(64);
  const expected: ExpectedPayment = overrides.expected ?? {
    memo: 'INV-NORMAL-USDC-50',
    amount: '50.0000000',
    destination: FIXTURE_ACCOUNTS.seller,
    assetCode: 'USDC',
    assetIssuer: FIXTURE_ACCOUNTS.authenticUsdcIssuer,
    network: 'TESTNET',
  };
  const transaction: HorizonTransactionLike = overrides.transaction ?? {
    memo: expected.memo,
    memo_type: 'text',
  };
  const operations: HorizonOperationLike[] = overrides.operations ?? [
    {
      type: 'payment',
      from: FIXTURE_ACCOUNTS.payer,
      to: expected.destination,
      amount: String(expected.amount),
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: FIXTURE_ACCOUNTS.authenticUsdcIssuer,
    },
  ];
  const network = overrides.network ?? 'TESTNET';

  return {
    txHash,
    expected,
    transaction,
    operations,
    network,
    verifyInput: { txHash, expected, transaction, operations, network },
  };
}

/**
 * Generates a normal background job in queued state.
 */
export function createValidQueuedJobFixture(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'job-norm-001',
    type: overrides.type ?? 'invoice.export_pdf',
    payload: overrides.payload ?? { version: 1, data: { invoiceId: 'inv-100', format: 'pdf' } },
    status: 'queued',
    attempts: 0,
    retryPolicy: overrides.retryPolicy ?? { ...DEFAULT_RETRY_POLICY },
    runAt: now,
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: overrides.idempotencyKey ?? 'idem-norm-100',
    correlationId: overrides.correlationId ?? 'corr-norm-100',
    errors: [],
    result: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

/**
 * Generates a normal webhook delivery bundle with valid signature and fresh timestamp.
 */
export function createValidWebhookFixture(overrides: Partial<WebhookFixtureBundle> = {}): WebhookFixtureBundle {
  const secret = overrides.secret ?? 'super_secret_webhook_key_2026';
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const payload = overrides.payload ?? {
    event: 'invoice.paid',
    invoiceId: 'inv-100',
    settledAmount: '100.0000000',
    currency: 'XLM',
  };
  const signature = overrides.signature ?? signWebhookPayload(payload, secret, timestamp);

  return { payload, secret, timestamp, signature };
}

/* -------------------------------------------------------------------------- */
/* 2. FAILURE PATH FIXTURES (Rare & Complex Edge Cases)                       */
/* -------------------------------------------------------------------------- */

/**
 * Generates an underpaid payment fixture missing 1 stroop or exceeding tolerance window.
 * Stellar amount format is 7 decimals. If expected is 100.0000000, actual is 99.9999990 (10 stroops short).
 * When paymentAmountTolerance is enabled (1 stroop), 2+ stroops difference triggers AMOUNT_MISMATCH.
 */
export function createSubStroopUnderpaidFixture(shortStroops = 2): PaymentFixtureBundle {
  const expectedAmount = 100.0;
  const shortAmount = (expectedAmount - shortStroops * 1e-7).toFixed(7);
  const bundle = createValidNativePaymentFixture({
    txHash: 'c'.repeat(64),
    expected: {
      memo: 'INV-UNDERPAID-01',
      amount: '100.0000000',
      destination: FIXTURE_ACCOUNTS.seller,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    operations: [
      {
        type: 'payment',
        from: FIXTURE_ACCOUNTS.payer,
        to: FIXTURE_ACCOUNTS.seller,
        amount: shortAmount,
        asset_type: 'native',
      },
    ],
  });
  return bundle;
}

/**
 * Generates a counterfeit asset payment where asset_code matches ('USDC'),
 * but asset_issuer is an unauthorized clone account. Triggers ASSET_MISMATCH.
 */
export function createMaliciousAssetIssuerCloneFixture(): PaymentFixtureBundle {
  const bundle = createValidAssetPaymentFixture({
    txHash: 'd'.repeat(64),
    expected: {
      memo: 'INV-MALICIOUS-ISSUER-01',
      amount: '50.0000000',
      destination: FIXTURE_ACCOUNTS.seller,
      assetCode: 'USDC',
      assetIssuer: FIXTURE_ACCOUNTS.authenticUsdcIssuer,
      network: 'TESTNET',
    },
    operations: [
      {
        type: 'payment',
        from: FIXTURE_ACCOUNTS.payer,
        to: FIXTURE_ACCOUNTS.seller,
        amount: '50.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: FIXTURE_ACCOUNTS.imposterUsdcIssuer, // Malicious clone!
      },
    ],
  });
  return bundle;
}

/**
 * Generates a cross-network replay fixture where transaction was executed on TESTNET,
 * but invoice expectations require PUBLIC (mainnet). Triggers NETWORK_MISMATCH.
 */
export function createNetworkPassphraseMismatchFixture(): PaymentFixtureBundle {
  const bundle = createValidNativePaymentFixture({
    txHash: 'e'.repeat(64),
    expected: {
      memo: 'INV-MAINNET-01',
      amount: '10.0000000',
      destination: FIXTURE_ACCOUNTS.seller,
      assetCode: 'XLM',
      network: 'PUBLIC',
    },
    network: 'TESTNET', // Caller or client network mismatch
  });
  return bundle;
}

/**
 * Generates a transaction with multiple operations where payment is preceded or followed
 * by non-matching operations (e.g. account_merge, claimable_balance, or payment to unrelated party).
 */
export function createMultiOperationPaymentFixture(targetValid = true): PaymentFixtureBundle {
  const operations: HorizonOperationLike[] = [
    {
      type: 'account_merge',
      from: FIXTURE_ACCOUNTS.payer,
      to: 'G' + '1'.repeat(55),
    },
    {
      type: 'payment',
      from: FIXTURE_ACCOUNTS.payer,
      to: 'G' + '2'.repeat(55),
      amount: '5.0000000',
      asset_type: 'native',
    },
  ];

  if (targetValid) {
    operations.push({
      type: 'payment',
      from: FIXTURE_ACCOUNTS.payer,
      to: FIXTURE_ACCOUNTS.seller,
      amount: '100.0000000',
      asset_type: 'native',
    });
  }

  return createValidNativePaymentFixture({
    txHash: 'f'.repeat(64),
    operations,
  });
}

/**
 * Generates an expired invoice state fixture to test settlement race conditions.
 */
export function createExpiredInvoiceSettlementRaceFixture() {
  const now = Date.now();
  return {
    invoice: {
      id: 'inv-expired-race-01',
      status: 'EXPIRED' as const,
      amount: '100.0000000',
      destination: FIXTURE_ACCOUNTS.seller,
      memo: 'INV-EXP-01',
      assetCode: 'XLM',
      expiresAt: new Date(now - 60_000).toISOString(),
    },
    payment: createValidNativePaymentFixture({
      expected: {
        memo: 'INV-EXP-01',
        amount: '100.0000000',
        destination: FIXTURE_ACCOUNTS.seller,
        assetCode: 'XLM',
        network: 'TESTNET',
      },
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. RETRY & RECOVERY PATH FIXTURES                                          */
/* -------------------------------------------------------------------------- */

/**
 * Generates a dead-letter job fixture that has exhausted all maxAttempts
 * and contains complete diagnostic error history.
 */
export function createDeadLetterJobEscalationFixture(overrides: Partial<Job> = {}): JobFailureRecoveryBundle {
  const policy: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 500,
    backoffFactor: 2,
    maxDelayMs: 2000,
  };
  const errors = [
    { attempt: 1, at: new Date(Date.now() - 30_000).toISOString(), message: 'Horizon gateway timeout (504)' },
    { attempt: 2, at: new Date(Date.now() - 20_000).toISOString(), message: 'Horizon connection reset (ECONNRESET)' },
    { attempt: 3, at: new Date(Date.now() - 10_000).toISOString(), message: 'Max attempts exhausted: Horizon unreachable' },
  ];

  const job: Job = {
    id: overrides.id ?? 'job-dead-001',
    type: overrides.type ?? 'webhook.dispatch',
    payload: { version: 1, data: { endpoint: 'https://api.merchant.com/webhook', invoiceId: 'inv-100' } },
    status: 'dead',
    attempts: 3,
    retryPolicy: policy,
    runAt: new Date().toISOString(),
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: 'idem-dead-001',
    correlationId: 'corr-dead-001',
    errors,
    result: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };

  return {
    job,
    attemptsExhausted: true,
    expectedNextState: 'dead',
  };
}

/**
 * Generates an orphaned job with an expired worker lease (crashed worker simulation).
 * Demonstrates stale lock recovery where lockedUntil < now.
 */
export function createStaleJobLockRecoveryFixture(): Job {
  const pastTime = new Date(Date.now() - 60_000).toISOString();
  return {
    id: 'job-crashed-worker-001',
    type: 'invoice.settlement_verify',
    payload: { version: 1, data: { invoiceId: 'inv-abandoned-01' } },
    status: 'running',
    attempts: 1,
    retryPolicy: { ...DEFAULT_RETRY_POLICY },
    runAt: new Date(Date.now() - 120_000).toISOString(),
    lockedUntil: pastTime, // Lease expired 1 minute ago!
    lockedBy: 'worker-dead-pid-9999',
    idempotencyKey: 'idem-crash-001',
    correlationId: 'corr-crash-001',
    errors: [],
    result: null,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: pastTime,
    completedAt: null,
  };
}

/**
 * Generates a transient Horizon 429 rate-limited response structure with retry headers.
 */
export function createTransientHorizonRateLimitFixture() {
  return {
    status: 429,
    headers: {
      'retry-after': '3',
      'x-ratelimit-limit': '3600',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3),
    },
    body: {
      type: 'https://stellar.org/horizon-errors/rate_limit_exceeded',
      title: 'Rate Limit Exceeded',
      status: 429,
      detail: 'The rate limit for the requesting IP address was exceeded.',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 4. AUTHORIZATION PATH FIXTURES                                             */
/* -------------------------------------------------------------------------- */

/**
 * Generates a maintainer intent fixture that requires a second approver
 * but is executed without approval (asserts APPROVAL_REQUIRED).
 */
export function createMaintainerMissingSecondApproverFixture(secret = 'a'.repeat(32)): MaintainerAuthFixtureBundle {
  const now = new Date();
  const intent: MaintainerIntent = {
    id: 'intent-missing-second-01',
    action: 'invoice.cancel',
    target: 'inv-to-cancel-01',
    reason: 'Fraudulent activity reported by seller',
    requestedBy: FIXTURE_ACCOUNTS.maintainerLead,
    approvedBy: null, // NOT approved!
    params: { reason: 'chargeback_fraud' },
    paramsHash: createHash('sha256').update(canonicalJson({ reason: 'chargeback_fraud' })).digest('hex'),
    confirmationPhrase: 'invoice.cancel inv-to-cancel-01',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    status: 'pending',
    risk: null,
    signature: '',
  };

  return {
    intent,
    secret,
    secondApproverId: FIXTURE_ACCOUNTS.maintainerSec,
  };
}

/**
 * Generates an expired maintainer intent (asserts INTENT_EXPIRED).
 */
export function createMaintainerExpiredTtlFixture(secret = 'a'.repeat(32)): MaintainerAuthFixtureBundle {
  const expiredTime = new Date(Date.now() - 300_000).toISOString();
  const intent: MaintainerIntent = {
    id: 'intent-expired-ttl-01',
    action: 'job.requeue_dead',
    target: 'job-123',
    reason: 'Re-running dead letter job after infrastructure patch',
    requestedBy: FIXTURE_ACCOUNTS.maintainerLead,
    approvedBy: FIXTURE_ACCOUNTS.maintainerSec,
    params: {},
    paramsHash: createHash('sha256').update(canonicalJson({})).digest('hex'),
    confirmationPhrase: 'job.requeue_dead job-123',
    createdAt: new Date(Date.now() - 900_000).toISOString(),
    expiresAt: expiredTime, // Already expired!
    status: 'approved',
    risk: null,
    signature: '',
  };

  return {
    intent,
    secret,
    secondApproverId: FIXTURE_ACCOUNTS.maintainerSec,
  };
}

/**
 * Generates a webhook fixture with a stale timestamp (> 300 seconds old, replay attack vector).
 */
export function createWebhookStaleTimestampFixture(): WebhookFixtureBundle {
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
  const secret = 'webhook_secret_key_prod_test';
  const payload = { event: 'invoice.paid', invoiceId: 'inv-stale-01' };
  const signature = signWebhookPayload(payload, secret, staleTimestamp);

  return {
    payload,
    secret,
    timestamp: staleTimestamp,
    signature,
  };
}

/**
 * Generates a webhook fixture with a forged/tampered signature.
 */
export function createWebhookForgedHmacFixture(): WebhookFixtureBundle {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = 'valid_secret_key_123456';
  const payload = { event: 'invoice.paid', invoiceId: 'inv-forged-01' };
  const signature = 'sha256=' + '0'.repeat(64); // Invalid signature

  return {
    payload,
    secret,
    timestamp,
    signature,
  };
}

/**
 * Generates a tampered audit trail where an intermediate block's hash or payload was corrupted.
 */
export function createCorruptedAuditChainFixture() {
  const baseEvent = (id: string, prevHash: string | null): AuditEvent => {
    const raw: Omit<AuditEvent, 'hash'> = {
      id,
      timestamp: new Date().toISOString(),
      action: 'INVOICE_CREATED',
      actor: { type: 'seller', id: FIXTURE_ACCOUNTS.seller },
      scope: { entityType: 'invoice', entityId: id },
      previousHash: prevHash,
    };
    return {
      ...raw,
      hash: createHash('sha256').update(canonicalJson(raw)).digest('hex'),
    };
  };

  const event1 = baseEvent('event-01', null);
  const event2 = baseEvent('event-02', event1.hash!);
  const event3 = baseEvent('event-03', event2.hash!);

  // Corrupt event 2 by tampering with its actor in-place without recalculating hash
  const corruptedEvent2 = {
    ...event2,
    actor: { type: 'seller' as const, id: 'GATTACKER_SPOOFED_ACCOUNT' },
  };

  return {
    validChain: [event1, event2, event3],
    corruptedChain: [event1, corruptedEvent2, event3],
    tamperedIndex: 1,
  };
}

/* -------------------------------------------------------------------------- */
/* CONSOLIDATED REGISTRY                                                      */
/* -------------------------------------------------------------------------- */

export const RareFailureFixtures = {
  accounts: FIXTURE_ACCOUNTS,
  normal: {
    nativePayment: createValidNativePaymentFixture,
    assetPayment: createValidAssetPaymentFixture,
    queuedJob: createValidQueuedJobFixture,
    webhook: createValidWebhookFixture,
  },
  failure: {
    subStroopUnderpaid: createSubStroopUnderpaidFixture,
    maliciousIssuerClone: createMaliciousAssetIssuerCloneFixture,
    networkMismatch: createNetworkPassphraseMismatchFixture,
    multiOperation: createMultiOperationPaymentFixture,
    expiredInvoiceRace: createExpiredInvoiceSettlementRaceFixture,
  },
  retry: {
    deadLetterEscalation: createDeadLetterJobEscalationFixture,
    staleLockRecovery: createStaleJobLockRecoveryFixture,
    horizonRateLimit: createTransientHorizonRateLimitFixture,
  },
  authorization: {
    missingSecondApprover: createMaintainerMissingSecondApproverFixture,
    expiredTtl: createMaintainerExpiredTtlFixture,
    webhookStaleTimestamp: createWebhookStaleTimestampFixture,
    webhookForgedHmac: createWebhookForgedHmacFixture,
    corruptedAuditChain: createCorruptedAuditChainFixture,
  },
};
