/**
 * Cryptographic Verification for Imported External Evidence (Issue #277).
 *
 * Implements end-to-end cryptographic integrity, signature verification,
 * tamper detection, and replay defense for external settlement evidence,
 * third-party oracle attestations, and payment transaction proofs.
 *
 * Security Architecture:
 *  - Canonical Payload Hashing: RFC 8785 JSON canonicalization ensures identical
 *    lexicographical hash output regardless of key ordering or whitespace.
 *  - Dual Cryptographic Primitives: Supports Ed25519 public key signatures and
 *    HMAC-SHA256 partner oracle authenticators.
 *  - Freshness Window & Clock-Skew Protection: Rejects evidence older than
 *    `maxAgeMs` (default 10m) or post-dated into the future beyond permitted skew.
 *  - Deterministic Nonce Replay Defense: Tracks cryptographic evidence digests in
 *    an in-memory LRU / TTL replay cache to prevent replay of captured proofs.
 *  - Signer Identity Trust Store: Validates external signers against an authorized
 *    public key / certificate registry.
 */

import * as crypto from 'crypto';
import { canonicalizeJson } from './canonical-serialization';

export interface ExternalEvidencePayload {
  evidenceId: string;
  sourceSystem: string;
  transactionHash: string;
  invoiceId: string;
  amount: string;
  assetCode: string;
  ledgerSequence?: number;
  timestamp: string; // ISO8601
  nonce: string;
  metadata?: Record<string, unknown>;
}

export interface SignedEvidenceEnvelope {
  payload: ExternalEvidencePayload;
  algorithm: 'ed25519' | 'hmac-sha256';
  signerKeyId: string;
  signature: string; // hex or base64
}

export interface VerificationReceipt {
  verified: true;
  evidenceId: string;
  signerKeyId: string;
  algorithm: string;
  canonicalDigestHex: string;
  verifiedAt: string;
  replayed: boolean;
}

export interface SignerTrustStore {
  getSignerKey(keyId: string): { key: string; algorithm: 'ed25519' | 'hmac-sha256'; revoked?: boolean } | null;
}

export interface VerifierOptions {
  maxAgeMs?: number;
  allowedSkewMs?: number;
  trustStore: SignerTrustStore;
}

export class EvidenceVerificationError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'EvidenceVerificationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ExternalEvidenceVerifier {
  private readonly maxAgeMs: number;
  private readonly allowedSkewMs: number;
  private readonly trustStore: SignerTrustStore;
  private readonly seenDigests = new Map<string, { cachedAt: number; receipt: VerificationReceipt }>();

  constructor(options: VerifierOptions) {
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000; // 10 minutes
    this.allowedSkewMs = options.allowedSkewMs ?? 60_000; // 1 minute
    this.trustStore = options.trustStore;
  }

  /**
   * Computes the RFC 8785 canonical SHA-256 digest of an evidence payload.
   */
  static computeCanonicalDigest(payload: ExternalEvidencePayload): Buffer {
    const canonical = canonicalizeJson(payload);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest();
  }

  /**
   * Helper to sign an evidence payload using HMAC-SHA256 secret.
   */
  static signHmac(payload: ExternalEvidencePayload, secret: string): string {
    const canonical = canonicalizeJson(payload);
    return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  }

  /**
   * Helper to sign an evidence payload using Ed25519 private key.
   */
  static signEd25519(payload: ExternalEvidencePayload, privateKeyPemOrDer: string | crypto.KeyObject): string {
    const canonical = canonicalizeJson(payload);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPemOrDer);
    return signature.toString('hex');
  }

  /**
   * Cryptographically verifies an imported external evidence envelope.
   */
  verify(envelope: SignedEvidenceEnvelope, now: Date = new Date()): VerificationReceipt {
    if (!envelope || !envelope.payload || !envelope.signature || !envelope.signerKeyId) {
      throw new EvidenceVerificationError('MALFORMED_ENVELOPE', 'Missing required envelope fields.');
    }

    const { payload, algorithm, signerKeyId, signature } = envelope;

    // 1. Validate payload completeness
    if (!payload.evidenceId || !payload.transactionHash || !payload.invoiceId || !payload.amount || !payload.nonce) {
      throw new EvidenceVerificationError('INCOMPLETE_PAYLOAD', 'Evidence payload missing core fields.');
    }

    // 2. Validate timestamp freshness and skew
    const evidenceTime = Date.parse(payload.timestamp);
    if (isNaN(evidenceTime)) {
      throw new EvidenceVerificationError('INVALID_TIMESTAMP', 'Evidence timestamp is not valid ISO8601.');
    }
    const currentTime = now.getTime();
    if (evidenceTime > currentTime + this.allowedSkewMs) {
      throw new EvidenceVerificationError(
        'EVIDENCE_POST_DATED',
        'Evidence timestamp is in the future beyond acceptable skew.',
        400
      );
    }
    if (currentTime - evidenceTime > this.maxAgeMs) {
      throw new EvidenceVerificationError(
        'EVIDENCE_EXPIRED',
        'Evidence timestamp has expired beyond allowable window.',
        400
      );
    }

    // 3. Compute Canonical Digest
    const canonical = canonicalizeJson(payload);
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();
    const digestHex = digest.toString('hex');

    // 4. Replay Check / Idempotent Receipt
    this.evictStaleDigests(currentTime);
    const existing = this.seenDigests.get(digestHex);
    if (existing) {
      return {
        ...existing.receipt,
        replayed: true,
      };
    }

    // 5. Look up trusted signer
    const signer = this.trustStore.getSignerKey(signerKeyId);
    if (!signer) {
      throw new EvidenceVerificationError(
        'UNTRUSTED_SIGNER',
        `Signer key '${signerKeyId}' is not recognized or trusted.`,
        403
      );
    }
    if (signer.revoked) {
      throw new EvidenceVerificationError(
        'REVOKED_SIGNER_KEY',
        `Signer key '${signerKeyId}' has been revoked.`,
        403
      );
    }
    if (signer.algorithm !== algorithm) {
      throw new EvidenceVerificationError(
        'ALGORITHM_MISMATCH',
        `Signer key registered for '${signer.algorithm}' but envelope specified '${algorithm}'.`,
        400
      );
    }

    // 6. Signature Verification
    let isValid = false;
    try {
      if (algorithm === 'hmac-sha256') {
        const expectedHmac = crypto.createHmac('sha256', signer.key).update(canonical, 'utf8').digest();
        const incomingBuffer = Buffer.from(signature, 'hex');
        if (incomingBuffer.length === expectedHmac.length && crypto.timingSafeEqual(incomingBuffer, expectedHmac)) {
          isValid = true;
        }
      } else if (algorithm === 'ed25519') {
        const sigBuffer = Buffer.from(signature, 'hex');
        isValid = crypto.verify(null, Buffer.from(canonical, 'utf8'), signer.key, sigBuffer);
      }
    } catch (err) {
      throw new EvidenceVerificationError(
        'SIGNATURE_VERIFICATION_FAILED',
        `Cryptographic verification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!isValid) {
      throw new EvidenceVerificationError(
        'INVALID_SIGNATURE',
        'Cryptographic signature does not match canonical payload.'
      );
    }

    // 7. Record in replay cache
    const receipt: VerificationReceipt = {
      verified: true,
      evidenceId: payload.evidenceId,
      signerKeyId,
      algorithm,
      canonicalDigestHex: digestHex,
      verifiedAt: now.toISOString(),
      replayed: false,
    };

    this.seenDigests.set(digestHex, {
      cachedAt: currentTime,
      receipt,
    });

    return receipt;
  }

  private evictStaleDigests(currentTime: number): void {
    const threshold = currentTime - this.maxAgeMs * 2;
    for (const [key, value] of this.seenDigests.entries()) {
      if (value.cachedAt < threshold) {
        this.seenDigests.delete(key);
      }
    }
  }
}
