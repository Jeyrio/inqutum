import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PermissionDiffService } from '../src/services/permission-diff.service';
import {
  UnauthorizedPermissionDiffError,
  RoleEscalationForbiddenError,
  DEFAULT_ROLE_PERMISSIONS,
} from '../src/domain/permission-diff';
import { DEFAULT_POLICY } from '../src/domain/policy';

describe('Permission-Diff Report Engine (#302)', () => {
  const service = new PermissionDiffService();

  it('normal path: generates clean role permission diff with added and retained permissions', () => {
    // Proposing to add 'audit:read' to COLLABORATOR
    const currentPerms = DEFAULT_ROLE_PERMISSIONS.COLLABORATOR;
    const proposedPerms = [...currentPerms, 'audit:read' as const];

    const report = service.generateRoleDiff('COLLABORATOR', proposedPerms, {
      actorRole: 'ADMIN',
      actorId: 'admin-lead',
    });

    assert.strictEqual(report.scope, 'ROLE_MODIFICATION');
    assert.strictEqual(report.privilegeEscalationDetected, false);
    assert.strictEqual(report.breakingChangesDetected, false);
    assert.strictEqual(report.roleDiffs.length, 1);

    const diff = report.roleDiffs[0];
    assert.deepStrictEqual(diff.addedPermissions, ['audit:read']);
    assert.deepStrictEqual(diff.revokedPermissions, []);
    assert.strictEqual(diff.retainedPermissions.length, currentPerms.length);
    assert.ok(diff.reversalPlan.restorePermissions.includes('invoice:create'));
    assert.ok(report.reversalRecipe.length > 0);
  });

  it('privilege escalation detection: flags critical risk when non-owner role gains high privilege capabilities', () => {
    // Granting policy:update and ownership:initiate_transfer to COLLABORATOR
    const currentPerms = DEFAULT_ROLE_PERMISSIONS.COLLABORATOR;
    const proposedPerms = [
      ...currentPerms,
      'policy:update' as const,
      'ownership:initiate_transfer' as const,
    ];

    const report = service.generateRoleDiff('COLLABORATOR', proposedPerms, {
      actorRole: 'OWNER',
      actorId: 'owner-super',
    });

    assert.strictEqual(report.privilegeEscalationDetected, true);
    assert.strictEqual(report.overallRisk, 'CRITICAL');
    assert.strictEqual(report.requiresMaintainerQuorum, true);
    assert.match(report.summary, /Privilege escalation detected/);
  });

  it('breaking revocation detection: flags high risk when core capability is revoked from functional role', () => {
    // Revoking invoice:create from COLLABORATOR
    const currentPerms = DEFAULT_ROLE_PERMISSIONS.COLLABORATOR;
    const proposedPerms = currentPerms.filter((p) => p !== 'invoice:create');

    const report = service.generateRoleDiff('COLLABORATOR', proposedPerms, {
      actorRole: 'ADMIN',
    });

    assert.strictEqual(report.breakingChangesDetected, true);
    assert.strictEqual(report.overallRisk, 'HIGH');
    assert.deepStrictEqual(report.roleDiffs[0].revokedPermissions, ['invoice:create']);
  });

  it('user role assignment diff: computes permission delta for user promotion', () => {
    const report = service.generateUserAssignmentDiff('user-alice-123', 'VIEWER', 'COLLABORATOR', {
      actorRole: 'ADMIN',
      actorId: 'admin-bob',
    });

    assert.strictEqual(report.scope, 'USER_ROLE_ASSIGNMENT');
    assert.strictEqual(report.roleDiffs.length, 1);
    const diff = report.roleDiffs[0];
    assert.ok(diff.addedPermissions.includes('invoice:create'));
    assert.ok(diff.addedPermissions.includes('invoice:update'));
    assert.strictEqual(diff.revokedPermissions.length, 0);
    assert.ok(report.reversalRecipe[1].includes("UPDATE user_collaborations SET role = 'VIEWER'"));
  });

  it('role escalation rejection: non-owner admin cannot assign equal or higher role', () => {
    assert.throws(
      () =>
        service.generateUserAssignmentDiff('user-charlie', 'COLLABORATOR', 'ADMIN', {
          actorRole: 'ADMIN', // Admin trying to grant ADMIN
          actorId: 'admin-bob',
        }),
      (err: any) => {
        assert.ok(err instanceof RoleEscalationForbiddenError);
        assert.strictEqual(err.code, 'ROLE_ESCALATION_FORBIDDEN');
        assert.strictEqual(err.httpStatus, 403);
        return true;
      }
    );
  });

  it('policy diff report: analyzes parameter changes and generates reversal recipe', () => {
    const currentPolicy = DEFAULT_POLICY;
    const proposedPolicy = {
      invoice: {
        ...currentPolicy.invoice,
        minAmount: 5.0, // Restricted
        maxAmount: 2_000_000_000, // Expanded (default is 1_000_000_000)
        allowedAssets: ['USDC', 'XLM'], // Restricted
      },
    };

    const report = service.generatePolicyDiff(currentPolicy, proposedPolicy, {
      actorRole: 'ADMIN',
    });

    assert.strictEqual(report.scope, 'POLICY_CHANGE');
    assert.ok(report.policyDiffs);
    assert.strictEqual(report.policyDiffs.length, 3);

    const minDiff = report.policyDiffs.find((d) => d.parameter === 'minAmount');
    assert.strictEqual(minDiff?.changeType, 'RESTRICTED');

    const maxDiff = report.policyDiffs.find((d) => d.parameter === 'maxAmount');
    assert.strictEqual(maxDiff?.changeType, 'EXPANDED');

    assert.ok(report.reversalRecipe.some((r) => r.includes(`SET_POLICY_MIN_AMOUNT=${currentPolicy.invoice.minAmount}`)));
  });

  it('authorization path: unprivileged role (COLLABORATOR or VIEWER) cannot generate diffs', () => {
    assert.throws(
      () =>
        service.generateRoleDiff('COLLABORATOR', [], {
          actorRole: 'COLLABORATOR',
          actorId: 'collab-dan',
        }),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedPermissionDiffError);
        assert.strictEqual(err.code, 'UNAUTHORIZED_PERMISSION_DIFF');
        assert.strictEqual(err.httpStatus, 403);
        return true;
      }
    );
  });
});
