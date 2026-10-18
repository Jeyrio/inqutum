/**
 * Permission Diff Service (Issue #302).
 *
 * Computes deterministic permission diff reports before committing role or policy changes.
 * Enforces least-privilege principles, detects dangerous privilege escalation, flags
 * breaking capability revocations, and generates zero-guesswork rollback recipes.
 *
 * Time Complexity:
 *  - O(P) where P is the number of system permissions (constant-bounded, O(1) in practice).
 * Space Complexity:
 *  - O(P) to construct sets and the diff report.
 */

import crypto from 'crypto';
import {
  SystemPermission,
  RolePermissionDiff,
  PolicyParamDiff,
  PermissionDiffReport,
  DiffRiskLevel,
  DEFAULT_ROLE_PERMISSIONS,
  HIGH_PRIVILEGE_PERMISSIONS,
  UnauthorizedPermissionDiffError,
  RoleEscalationForbiddenError,
} from '../domain/permission-diff';
import { CollaborationRole, ROLE_HIERARCHY } from '../domain/invitation';
import { BusinessPolicy } from '../domain/policy';

export interface DiffGeneratorOptions {
  actorId?: string;
  actorRole?: CollaborationRole;
}

export class PermissionDiffService {
  /**
   * Generates a permission-diff report comparing current role permissions with proposed permissions.
   *
   * Time Complexity: O(P)
   */
  public generateRoleDiff(
    role: CollaborationRole,
    proposedPermissions: SystemPermission[],
    options: DiffGeneratorOptions = {}
  ): PermissionDiffReport {
    this.assertAuthorized(options.actorId, options.actorRole);

    const currentPerms = new Set(DEFAULT_ROLE_PERMISSIONS[role] || []);
    const proposedPerms = new Set(proposedPermissions);

    const added: SystemPermission[] = [];
    const revoked: SystemPermission[] = [];
    const retained: SystemPermission[] = [];

    for (const p of proposedPerms) {
      if (!currentPerms.has(p)) {
        added.push(p);
      } else {
        retained.push(p);
      }
    }

    for (const p of currentPerms) {
      if (!proposedPerms.has(p)) {
        revoked.push(p);
      }
    }

    // Privilege Escalation Check: Lower roles gaining high privilege permissions
    let isPrivilegeEscalation = false;
    if (role !== 'OWNER') {
      isPrivilegeEscalation = added.some((p) => HIGH_PRIVILEGE_PERMISSIONS.has(p));
    }

    // Breaking Revocation Check: Core functional capabilities removed from operational roles
    const isBreakingRevocation = revoked.some(
      (p) => p === 'invoice:read' || p === 'invoice:create' || p === 'invoice:verify'
    );

    // Compute Risk Level
    let riskLevel: DiffRiskLevel = 'LOW';
    if (isPrivilegeEscalation) {
      riskLevel = 'CRITICAL';
    } else if (isBreakingRevocation || added.length > 3 || revoked.length > 2) {
      riskLevel = 'HIGH';
    } else if (added.length > 0 || revoked.length > 0) {
      riskLevel = 'MEDIUM';
    }

    const reversalPlan = {
      action: `REVERT_ROLE_PERMISSIONS_${role}`,
      restorePermissions: [...currentPerms],
    };

    const roleDiff: RolePermissionDiff = {
      role,
      currentPermissions: [...currentPerms],
      proposedPermissions: [...proposedPerms],
      addedPermissions: added,
      revokedPermissions: revoked,
      retainedPermissions: retained,
      isPrivilegeEscalation,
      isBreakingRevocation,
      riskLevel,
      reversalPlan,
    };

    const reversalRecipe = [
      `-- Reversal Recipe for Role '${role}' Modifications`,
      `UPDATE role_permissions SET permissions = '${JSON.stringify([...currentPerms])}' WHERE role = '${role}';`,
    ];

    const requiresMaintainerQuorum = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';

    return {
      reportId: crypto.randomUUID(),
      generatedAt: new Date().toISOString(),
      generatedBy: options.actorId || 'operator',
      scope: 'ROLE_MODIFICATION',
      overallRisk: riskLevel,
      privilegeEscalationDetected: isPrivilegeEscalation,
      breakingChangesDetected: isBreakingRevocation,
      requiresMaintainerQuorum,
      roleDiffs: [roleDiff],
      reversalRecipe,
      summary: `Role diff for '${role}': +${added.length} added, -${revoked.length} revoked. Risk: ${riskLevel}.${
        isPrivilegeEscalation ? ' ATTENTION: Privilege escalation detected.' : ''
      }`,
    };
  }

  /**
   * Generates a permission-diff report for a proposed user role reassignment.
   *
   * Time Complexity: O(P)
   */
  public generateUserAssignmentDiff(
    targetUserId: string,
    currentRole: CollaborationRole,
    proposedRole: CollaborationRole,
    options: DiffGeneratorOptions = {}
  ): PermissionDiffReport {
    this.assertAuthorized(options.actorId, options.actorRole);

    const assignerRole = options.actorRole || 'ADMIN';
    const assignerRank = ROLE_HIERARCHY[assignerRole] || 0;
    const proposedRank = ROLE_HIERARCHY[proposedRole] || 0;

    // Enforce role hierarchy: cannot grant role equal to or higher than own rank unless OWNER
    if (assignerRole !== 'OWNER' && proposedRank >= assignerRank) {
      throw new RoleEscalationForbiddenError(assignerRole, proposedRole);
    }

    const currentPerms = new Set(DEFAULT_ROLE_PERMISSIONS[currentRole] || []);
    const proposedPerms = new Set(DEFAULT_ROLE_PERMISSIONS[proposedRole] || []);

    const added = [...proposedPerms].filter((p) => !currentPerms.has(p));
    const revoked = [...currentPerms].filter((p) => !proposedPerms.has(p));
    const retained = [...currentPerms].filter((p) => proposedPerms.has(p));

    const isPrivilegeEscalation = proposedRank > (ROLE_HIERARCHY[currentRole] || 0) && added.some((p) => HIGH_PRIVILEGE_PERMISSIONS.has(p));
    const isBreakingRevocation = revoked.some((p) => p === 'invoice:read' || p === 'invoice:create');

    let riskLevel: DiffRiskLevel = 'LOW';
    if (proposedRole === 'OWNER') {
      riskLevel = 'CRITICAL';
    } else if (isPrivilegeEscalation) {
      riskLevel = 'HIGH';
    } else if (revoked.length > 0) {
      riskLevel = 'MEDIUM';
    }

    const roleDiff: RolePermissionDiff = {
      role: `${targetUserId} (${currentRole} -> ${proposedRole})`,
      currentPermissions: [...currentPerms],
      proposedPermissions: [...proposedPerms],
      addedPermissions: added,
      revokedPermissions: revoked,
      retainedPermissions: retained,
      isPrivilegeEscalation,
      isBreakingRevocation,
      riskLevel,
      reversalPlan: {
        action: `REVERT_USER_ROLE_${targetUserId}`,
        restorePermissions: [...currentPerms],
      },
    };

    const reversalRecipe = [
      `-- Reversal Recipe for User '${targetUserId}' Assignment`,
      `UPDATE user_collaborations SET role = '${currentRole}' WHERE user_id = '${targetUserId}';`,
    ];

    return {
      reportId: crypto.randomUUID(),
      generatedAt: new Date().toISOString(),
      generatedBy: options.actorId || 'operator',
      scope: 'USER_ROLE_ASSIGNMENT',
      overallRisk: riskLevel,
      privilegeEscalationDetected: isPrivilegeEscalation,
      breakingChangesDetected: isBreakingRevocation,
      requiresMaintainerQuorum: riskLevel === 'HIGH' || riskLevel === 'CRITICAL',
      roleDiffs: [roleDiff],
      reversalRecipe,
      summary: `User role reassignment for '${targetUserId}' from '${currentRole}' to '${proposedRole}': +${added.length} perms, -${revoked.length} perms. Risk: ${riskLevel}.`,
    };
  }

  /**
   * Generates a policy-change diff report analyzing parameter adjustments.
   *
   * Time Complexity: O(1)
   */
  public generatePolicyDiff(
    currentPolicy: BusinessPolicy,
    proposedPolicy: BusinessPolicy,
    options: DiffGeneratorOptions = {}
  ): PermissionDiffReport {
    this.assertAuthorized(options.actorId, options.actorRole);

    const policyDiffs: PolicyParamDiff[] = [];
    const cur = currentPolicy.invoice;
    const prop = proposedPolicy.invoice;

    // 1. Min Amount
    if (cur.minAmount !== prop.minAmount) {
      const restricted = prop.minAmount > cur.minAmount;
      policyDiffs.push({
        parameter: 'minAmount',
        currentValue: cur.minAmount,
        proposedValue: prop.minAmount,
        changeType: restricted ? 'RESTRICTED' : 'EXPANDED',
        riskLevel: restricted ? 'MEDIUM' : 'LOW',
        impactAnalysis: restricted
          ? `Higher minimum amount (${prop.minAmount}) will reject small micro-invoices.`
          : `Lower minimum amount (${prop.minAmount}) expands micro-invoice eligibility.`,
      });
    }

    // 2. Max Amount
    if (cur.maxAmount !== prop.maxAmount) {
      const expanded = prop.maxAmount > cur.maxAmount;
      policyDiffs.push({
        parameter: 'maxAmount',
        currentValue: cur.maxAmount,
        proposedValue: prop.maxAmount,
        changeType: expanded ? 'EXPANDED' : 'RESTRICTED',
        riskLevel: expanded ? 'HIGH' : 'LOW',
        impactAnalysis: expanded
          ? `Increased maximum amount (${prop.maxAmount}) elevates counterparty transaction volume exposure.`
          : `Decreased maximum amount (${prop.maxAmount}) bounds risk exposure.`,
      });
    }

    // 3. Allowed Assets
    const curAssets = new Set(cur.allowedAssets);
    const propAssets = new Set(prop.allowedAssets);
    const addedAssets = [...propAssets].filter((a) => !curAssets.has(a));
    const removedAssets = [...curAssets].filter((a) => !propAssets.has(a));

    if (addedAssets.length > 0 || removedAssets.length > 0) {
      policyDiffs.push({
        parameter: 'allowedAssets',
        currentValue: cur.allowedAssets,
        proposedValue: prop.allowedAssets,
        changeType: removedAssets.length > 0 ? 'RESTRICTED' : 'EXPANDED',
        riskLevel: removedAssets.length > 0 ? 'HIGH' : 'MEDIUM',
        impactAnalysis: `Allowed assets altered. Added: [${addedAssets.join(', ') || 'none'}], Removed: [${removedAssets.join(', ') || 'none'}].`,
      });
    }

    // Overall Risk
    let overallRisk: DiffRiskLevel = 'LOW';
    if (policyDiffs.some((d) => d.riskLevel === 'HIGH')) {
      overallRisk = 'HIGH';
    } else if (policyDiffs.some((d) => d.riskLevel === 'MEDIUM')) {
      overallRisk = 'MEDIUM';
    }

    const reversalRecipe = [
      `-- Reversal Recipe for Policy Changes`,
      `SET_POLICY_MIN_AMOUNT=${cur.minAmount}`,
      `SET_POLICY_MAX_AMOUNT=${cur.maxAmount}`,
      `SET_POLICY_ALLOWED_ASSETS=${cur.allowedAssets.join(',')}`,
    ];

    return {
      reportId: crypto.randomUUID(),
      generatedAt: new Date().toISOString(),
      generatedBy: options.actorId || 'operator',
      scope: 'POLICY_CHANGE',
      overallRisk,
      privilegeEscalationDetected: false,
      breakingChangesDetected: policyDiffs.some((d) => d.changeType === 'RESTRICTED'),
      requiresMaintainerQuorum: overallRisk === 'HIGH',
      roleDiffs: [],
      policyDiffs,
      reversalRecipe,
      summary: `Policy diff: ${policyDiffs.length} parameter(s) modified. Overall risk: ${overallRisk}.`,
    };
  }

  private assertAuthorized(actorId?: string, actorRole?: CollaborationRole): void {
    const role = actorRole || 'ADMIN';
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new UnauthorizedPermissionDiffError(actorId, role);
    }
  }
}
