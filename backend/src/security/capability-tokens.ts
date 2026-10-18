/**
 * Expiring capability tokens for sensitive actions (#285).
 *
 * The admin bearer token (JOBS_ADMIN_TOKEN) is long lived and shared, so it is
 * a poor credential for actions whose effect is immediate and global. A
 * sensitive action additionally requires a capability: a short-lived, signed,
 * single-use grant for exactly one action on exactly one target, minted for a
 * named maintainer.
 *
 * Format: `qcap.v1.<base64url(claims JSON)>.<base64url(HMAC-SHA256)>`.
 *
 *  - One algorithm, fixed by the version prefix. There is no `alg` header to
 *    trust, which rules out the algorithm-substitution and `none` attacks
 *    described in RFC 8725 §2.1.
 *  - Explicit typing (`typ: 'qcap'`) and a key of its own
 *    (CAPABILITY_TOKEN_SECRET) keep these tokens from being confused with any
 *    other signed value in the system (RFC 8725 §3.11, §3.12).
 *  - The signature is checked with a constant-time compare before the claims
 *    are parsed, so unauthenticated input never reaches JSON.parse.
 *  - Scope (action + target) plays the role of a JWT audience: a capability for
 *    one flag cannot change another.
 *
 * Single use with safe retries: `use()` reserves the capability id, runs the
 * action, then commits (burned until expiry) on success or releases on failure.
 * A request that fails validation or hits a transient error can be retried with
 * the same capability; a concurrent duplicate is refused while the first is in
 * flight; a capability that already succeeded can never run again.
 *
 * Issuing is stateless. Only reserved/used ids are held, each until its expiry,
 * so memory is bounded by the issuance rate times the maximum TTL. When the
 * ledger is full of live entries the service fails closed instead of evicting:
 * evicting a used id would make it replayable.
 *
 * See docs/CAPABILITY_TOKENS.md.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

export interface SensitiveActionSpec {
  description: string;
  defaultTtlMs: number;
  maxTtlMs: number;
}

export const SENSITIVE_ACTIONS = {
  'config.feature_flag.set': {
    description: 'Set or clear a runtime feature-flag override (target: flag name)',
    defaultTtlMs: 5 * 60_000,
    maxTtlMs: 15 * 60_000,
  },
} as const satisfies Record<string, SensitiveActionSpec>;

export type SensitiveAction = keyof typeof SENSITIVE_ACTIONS;

/** Own keys only, so inherited names like `__proto__` or `toString` are never actions. */
const actionSpec = (action: unknown): SensitiveActionSpec | undefined =>
  typeof action === 'string' && Object.hasOwn(SENSITIVE_ACTIONS, action)
    ? SENSITIVE_ACTIONS[action as SensitiveAction]
    : undefined;

export interface CapabilityClaims {
  typ: 'qcap';
  v: 1;
  /** Single-use identifier. Safe to log and audit; the token itself is not. */
  id: string;
  action: SensitiveAction;
  target: string;
  /** Maintainer the capability was minted for; recorded as the actor. */
  subject: string;
  /** Epoch milliseconds. */
  iat: number;
  exp: number;
}

export interface CapabilityScope {
  action: SensitiveAction;
  target: string;
}

export type CapabilityErrorCode =
  | 'CAPABILITY_REQUEST_INVALID'
  | 'UNKNOWN_CAPABILITY_ACTION'
  | 'CAPABILITY_REQUIRED'
  | 'CAPABILITY_MALFORMED'
  | 'CAPABILITY_INVALID'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_SCOPE_MISMATCH'
  | 'CAPABILITY_IN_USE'
  | 'CAPABILITY_ALREADY_USED'
  | 'CAPABILITY_LEDGER_FULL';

const HTTP_STATUS: Record<CapabilityErrorCode, number> = {
  CAPABILITY_REQUEST_INVALID: 400,
  UNKNOWN_CAPABILITY_ACTION: 400,
  CAPABILITY_REQUIRED: 401,
  CAPABILITY_MALFORMED: 401,
  CAPABILITY_INVALID: 401,
  CAPABILITY_EXPIRED: 401,
  CAPABILITY_SCOPE_MISMATCH: 403,
  CAPABILITY_IN_USE: 409,
  CAPABILITY_ALREADY_USED: 409,
  CAPABILITY_LEDGER_FULL: 503,
};

export class CapabilityError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: CapabilityErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** RFC 2104: HMAC keys shorter than the hash output (32 bytes for SHA-256) are discouraged. */
export const MIN_CAPABILITY_SECRET_LENGTH = 32;
const PREFIX = 'qcap.v1';
const MAX_TOKEN_LENGTH = 1024;
const MAX_FIELD_LENGTH = 128;
const MIN_TTL_MS = 1_000;
/** Tolerated issuer/verifier clock difference when several instances share a secret. */
const CLOCK_SKEW_MS = 30_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface CapabilityServiceOptions {
  secret: string;
  now?: () => Date;
  /** Maximum reserved/used ids held at once. */
  ledgerCapacity?: number;
}

type LedgerEntry = { state: 'reserved' | 'used'; exp: number };

export class CapabilityTokenService {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly now: () => Date;
  private readonly capacity: number;

  constructor(private readonly options: CapabilityServiceOptions) {
    if (!options.secret || options.secret.length < MIN_CAPABILITY_SECRET_LENGTH) {
      throw new Error(`CapabilityTokenService requires a secret of at least ${MIN_CAPABILITY_SECRET_LENGTH} characters`);
    }
    this.now = options.now ?? (() => new Date());
    this.capacity = options.ledgerCapacity ?? 10_000;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.options.secret).update(body).digest('base64url');
  }

  /** O(1). Nothing is stored until the capability is used. */
  issue(input: { action: string; target: string; subject: string; ttlMs?: number }): { token: string; claims: CapabilityClaims } {
    const spec = actionSpec(input.action);
    if (!spec) {
      throw new CapabilityError('UNKNOWN_CAPABILITY_ACTION', `Unknown sensitive action "${input.action}". Use one of: ${Object.keys(SENSITIVE_ACTIONS).join(', ')}`);
    }
    const target = String(input.target ?? '').trim();
    const subject = String(input.subject ?? '').trim();
    if (!target || target.length > MAX_FIELD_LENGTH) {
      throw new CapabilityError('CAPABILITY_REQUEST_INVALID', `target is required (max ${MAX_FIELD_LENGTH} characters)`);
    }
    if (!subject || subject.length > MAX_FIELD_LENGTH) {
      throw new CapabilityError('CAPABILITY_REQUEST_INVALID', `subject is required (max ${MAX_FIELD_LENGTH} characters)`);
    }
    const ttlMs = input.ttlMs ?? spec.defaultTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > spec.maxTtlMs) {
      throw new CapabilityError('CAPABILITY_REQUEST_INVALID', `ttl must be between ${MIN_TTL_MS / 1000} and ${spec.maxTtlMs / 1000} seconds`);
    }

    const iat = this.now().getTime();
    const claims: CapabilityClaims = {
      typ: 'qcap',
      v: 1,
      id: randomUUID(),
      action: input.action as SensitiveAction,
      target,
      subject,
      iat,
      exp: iat + ttlMs,
    };
    const body = `${PREFIX}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
    return { token: `${body}.${this.sign(body)}`, claims };
  }

  /**
   * Stateless checks, in a fixed order so every caller reports the same first
   * failure: presence -> shape -> signature -> claims -> expiry -> scope.
   */
  verify(token: unknown, scope: CapabilityScope): CapabilityClaims {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new CapabilityError('CAPABILITY_REQUIRED', 'This action requires a capability token in the X-Capability-Token header');
    }
    const parts = token.trim().split('.');
    if (
      token.length > MAX_TOKEN_LENGTH ||
      parts.length !== 4 ||
      `${parts[0]}.${parts[1]}` !== PREFIX ||
      !BASE64URL.test(parts[2]) ||
      !BASE64URL.test(parts[3])
    ) {
      throw new CapabilityError('CAPABILITY_MALFORMED', 'Capability token is malformed');
    }

    const expected = Buffer.from(this.sign(`${PREFIX}.${parts[2]}`));
    const given = Buffer.from(parts[3]);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new CapabilityError('CAPABILITY_INVALID', 'Capability token signature does not verify');
    }

    const claims = parseClaims(parts[2]);
    const now = this.now().getTime();
    if (!claims || claims.iat - now > CLOCK_SKEW_MS) {
      throw new CapabilityError('CAPABILITY_INVALID', 'Capability token claims are invalid');
    }
    if (now >= claims.exp) {
      throw new CapabilityError('CAPABILITY_EXPIRED', 'Capability token has expired; issue a new one');
    }
    if (claims.action !== scope.action || claims.target !== scope.target) {
      throw new CapabilityError('CAPABILITY_SCOPE_MISMATCH', `Capability is for ${claims.action} on "${claims.target}", not ${scope.action} on "${scope.target}"`);
    }
    return claims;
  }

  /**
   * Verify, reserve, run, then commit on success or release on failure.
   * The reservation is taken synchronously, so two concurrent calls with the
   * same capability cannot both reach `action`.
   */
  async use<T>(token: unknown, scope: CapabilityScope, action: (claims: CapabilityClaims) => T | Promise<T>): Promise<T> {
    const claims = this.verify(token, scope);
    this.reserve(claims);
    try {
      const result = await action(claims);
      this.ledger.set(claims.id, { state: 'used', exp: claims.exp });
      return result;
    } catch (err) {
      this.ledger.delete(claims.id);
      throw err;
    }
  }

  /** Amortised O(1): the O(capacity) sweep runs only when the ledger is full. */
  private reserve(claims: CapabilityClaims): void {
    const entry = this.ledger.get(claims.id);
    if (entry?.state === 'used') {
      throw new CapabilityError('CAPABILITY_ALREADY_USED', 'Capability was already used; issue a new one');
    }
    if (entry?.state === 'reserved') {
      throw new CapabilityError('CAPABILITY_IN_USE', 'Capability is being used by another request; retry when it completes');
    }
    if (this.ledger.size >= this.capacity) {
      const now = this.now().getTime();
      for (const [id, e] of this.ledger) {
        if (e.exp <= now) this.ledger.delete(id);
      }
      if (this.ledger.size >= this.capacity) {
        throw new CapabilityError('CAPABILITY_LEDGER_FULL', 'Too many live capabilities; retry after the oldest expire');
      }
    }
    this.ledger.set(claims.id, { state: 'reserved', exp: claims.exp });
  }
}

/** Shape check of signed claims; null means "signed by this key but not a capability". */
function parseClaims(encoded: string): CapabilityClaims | null {
  let raw: any;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const spec = actionSpec(raw?.action);
  const valid =
    raw?.typ === 'qcap' &&
    raw.v === 1 &&
    typeof raw.id === 'string' &&
    typeof raw.target === 'string' &&
    typeof raw.subject === 'string' &&
    Number.isSafeInteger(raw.iat) &&
    Number.isSafeInteger(raw.exp) &&
    spec !== undefined &&
    raw.exp > raw.iat &&
    raw.exp - raw.iat <= spec.maxTtlMs;
  return valid ? (raw as CapabilityClaims) : null;
}

/** Process capability service, or null when CAPABILITY_TOKEN_SECRET is unset or too short. */
export function capabilityServiceFromEnv(env: NodeJS.ProcessEnv = process.env): CapabilityTokenService | null {
  const secret = env.CAPABILITY_TOKEN_SECRET;
  return secret && secret.length >= MIN_CAPABILITY_SECRET_LENGTH ? new CapabilityTokenService({ secret }) : null;
}
