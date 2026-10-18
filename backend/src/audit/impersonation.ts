/**
 * Scoped, time-limited maintainer impersonation for support debugging (#76).
 *
 * A maintainer can open a session against a seller's wallet to reproduce a
 * reported issue. The design is deliberately restrictive:
 *
 *  - **Scoped** — every session carries an explicit permission set and defaults
 *    to read-only. Irreversible actions (settlement, cancellation, purge) are
 *    refused unless the session was opened with the `elevated` permission.
 *  - **Time-limited** — sessions expire (default 30 minutes, hard cap 60) and
 *    expiry is enforced lazily on read, so a forgotten session cannot stay open.
 *  - **Audited** — start, end, expiry, allowed and blocked actions all write to
 *    the audit trail with the impersonated target recorded, so support
 *    debugging is reconstructable after the fact.
 *
 * Nothing here grants implicit authority: a caller with no active session can
 * never be authorized.
 */

import { MemoryAuditStore, auditStore } from './audit-service';

export type ImpersonationPermission =
  | 'read'
  | 'simulate'
  | 'export'
  | 'notify'
  | 'elevated';

export const IMPERSONATION_PERMISSIONS: readonly ImpersonationPermission[] = [
  'read',
  'simulate',
  'export',
  'notify',
  'elevated',
] as const;

export const DEFAULT_SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Actions that change state irreversibly or reach beyond the seller's own
 * data. These require the `elevated` permission on top of an active session.
 */
export const ELEVATED_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'invoice.cancel',
  'invoice.settle',
  'invoice.delete',
  'payment.verify',
  'payment.refund',
  'jobs.purge',
  'maintenance.reset',
]);

/** Actions that are never permitted through impersonation, elevated or not. */
export const NEVER_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'impersonation.start',
  'impersonation.elevate',
]);

export interface ImpersonationSession {
  id: string;
  maintainerId: string;
  targetId: string;
  permissions: ImpersonationPermission[];
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt?: string;
  endReason?: 'manual' | 'expired';
}

export interface AuthorizationDecision {
  allowed: boolean;
  /** Stable machine-readable reason for the caller and the audit trail. */
  code:
    | 'ALLOWED'
    | 'NO_ACTIVE_SESSION'
    | 'SESSION_EXPIRED'
    | 'SESSION_ENDED'
    | 'MISSING_PERMISSION'
    | 'ELEVATION_REQUIRED'
    | 'NEVER_ALLOWED';
  reason: string;
  sessionId?: string;
}

export interface ImpersonationIndicator {
  active: boolean;
  /** Copy for the persistent UI banner shown to the maintainer while active. */
  banner?: string;
  session?: ImpersonationSession;
}

export interface StartSessionInput {
  maintainerId: string;
  targetId: string;
  permissions?: ImpersonationPermission[];
  reason: string;
  durationMs?: number;
  ip?: string;
  userAgent?: string;
}

export interface AuthorizeInput {
  maintainerId: string;
  action: string;
  /** True when the caller has completed the elevated-confirmation step. */
  elevatedConfirmation?: boolean;
  ip?: string;
  userAgent?: string;
}

interface ImpersonationServiceOptions {
  now?: () => number;
  audit?: MemoryAuditStore;
  maxSessions?: number;
  randomId?: () => string;
}

export class ImpersonationService {
  private readonly sessions = new Map<string, ImpersonationSession>();
  private readonly now: () => number;
  private readonly audit: MemoryAuditStore;
  private readonly maxSessions: number;
  private readonly randomId: () => string;
  private idCounter = 0;

  constructor(options: ImpersonationServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.audit = options.audit ?? auditStore;
    this.maxSessions = options.maxSessions ?? 100;
    this.randomId =
      options.randomId ??
      (() => `imp_${Date.now().toString(36)}_${(this.idCounter++).toString(36)}`);
  }

  /**
   * Opens a session. Rejects unknown permissions, an over-cap duration, an
   * empty justification, and impersonating yourself — a maintainer debugging
   * their own account has no need for the session's reduced permission set.
   */
  startSession(input: StartSessionInput): ImpersonationSession {
    if (!input.maintainerId?.trim()) throw new Error('maintainerId is required');
    if (!input.targetId?.trim()) throw new Error('targetId is required');
    if (!input.reason?.trim()) {
      throw new Error('A justification is required to start an impersonation session');
    }
    if (input.maintainerId === input.targetId) {
      throw new Error('Cannot impersonate yourself');
    }

    const requested = input.permissions ?? ['read'];
    for (const permission of requested) {
      if (!IMPERSONATION_PERMISSIONS.includes(permission)) {
        throw new Error(`Unknown impersonation permission: ${permission}`);
      }
    }

    const duration = Math.min(
      input.durationMs ?? DEFAULT_SESSION_DURATION_MS,
      MAX_SESSION_DURATION_MS,
    );
    if (duration <= 0) throw new Error('durationMs must be positive');

    const startedAtMs = this.now();
    const session: ImpersonationSession = {
      id: this.randomId(),
      maintainerId: input.maintainerId,
      targetId: input.targetId,
      permissions: Array.from(new Set(requested)),
      reason: input.reason.trim(),
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(startedAtMs + duration).toISOString(),
    };

    this.sessions.set(session.id, session);
    this.evictOldestIfNeeded();

    this.audit.recordEvent({
      action: 'IMPERSONATION_STARTED',
      actor: {
        type: 'maintainer',
        id: input.maintainerId,
        ip: input.ip,
        userAgent: input.userAgent,
      },
      scope: { entityType: 'system', entityId: session.id },
      reason: session.reason,
      afterState: { ...session, permissions: session.permissions },
      metadata: {
        impersonatedId: session.targetId,
        permissions: session.permissions.join(','),
        durationMs: duration,
        expiresAt: session.expiresAt,
      },
    });

    return session;
  }

  /**
   * Returns the maintainer's active session, expiring it on read. An expired
   * session is closed and audited the first time it is observed.
   */
  getActiveSession(maintainerId: string): ImpersonationSession | null {
    const nowMs = this.now();
    for (const session of this.sessions.values()) {
      if (session.maintainerId !== maintainerId) continue;
      if (session.endedAt) return null;
      if (this.expireIfDue(session, nowMs)) return null;
      return session;
    }
    return null;
  }

  /** Closes a session early. Returns false when the session is unknown/already closed. */
  endSession(sessionId: string, maintainerId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.endedAt) return false;
    if (maintainerId && session.maintainerId !== maintainerId) return false;

    session.endedAt = new Date(this.now()).toISOString();
    session.endReason = 'manual';

    this.audit.recordEvent({
      action: 'IMPERSONATION_ENDED',
      actor: { type: 'maintainer', id: session.maintainerId },
      scope: { entityType: 'system', entityId: session.id },
      reason: session.reason,
      afterState: { endedAt: session.endedAt, endReason: 'manual' },
      metadata: { impersonatedId: session.targetId },
    });

    return true;
  }

  /**
   * Decides whether an action is allowed inside an active session. Denials are
   * audited too — a maintainer repeatedly attempting blocked actions is exactly
   * the signal a support lead wants to see.
   */
  authorize(input: AuthorizeInput): AuthorizationDecision {
    if (NEVER_ALLOWED_ACTIONS.has(input.action)) {
      return this.deny(input, 'NEVER_ALLOWED', `"${input.action}" is never permitted via impersonation`, undefined);
    }

    const session = this.getActiveSession(input.maintainerId);
    if (!session) {
      const ended = this.findClosedSession(input.maintainerId);
      const code = ended?.endReason === 'expired' ? 'SESSION_EXPIRED' : ended ? 'SESSION_ENDED' : 'NO_ACTIVE_SESSION';
      return this.deny(input, code, 'No active impersonation session', ended?.id);
    }

    const needsElevation = ELEVATED_ONLY_ACTIONS.has(input.action);
    if (needsElevation && !session.permissions.includes('elevated')) {
      return this.deny(
        input,
        'ELEVATION_REQUIRED',
        `"${input.action}" is irreversible and needs an elevated session`,
        session.id,
      );
    }

    if (needsElevation && !input.elevatedConfirmation) {
      return this.deny(
        input,
        'ELEVATION_REQUIRED',
        `"${input.action}" requires explicit elevated confirmation`,
        session.id,
      );
    }

    this.audit.recordEvent({
      action: 'IMPERSONATION_ACTION_ALLOWED',
      actor: { type: 'maintainer', id: session.maintainerId, ip: input.ip, userAgent: input.userAgent },
      scope: { entityType: 'system', entityId: session.id },
      reason: session.reason,
      afterState: { action: input.action },
      metadata: {
        impersonatedId: session.targetId,
        action: input.action,
        elevated: needsElevation,
      },
    });

    return {
      allowed: true,
      code: 'ALLOWED',
      reason: needsElevation
        ? `Allowed with elevated confirmation: ${input.action}`
        : `Allowed within session scope: ${input.action}`,
      sessionId: session.id,
    };
  }

  /** Payload for the always-visible maintainer banner. */
  indicator(maintainerId: string): ImpersonationIndicator {
    const session = this.getActiveSession(maintainerId);
    if (!session) return { active: false };
    return {
      active: true,
      session,
      banner:
        `Impersonating ${session.targetId} — read-only support session, ` +
        `expires ${session.expiresAt}`,
    };
  }

  listSessions(includeClosed = true): ImpersonationSession[] {
    const nowMs = this.now();
    for (const session of this.sessions.values()) this.expireIfDue(session, nowMs);
    const all = Array.from(this.sessions.values()).filter((s) => includeClosed || !s.endedAt);
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Closes every session past its expiry. Returns the ids that were expired. */
  purgeExpired(): string[] {
    const nowMs = this.now();
    const expired: string[] = [];
    for (const session of this.sessions.values()) {
      if (!session.endedAt && this.expireIfDue(session, nowMs)) {
        expired.push(session.id);
      }
    }
    return expired;
  }

  clear(): void {
    this.sessions.clear();
  }

  private deny(
    input: AuthorizeInput,
    code: AuthorizationDecision['code'],
    reason: string,
    sessionId?: string,
  ): AuthorizationDecision {
    this.audit.recordEvent({
      action: 'IMPERSONATION_ACTION_BLOCKED',
      actor: { type: 'maintainer', id: input.maintainerId, ip: input.ip, userAgent: input.userAgent },
      scope: { entityType: 'system', entityId: sessionId ?? 'none' },
      reason,
      metadata: { action: input.action, code, sessionId },
    });
    return { allowed: false, code, reason, sessionId };
  }

  private expireIfDue(session: ImpersonationSession, nowMs: number): boolean {
    if (session.endedAt) return false;
    if (new Date(session.expiresAt).getTime() > nowMs) return false;

    session.endedAt = new Date(nowMs).toISOString();
    session.endReason = 'expired';

    this.audit.recordEvent({
      action: 'IMPERSONATION_EXPIRED',
      actor: { type: 'maintainer', id: session.maintainerId },
      scope: { entityType: 'system', entityId: session.id },
      reason: 'Session reached its time limit',
      afterState: { endedAt: session.endedAt, endReason: 'expired' },
      metadata: { impersonatedId: session.targetId, expiresAt: session.expiresAt },
    });
    return true;
  }

  private findClosedSession(maintainerId: string): ImpersonationSession | undefined {
    return Array.from(this.sessions.values())
      .filter((s) => s.maintainerId === maintainerId && s.endedAt)
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
  }

  private evictOldestIfNeeded(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const oldest = Array.from(this.sessions.values()).sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )[0];
    if (oldest) this.sessions.delete(oldest.id);
  }
}

export const impersonationService = new ImpersonationService();
