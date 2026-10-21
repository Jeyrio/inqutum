/**
 * Signed administrative action approvals (#196).
 *
 * A protected action runs only when the caller presents enough valid, unused
 * approvals for exactly that action. An approval is a small signed document:
 *
 *   { id, action, target, paramsHash, actor, signer, reason, issuedAt, expiresAt, signature }
 *
 *   actor   the one maintainer allowed to execute with it (an approval for
 *           someone else is useless to anyone who steals it)
 *   signer  the maintainer who approved; never the actor, and each signer counts once
 *
 * `runProtected` verifies, in order: enough approvals -> signature -> action,
 * target, params and actor match -> not expired -> not self-signed or duplicated
 * -> not already used. Only after every approval passes are they burned (single
 * use) and the executor invoked, so a rejected request never consumes anything.
 * An approval stays burned even if the executor then fails: retrying needs a
 * fresh approval, which keeps the audit trail one-approval-one-attempt.
 *
 * This complements `maintainer-approval.ts` (intent/receipt workflow): that
 * module tracks a long-lived request, this one gates a single call and works for
 * any action in `PROTECTED_ACTIONS`. See docs/SIGNED_APPROVALS.md.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { canonicalize } from '../security/canonical-serialization';

export interface ProtectedActionSpec {
  action: string;
  description: string;
  /** Distinct signers needed (2 = multi-step confirmation). */
  requiredSigners: number;
  /** Longest an approval for this action may live. */
  maxTtlMs: number;
}

/** The maintainer actions that change or expose data for other people. */
export const PROTECTED_ACTIONS: Readonly<Record<string, ProtectedActionSpec>> = Object.freeze({
  'invoice.cancel': { action: 'invoice.cancel', description: 'Cancel a seller invoice on their behalf', requiredSigners: 1, maxTtlMs: 30 * 60_000 },
  'invoice.archive': { action: 'invoice.archive', description: 'Archive a terminal invoice', requiredSigners: 1, maxTtlMs: 30 * 60_000 },
  'invoice.restore': { action: 'invoice.restore', description: 'Restore an archived invoice', requiredSigners: 1, maxTtlMs: 30 * 60_000 },
  'job.requeue_dead': { action: 'job.requeue_dead', description: 'Requeue a dead-lettered job', requiredSigners: 1, maxTtlMs: 15 * 60_000 },
  'config.change': { action: 'config.change', description: 'Change audited runtime configuration', requiredSigners: 2, maxTtlMs: 15 * 60_000 },
  'ownership.transfer': { action: 'ownership.transfer', description: 'Transfer ownership of a resource', requiredSigners: 2, maxTtlMs: 60 * 60_000 },
});

export type ApprovalFailureCode =
  | 'UNKNOWN_ACTION'
  | 'INVALID_REQUEST'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_SIGNATURE_INVALID'
  | 'APPROVAL_ACTION_MISMATCH'
  | 'APPROVAL_TARGET_MISMATCH'
  | 'APPROVAL_PARAMS_MISMATCH'
  | 'APPROVAL_ACTOR_MISMATCH'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_SELF_SIGNED'
  | 'APPROVAL_DUPLICATE_SIGNER'
  | 'APPROVAL_REPLAYED';

const STATUS: Record<ApprovalFailureCode, number> = {
  UNKNOWN_ACTION: 400,
  INVALID_REQUEST: 400,
  APPROVAL_REQUIRED: 403,
  APPROVAL_SIGNATURE_INVALID: 403,
  APPROVAL_ACTION_MISMATCH: 403,
  APPROVAL_TARGET_MISMATCH: 403,
  APPROVAL_PARAMS_MISMATCH: 403,
  APPROVAL_ACTOR_MISMATCH: 403,
  APPROVAL_EXPIRED: 410,
  APPROVAL_SELF_SIGNED: 403,
  APPROVAL_DUPLICATE_SIGNER: 403,
  APPROVAL_REPLAYED: 409,
};

export class SignedApprovalError extends Error {
  readonly httpStatus: number;
  constructor(public readonly code: ApprovalFailureCode, message: string) {
    super(message);
    this.name = 'SignedApprovalError';
    this.httpStatus = STATUS[code];
  }
}

export interface SignedApproval {
  id: string;
  action: string;
  target: string;
  paramsHash: string;
  actor: string;
  signer: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface ApprovalAuditRecord {
  type: 'APPROVAL_ISSUED' | 'APPROVAL_CONSUMED' | 'APPROVAL_REJECTED' | 'PROTECTED_ACTION_EXECUTED' | 'PROTECTED_ACTION_FAILED';
  action: string;
  target: string;
  actor: string;
  at: string;
  approvalIds: string[];
  signers: string[];
  code?: ApprovalFailureCode;
  detail?: string;
}

/** Tracks burned approval ids. Swap for a shared store if more than one process verifies approvals. */
export interface ApprovalUseStore {
  /** Atomically marks used; false if it already was. */
  markUsed(id: string, expiresAt: Date): boolean;
  isUsed(id: string): boolean;
}

export class MemoryApprovalUseStore implements ApprovalUseStore {
  private readonly used = new Map<string, number>();

  markUsed(id: string, expiresAt: Date): boolean {
    if (this.used.has(id)) return false;
    this.used.set(id, expiresAt.getTime());
    return true;
  }

  isUsed(id: string): boolean {
    return this.used.has(id);
  }

  /** Forget ids whose approval has expired anyway: an expired approval is rejected before the replay check. */
  prune(now: Date): number {
    let removed = 0;
    for (const [id, exp] of this.used) {
      if (exp <= now.getTime()) {
        this.used.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

export interface SignedApprovalServiceOptions {
  secret: string;
  now?: () => Date;
  actions?: Readonly<Record<string, ProtectedActionSpec>>;
  store?: ApprovalUseStore;
  /** Audit sink; failures are swallowed. */
  onAudit?: (record: ApprovalAuditRecord) => void;
}

export interface IssueApprovalInput {
  action: string;
  target: string;
  /** The maintainer who will execute. */
  actor: string;
  signer: string;
  reason: string;
  params?: Record<string, unknown>;
  ttlMs?: number;
}

export interface RunProtectedInput {
  action: string;
  target: string;
  actor: string;
  params?: Record<string, unknown>;
  approvals: SignedApproval[] | undefined;
}

export const hashParams = (params: Record<string, unknown> = {}): string =>
  createHash('sha256').update(canonicalize(params)).digest('hex');

export class SignedApprovalService {
  private readonly now: () => Date;
  private readonly actions: Readonly<Record<string, ProtectedActionSpec>>;
  private readonly store: ApprovalUseStore;

  constructor(private readonly options: SignedApprovalServiceOptions) {
    if (!options.secret || options.secret.length < 16) {
      throw new Error('SignedApprovalService requires a secret of at least 16 characters');
    }
    this.now = options.now ?? (() => new Date());
    this.actions = options.actions ?? PROTECTED_ACTIONS;
    this.store = options.store ?? new MemoryApprovalUseStore();
  }

  isProtected(action: string): boolean {
    return Boolean(this.actions[action]);
  }

  spec(action: string): ProtectedActionSpec | null {
    return this.actions[action] ?? null;
  }

  private payload(a: Omit<SignedApproval, 'signature'>): string {
    return canonicalize({
      id: a.id, action: a.action, target: a.target, paramsHash: a.paramsHash, actor: a.actor,
      signer: a.signer, reason: a.reason, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
    });
  }

  private sign(a: Omit<SignedApproval, 'signature'>): string {
    return createHmac('sha256', this.options.secret).update(this.payload(a)).digest('hex');
  }

  private signatureValid(a: SignedApproval): boolean {
    if (typeof a.signature !== 'string') return false;
    const { signature, ...rest } = a;
    const expected = Buffer.from(this.sign(rest));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private audit(record: Omit<ApprovalAuditRecord, 'at'>): void {
    try {
      this.options.onAudit?.({ ...record, at: this.now().toISOString() });
    } catch {
      // An audit sink must never change the outcome of an approval decision.
    }
  }

  /** Called by an authenticated maintainer-facing route; the route is responsible for authenticating `signer`. */
  issue(input: IssueApprovalInput): SignedApproval {
    const spec = this.actions[input.action];
    if (!spec) throw new SignedApprovalError('UNKNOWN_ACTION', `${input.action} is not a protected action`);
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const target = text(input.target);
    const actor = text(input.actor);
    const signer = text(input.signer);
    const reason = text(input.reason);
    if (!target || !actor || !signer) throw new SignedApprovalError('INVALID_REQUEST', 'target, actor and signer are required');
    if (reason.length < 10) throw new SignedApprovalError('INVALID_REQUEST', 'reason must explain the approval (min 10 chars)');
    if (signer === actor) throw new SignedApprovalError('APPROVAL_SELF_SIGNED', 'Approvals must be signed by someone other than the executing actor');
    const ttl = input.ttlMs ?? spec.maxTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > spec.maxTtlMs) {
      throw new SignedApprovalError('INVALID_REQUEST', `ttlMs must be between 1 and ${spec.maxTtlMs}`);
    }
    const issued = this.now();
    const body: Omit<SignedApproval, 'signature'> = {
      id: randomUUID(),
      action: spec.action,
      target,
      paramsHash: hashParams(input.params),
      actor,
      signer,
      reason,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + ttl).toISOString(),
    };
    const approval: SignedApproval = { ...body, signature: this.sign(body) };
    this.audit({ type: 'APPROVAL_ISSUED', action: spec.action, target, actor, approvalIds: [approval.id], signers: [signer] });
    return approval;
  }

  /** Checks without consuming anything. Throws SignedApprovalError on the first problem. */
  verify(input: RunProtectedInput): ProtectedActionSpec {
    const spec = this.actions[input.action];
    if (!spec) throw new SignedApprovalError('UNKNOWN_ACTION', `${input.action} is not a protected action`);
    const approvals = Array.isArray(input.approvals) ? input.approvals : [];
    if (approvals.length === 0) {
      throw new SignedApprovalError('APPROVAL_REQUIRED', `${input.action} needs ${spec.requiredSigners} signed approval(s)`);
    }
    const paramsHash = hashParams(input.params);
    const signers = new Set<string>();
    const ids = new Set<string>();
    const now = this.now().getTime();

    for (const a of approvals) {
      if (!a || typeof a !== 'object' || !this.signatureValid(a)) {
        throw new SignedApprovalError('APPROVAL_SIGNATURE_INVALID', 'Approval signature does not verify');
      }
      if (a.action !== input.action) throw new SignedApprovalError('APPROVAL_ACTION_MISMATCH', 'Approval was issued for a different action');
      if (a.target !== input.target) throw new SignedApprovalError('APPROVAL_TARGET_MISMATCH', 'Approval was issued for a different target');
      if (a.paramsHash !== paramsHash) throw new SignedApprovalError('APPROVAL_PARAMS_MISMATCH', 'Parameters differ from what was approved');
      if (a.actor !== input.actor) throw new SignedApprovalError('APPROVAL_ACTOR_MISMATCH', 'Approval was issued to a different actor');
      if (now >= new Date(a.expiresAt).getTime()) throw new SignedApprovalError('APPROVAL_EXPIRED', 'Approval has expired');
      if (a.signer === input.actor) throw new SignedApprovalError('APPROVAL_SELF_SIGNED', 'Approvals must be signed by someone other than the executing actor');
      if (signers.has(a.signer) || ids.has(a.id)) {
        throw new SignedApprovalError('APPROVAL_DUPLICATE_SIGNER', 'Each signer can approve a given action only once');
      }
      if (this.store.isUsed(a.id)) throw new SignedApprovalError('APPROVAL_REPLAYED', 'Approval has already been used');
      signers.add(a.signer);
      ids.add(a.id);
    }
    if (signers.size < spec.requiredSigners) {
      throw new SignedApprovalError('APPROVAL_REQUIRED', `${input.action} needs ${spec.requiredSigners} distinct signers; got ${signers.size}`);
    }
    return spec;
  }

  async runProtected<T>(input: RunProtectedInput, executor: () => Promise<T> | T): Promise<T> {
    const base = { action: input.action, target: input.target, actor: input.actor };
    const ids = (Array.isArray(input.approvals) ? input.approvals : []).map((a) => a?.id).filter(Boolean) as string[];
    const signers = (Array.isArray(input.approvals) ? input.approvals : []).map((a) => a?.signer).filter(Boolean) as string[];

    try {
      this.verify(input);
    } catch (err) {
      if (err instanceof SignedApprovalError) {
        this.audit({ type: 'APPROVAL_REJECTED', ...base, approvalIds: ids, signers, code: err.code, detail: err.message });
      }
      throw err;
    }

    // Burn every approval before running; the check-and-set is synchronous so a concurrent call cannot reuse them.
    const burned: string[] = [];
    for (const a of input.approvals as SignedApproval[]) {
      if (!this.store.markUsed(a.id, new Date(a.expiresAt))) {
        const err = new SignedApprovalError('APPROVAL_REPLAYED', 'Approval has already been used');
        this.audit({ type: 'APPROVAL_REJECTED', ...base, approvalIds: ids, signers, code: err.code, detail: err.message });
        throw err;
      }
      burned.push(a.id);
    }
    this.audit({ type: 'APPROVAL_CONSUMED', ...base, approvalIds: burned, signers });

    try {
      const result = await executor();
      this.audit({ type: 'PROTECTED_ACTION_EXECUTED', ...base, approvalIds: burned, signers });
      return result;
    } catch (err) {
      this.audit({
        type: 'PROTECTED_ACTION_FAILED', ...base, approvalIds: burned, signers,
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
      });
      throw err;
    }
  }
}

export function signedApprovalServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Partial<SignedApprovalServiceOptions> = {}
): SignedApprovalService | null {
  const secret = env.SIGNED_APPROVAL_SECRET;
  if (!secret || secret.length < 16) return null;
  return new SignedApprovalService({ ...options, secret });
}
