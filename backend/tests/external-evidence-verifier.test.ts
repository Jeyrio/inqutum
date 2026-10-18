import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';

import {
  ExternalEvidenceVerifier,
  ExternalEvidencePayload,
  SignedEvidenceEnvelope,
  SignerTrustStore,
  EvidenceVerificationError,
} from '../src/security/external-evidence-verifier';

describe('External Evidence Cryptographic Verification (Issue #277)', () => {
  let ed25519KeyPair: crypto.KeyPairSyncResult<string, string>;
  let hmacSecret: string;
  let trustStore: SignerTrustStore;
  let verifier: ExternalEvidenceVerifier;

  beforeEach(() => {
    ed25519KeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    hmacSecret = 'super-secure-shared-oracle-secret-key-32b';

    const keysMap = new Map<string, { key: string; algorithm: 'ed25519' | 'hmac-sha256'; revoked?: boolean }>([
      ['oracle-ed25519-v1', { key: ed25519KeyPair.publicKey, algorithm: 'ed25519' }],
      ['partner-hmac-v1', { key: hmacSecret, algorithm: 'hmac-sha256' }],
      ['revoked-key-v1', { key: hmacSecret, algorithm: 'hmac-sha256', revoked: true }],
    ]);

    trustStore = {
      getSignerKey: (id) => keysMap.get(id) ?? null,
    };

    verifier = new ExternalEvidenceVerifier({
      trustStore,
      maxAgeMs: 5 * 60_000, // 5 min
      allowedSkewMs: 30_000, // 30 sec
    });
  });

  const createSamplePayload = (overrides: Partial<ExternalEvidencePayload> = {}): ExternalEvidencePayload => ({
    evidenceId: 'ev-12345',
    sourceSystem: 'STELLAR_ORACLE_BRIDGE',
    transactionHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    invoiceId: 'inv-999',
    amount: '100.5000000',
    assetCode: 'USDC',
    ledgerSequence: 5432100,
    timestamp: new Date().toISOString(),
    nonce: 'nonce-' + Math.random().toString(36).substring(2),
    metadata: { memo: 'PAYMENT-TEST-1' },
    ...overrides,
  });

  describe('Normal Path', () => {
    it('verifies valid HMAC-SHA256 external evidence and returns receipt', () => {
      const payload = createSamplePayload();
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'partner-hmac-v1',
        signature,
      };

      const receipt = verifier.verify(envelope);
      assert.equal(receipt.verified, true);
      assert.equal(receipt.evidenceId, payload.evidenceId);
      assert.equal(receipt.algorithm, 'hmac-sha256');
      assert.equal(receipt.replayed, false);
      assert.ok(receipt.canonicalDigestHex.length === 64);
    });

    it('verifies valid Ed25519 public key signed evidence', () => {
      const payload = createSamplePayload();
      const signature = ExternalEvidenceVerifier.signEd25519(payload, ed25519KeyPair.privateKey);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'ed25519',
        signerKeyId: 'oracle-ed25519-v1',
        signature,
      };

      const receipt = verifier.verify(envelope);
      assert.equal(receipt.verified, true);
      assert.equal(receipt.evidenceId, payload.evidenceId);
      assert.equal(receipt.algorithm, 'ed25519');
      assert.equal(receipt.replayed, false);
    });
  });

  describe('Failure Path & Tamper Detection', () => {
    it('rejects evidence when payload fields (e.g. amount) are tampered with', () => {
      const payload = createSamplePayload({ amount: '100.0000000' });
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      // Tamper amount
      const tamperedPayload = { ...payload, amount: '999.0000000' };

      const envelope: SignedEvidenceEnvelope = {
        payload: tamperedPayload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'partner-hmac-v1',
        signature,
      };

      assert.throws(
        () => verifier.verify(envelope),
        (err: unknown) => {
          assert.ok(err instanceof EvidenceVerificationError);
          assert.equal(err.code, 'INVALID_SIGNATURE');
          return true;
        }
      );
    });

    it('rejects expired evidence older than allowable window', () => {
      const staleTime = new Date(Date.now() - 10 * 60_000).toISOString(); // 10m ago
      const payload = createSamplePayload({ timestamp: staleTime });
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'partner-hmac-v1',
        signature,
      };

      assert.throws(
        () => verifier.verify(envelope),
        (err: unknown) => {
          assert.ok(err instanceof EvidenceVerificationError);
          assert.equal(err.code, 'EVIDENCE_EXPIRED');
          return true;
        }
      );
    });

    it('rejects post-dated evidence beyond allowed clock skew', () => {
      const futureTime = new Date(Date.now() + 5 * 60_000).toISOString(); // 5m in future
      const payload = createSamplePayload({ timestamp: futureTime });
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'partner-hmac-v1',
        signature,
      };

      assert.throws(
        () => verifier.verify(envelope),
        (err: unknown) => {
          assert.ok(err instanceof EvidenceVerificationError);
          assert.equal(err.code, 'EVIDENCE_POST_DATED');
          return true;
        }
      );
    });
  });

  describe('Retry Path & Idempotent Replay Handling', () => {
    it('returns cached idempotent receipt with replayed=true on repeated submission', () => {
      const payload = createSamplePayload();
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'partner-hmac-v1',
        signature,
      };

      const firstReceipt = verifier.verify(envelope);
      assert.equal(firstReceipt.replayed, false);

      // Replay identical evidence (e.g. network retry)
      const secondReceipt = verifier.verify(envelope);
      assert.equal(secondReceipt.replayed, true);
      assert.equal(secondReceipt.evidenceId, firstReceipt.evidenceId);
      assert.equal(secondReceipt.canonicalDigestHex, firstReceipt.canonicalDigestHex);
    });
  });

  describe('Authorization & Trust Store Path', () => {
    it('rejects signers missing from the trust store', () => {
      const payload = createSamplePayload();
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'unknown-intruder-key',
        signature,
      };

      assert.throws(
        () => verifier.verify(envelope),
        (err: unknown) => {
          assert.ok(err instanceof EvidenceVerificationError);
          assert.equal(err.code, 'UNTRUSTED_SIGNER');
          assert.equal(err.httpStatus, 403);
          return true;
        }
      );
    });

    it('rejects revoked signer keys', () => {
      const payload = createSamplePayload();
      const signature = ExternalEvidenceVerifier.signHmac(payload, hmacSecret);

      const envelope: SignedEvidenceEnvelope = {
        payload,
        algorithm: 'hmac-sha256',
        signerKeyId: 'revoked-key-v1',
        signature,
      };

      assert.throws(
        () => verifier.verify(envelope),
        (err: unknown) => {
          assert.ok(err instanceof EvidenceVerificationError);
          assert.equal(err.code, 'REVOKED_SIGNER_KEY');
          assert.equal(err.httpStatus, 403);
          return true;
        }
      );
    });
  });
});
