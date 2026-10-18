export type CollaborationRole = 'OWNER' | 'ADMIN' | 'COLLABORATOR' | 'VIEWER';

export const ROLE_HIERARCHY: Record<CollaborationRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  COLLABORATOR: 2,
  VIEWER: 1,
};

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export interface CollaborationInvitation {
  id: string;
  organizationId: string;
  inviterId: string;
  inviterRole: CollaborationRole;
  inviteeEmail: string;
  assignedRole: CollaborationRole;
  token: string;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: string;
  revokedAt?: Date;
  revokedBy?: string;
}

export interface CreateInvitationRequest {
  organizationId: string;
  inviterId: string;
  inviterRole: CollaborationRole;
  inviteeEmail: string;
  assignedRole: CollaborationRole;
  expiresInMs?: number;
}
