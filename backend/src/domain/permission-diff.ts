/**
 * Permission Diff Domain Model and Risk Taxonomy (Issue #302).
 *
 * Provides structured diff generation before role and policy changes.
 * Detects privilege escalation, breaking permission revocations, and generates
 * deterministic rollback recipes before changes are committed.
 *
 * Invariants:
 *  - Strict Read-Only Diffing: Report generation never mutates roles or policies.
 *  - Privilege Escalation Detection: Automatically flags any grant of high-impact
 *    capabilities (ownership, policy updates, cancellation, maintainer approvals) to
 *    lower-tier roles.
 *  - Breaking Revocation Warning: Alerts when active functional roles lose core capabilities.
 *  - Deterministic Reversal: Every report outputs an exact reversal payload for zero-guesswork rollbacks.
 *  - Authorization Gating: Only ADMIN or OWNER can generate or preview permission diffs.
 */

import { CollaborationRole } from './invitation';

export type SystemPermission =
  // Invoicing
  | 'invoice:create'
  | 'invoice:read'
  | 'invoice:update'
  | 'invoice:cancel'
  | 'invoice:verify'
  // Collaboration & Ownership
  | 'collaboration:invite'
  | 'collaboration:revoke'
  | 'ownership:initiate_transfer'
  | 'ownership:accept_transfer'
  | 'ownership:cancel_transfer'
  // Policy & Administration
  | 'policy:read'
  | 'policy:simulate'
  | 'policy:update'
  // Operations & Jobs
  | 'ops:health'
  | 'job:view'
  | 'job:requeue'
  | 'job:cancel'
  | 'audit:read'
  | 'export:create';

export const HIGH_PRIVILEGE_PERMISSIONS = new Set<SystemPermission>([
  'ownership:initiate_transfer',
  'ownership:accept_transfer',
  'ownership:cancel_transfer',
  'policy:update',
  'invoice:cancel',
  'job:cancel',
  'job:requeue',
]);

export const DEFAULT_ROLE_PERMISSIONS: Record<CollaborationRole, readonly SystemPermission[]> = {
  OWNER: Object.freeze([
    'invoice:create',
    'invoice:read',
    'invoice:update',
    'invoice:cancel',
    'invoice:verify',
    'collaboration:invite',
    'collaboration:revoke',
    'ownership:initiate_transfer',
    'ownership:accept_transfer',
    'ownership:cancel_transfer',
    'policy:read',
    'policy:simulate',
    'policy:update',
    'ops:health',
    'job:view',
    'job:requeue',
    'job:cancel',
    'audit:read',
    'export:create',
  ]),
  ADMIN: Object.freeze([
    'invoice:create',
    'invoice:read',
    'invoice:update',
    'invoice:cancel',
    'invoice:verify',
    'collaboration:invite',
    'collaboration:revoke',
    'policy:read',
    'policy:simulate',
    'ops:health',
    'job:view',
    'job:requeue',
    'audit:read',
    'export:create',
  ]),
  COLLABORATOR: Object.freeze([
    'invoice:create',
    'invoice:read',
    'invoice:update',
    'export:create',
  ]),
  VIEWER: Object.freeze([
    'invoice:read',
  ]),
};

export type DiffRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RolePermissionDiff {
  role: string;
  currentPermissions: SystemPermission[];
  proposedPermissions: SystemPermission[];
  addedPermissions: SystemPermission[];
  revokedPermissions: SystemPermission[];
  retainedPermissions: SystemPermission[];
  isPrivilegeEscalation: boolean;
  isBreakingRevocation: boolean;
  riskLevel: DiffRiskLevel;
  reversalPlan: {
    action: string;
    restorePermissions: SystemPermission[];
  };
}

export interface PolicyParamDiff {
  parameter: string;
  currentValue: unknown;
  proposedValue: unknown;
  changeType: 'EXPANDED' | 'RESTRICTED' | 'MODIFIED' | 'UNCHANGED';
  riskLevel: DiffRiskLevel;
  impactAnalysis: string;
}

export interface PermissionDiffReport {
  reportId: string;
  generatedAt: string;
  generatedBy: string;
  scope: 'ROLE_MODIFICATION' | 'POLICY_CHANGE' | 'USER_ROLE_ASSIGNMENT';
  overallRisk: DiffRiskLevel;
  privilegeEscalationDetected: boolean;
  breakingChangesDetected: boolean;
  requiresMaintainerQuorum: boolean;
  roleDiffs: RolePermissionDiff[];
  policyDiffs?: PolicyParamDiff[];
  reversalRecipe: string[];
  summary: string;
}

export class PermissionDiffError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'PermissionDiffError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class UnauthorizedPermissionDiffError extends PermissionDiffError {
  constructor(actorId?: string, actorRole?: string) {
    super(
      'UNAUTHORIZED_PERMISSION_DIFF',
      `Actor '${actorId || 'unknown'}' with role '${actorRole || 'none'}' is not authorized to generate permission diffs. Requires ADMIN or OWNER.`,
      403
    );
    this.name = 'UnauthorizedPermissionDiffError';
  }
}

export class RoleEscalationForbiddenError extends PermissionDiffError {
  constructor(assignerRole: string, targetRole: string) {
    super(
      'ROLE_ESCALATION_FORBIDDEN',
      `Actor with role '${assignerRole}' cannot grant equal or higher role '${targetRole}'.`,
      403
    );
    this.name = 'RoleEscalationForbiddenError';
  }
}
