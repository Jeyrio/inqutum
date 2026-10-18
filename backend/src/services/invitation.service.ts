import crypto from 'crypto';
import {
  CollaborationInvitation,
  CollaborationRole,
  CreateInvitationRequest,
  ROLE_HIERARCHY,
} from '../domain/invitation';

export class RoleEscalationError extends Error {
  constructor(inviterRole: string, assignedRole: string) {
    super(
      `Role escalation rejected: actor with role '${inviterRole}' cannot grant higher role '${assignedRole}'.`
    );
    this.name = 'RoleEscalationError';
  }
}

export class InvitationExpiredError extends Error {
  constructor() {
    super('This invitation has expired and can no longer be accepted.');
    this.name = 'InvitationExpiredError';
  }
}

export class InvitationRevokedError extends Error {
  constructor() {
    super('This invitation has been revoked.');
    this.name = 'InvitationRevokedError';
  }
}

export class InvitationThrottledError extends Error {
  constructor(reason: string) {
    super(`Invitation rate limit exceeded: ${reason}`);
    this.name = 'InvitationThrottledError';
  }
}

export interface ThrottleConfig {
  maxInvitesPerWindow: number;
  windowMs: number;
  maxInvitesPerTargetEmail: number;
}

export class InvitationService {
  private invitations: Map<string, CollaborationInvitation> = new Map();
  private tokenIndex: Map<string, string> = new Map(); // token -> invitationId
  private inviterHistory: Map<string, number[]> = new Map(); // inviterId -> timestamps
  private targetHistory: Map<string, number[]> = new Map(); // email -> timestamps

  private throttleConfig: ThrottleConfig;

  constructor(
    throttleConfig: ThrottleConfig = {
      maxInvitesPerWindow: 5,
      windowMs: 600_000, // 10 minutes
      maxInvitesPerTargetEmail: 3,
    }
  ) {
    this.throttleConfig = throttleConfig;
  }

  /**
   * Check rate-limiting for abuse prevention.
   */
  private checkRateLimit(inviterId: string, targetEmail: string, now: number): void {
    const inviterTimes = (this.inviterHistory.get(inviterId) || []).filter(
      (t) => now - t < this.throttleConfig.windowMs
    );
    if (inviterTimes.length >= this.throttleConfig.maxInvitesPerWindow) {
      throw new InvitationThrottledError(
        `Too many invitations sent. Limit is ${this.throttleConfig.maxInvitesPerWindow} per 10 minutes.`
      );
    }

    const emailKey = targetEmail.toLowerCase().trim();
    const targetTimes = (this.targetHistory.get(emailKey) || []).filter(
      (t) => now - t < this.throttleConfig.windowMs
    );
    if (targetTimes.length >= this.throttleConfig.maxInvitesPerTargetEmail) {
      throw new InvitationThrottledError(
        `Too many invitations sent to recipient '${targetEmail}'. Please wait before inviting again.`
      );
    }

    inviterTimes.push(now);
    targetTimes.push(now);
    this.inviterHistory.set(inviterId, inviterTimes);
    this.targetHistory.set(emailKey, targetTimes);
  }

  /**
   * Create an abuse-resistant invitation.
   */
  public createInvitation(req: CreateInvitationRequest): CollaborationInvitation {
    const now = Date.now();

    // 1. Role escalation check
    const inviterRank = ROLE_HIERARCHY[req.inviterRole] || 0;
    const assignedRank = ROLE_HIERARCHY[req.assignedRole] || 0;
    if (assignedRank > inviterRank) {
      throw new RoleEscalationError(req.inviterRole, req.assignedRole);
    }

    // 2. Abuse rate-limiting check
    this.checkRateLimit(req.inviterId, req.inviteeEmail, now);

    // 3. Create invitation
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresInMs = req.expiresInMs || 7 * 24 * 60 * 60 * 1000; // 7 days

    const invitation: CollaborationInvitation = {
      id,
      organizationId: req.organizationId,
      inviterId: req.inviterId,
      inviterRole: req.inviterRole,
      inviteeEmail: req.inviteeEmail.toLowerCase().trim(),
      assignedRole: req.assignedRole,
      token,
      status: 'PENDING',
      createdAt: new Date(now),
      expiresAt: new Date(now + expiresInMs),
    };

    this.invitations.set(id, invitation);
    this.tokenIndex.set(token, id);

    return invitation;
  }

  /**
   * Revoke an active invitation.
   */
  public revokeInvitation(invitationId: string, revokerId: string, revokerRole: CollaborationRole): CollaborationInvitation {
    const invite = this.invitations.get(invitationId);
    if (!invite) {
      throw new Error(`Invitation '${invitationId}' not found.`);
    }

    const revokerRank = ROLE_HIERARCHY[revokerRole] || 0;
    const isOwnerOrAdmin = revokerRank >= ROLE_HIERARCHY.ADMIN;
    const isOriginalInviter = invite.inviterId === revokerId;

    if (!isOwnerOrAdmin && !isOriginalInviter) {
      throw new Error('Unauthorized: only the inviter, an Admin, or an Owner can revoke this invitation.');
    }

    invite.status = 'REVOKED';
    invite.revokedAt = new Date();
    invite.revokedBy = revokerId;

    return invite;
  }

  /**
   * Accept an invitation using its secure token.
   */
  public acceptInvitation(token: string, userId: string): CollaborationInvitation {
    const inviteId = this.tokenIndex.get(token);
    if (!inviteId) {
      throw new Error('Invalid or unknown invitation token.');
    }

    const invite = this.invitations.get(inviteId);
    if (!invite) {
      throw new Error('Invitation record not found.');
    }

    if (invite.status === 'REVOKED') {
      throw new InvitationRevokedError();
    }

    if (invite.status === 'ACCEPTED') {
      throw new Error('Invitation has already been accepted.');
    }

    // Check expiry
    if (Date.now() > invite.expiresAt.getTime()) {
      invite.status = 'EXPIRED';
      throw new InvitationExpiredError();
    }

    invite.status = 'ACCEPTED';
    invite.acceptedAt = new Date();
    invite.acceptedBy = userId;

    return invite;
  }

  /**
   * Get invitation by ID.
   */
  public getInvitation(invitationId: string): CollaborationInvitation | undefined {
    return this.invitations.get(invitationId);
  }
}
