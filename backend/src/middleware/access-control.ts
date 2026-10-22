import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { can, isOwnershipScoped } from '../../../shared/access-control';
import type { Permission } from '../../../shared/access-control';
import { SESSION_TOKEN_PREFIX } from '../../../shared/wallet-auth';
import { ANONYMOUS_ACTOR } from '../auth/actor';
import type { Actor } from '../auth/actor';
import { digestToken, loadAuthConfig } from '../auth/config';
import { verifySessionToken } from '../auth/session-token';
import { sendFailure } from '../types/api';

// Authentication answers "who is calling"; authorization answers "may they".
// They are separate middleware on purpose. `authenticate` never rejects: it
// resolves the caller to an actor, and an unrecognised credential resolves to
// anonymous. `requirePermission` is the only place a request is refused, so a
// public route (a payer holding a stale token) keeps working while a privileged
// one still fails closed.

type Env = Record<string, string | undefined>;

/** Why a presented credential was not accepted, for the 401 that follows. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authFailure?: 'malformed' | 'expired_or_invalid' | 'sessions_unavailable';
    }
  }
}

function matchesAny(presented: Buffer, digests: Buffer[]): number {
  let match = -1;
  // No early exit: the loop's duration must not reveal which token matched.
  digests.forEach((candidate, index) => {
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) match = index;
  });
  return match;
}

/** Resolve a bearer token to an actor, or explain why it is not one. */
export function actorFromBearer(
  token: string,
  env: Env = process.env,
  nowMs: number = Date.now()
): { actor: Actor } | { failure: NonNullable<Request['authFailure']> } {
  const config = loadAuthConfig(env);

  if (token.startsWith(`${SESSION_TOKEN_PREFIX}.`)) {
    if (!config.sessionSecret) return { failure: 'sessions_unavailable' };
    const claims = verifySessionToken(config.sessionSecret, token, nowMs);
    return claims
      ? { actor: { role: 'end_user', wallet: claims.sub, subject: claims.sub } }
      : { failure: 'expired_or_invalid' };
  }

  const presented = digestToken(token);
  const maintainer = matchesAny(presented, config.maintainerTokenDigests);
  if (maintainer >= 0) {
    return { actor: { role: 'maintainer', subject: `maintainer:${presented.toString('hex').slice(0, 8)}` } };
  }
  const service = matchesAny(presented, config.serviceTokenDigests);
  if (service >= 0) {
    return { actor: { role: 'service', subject: `service:${presented.toString('hex').slice(0, 8)}` } };
  }
  return { failure: 'expired_or_invalid' };
}

/** Sets `req.actor` on every request; never rejects. */
export function authenticate(env: () => Env = () => process.env): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.actor = ANONYMOUS_ACTOR;
    req.authFailure = undefined;

    const header = req.headers.authorization;
    if (header === undefined) return next();

    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      req.authFailure = 'malformed';
      return next();
    }

    const result = actorFromBearer(match[1], env());
    if ('actor' in result) req.actor = result.actor;
    else req.authFailure = result.failure;
    next();
  };
}

export interface PermissionGuard extends RequestHandler {
  /** Exposed so tests can prove every route is guarded and by what. */
  readonly permission: Permission;
}

/**
 * Refuses the request unless the actor's role holds `permission`.
 * 401 when the caller is anonymous (they may succeed by authenticating), 403
 * when they are authenticated but their role can never do this.
 */
export function requirePermission(permission: Permission): PermissionGuard {
  const guard = ((req: Request, res: Response, next: NextFunction) => {
    const actor = req.actor ?? ANONYMOUS_ACTOR;
    if (can(actor.role, permission)) return next();

    if (actor.role === 'anonymous') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      const reason =
        req.authFailure === 'sessions_unavailable'
          ? 'Wallet sessions are not available on this server'
          : req.authFailure
            ? 'The credentials provided are invalid or have expired'
            : 'Authentication required';
      return sendFailure(res, 401, reason, { code: 'UNAUTHENTICATED' });
    }
    return sendFailure(res, 403, 'Your role is not permitted to perform this action', 'FORBIDDEN', {
      permission,
    });
  }) as PermissionGuard;
  Object.defineProperty(guard, 'permission', { value: permission, enumerable: true });
  return guard;
}

/**
 * Resource check for permissions that are scoped to the caller's own invoices.
 * Returns true when `actor` may use `permission` on a resource whose seller is
 * `sellerPublicKey`. Only `end_user` is ever scoped; operators and services act
 * across sellers.
 */
export function mayAccessSeller(
  actor: Actor | undefined,
  permission: Permission,
  sellerPublicKey: string | undefined
): boolean {
  if (!actor) return true; // handler used without the router; see routes/invoice.routes.ts
  if (!can(actor.role, permission)) return false;
  if (!isOwnershipScoped(actor.role, permission)) return true;
  return Boolean(actor.wallet) && actor.wallet === sellerPublicKey;
}

export function sendForbiddenOwnership(res: Response): void {
  sendFailure(res, 403, 'You can only act on your own invoices', { code: 'FORBIDDEN' });
}
