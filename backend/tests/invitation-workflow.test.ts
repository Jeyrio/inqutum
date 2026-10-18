import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvitationService,
  RoleEscalationError,
  InvitationExpiredError,
  InvitationRevokedError,
  InvitationThrottledError,
} from '../src/services/invitation.service';

describe('Abuse-Resistant Invitation & Collaboration Workflow (Issue #77)', () => {
  it('allows authorized roles to invite members and successfully accepts an invitation', () => {
    const service = new InvitationService();

    const invitation = service.createInvitation({
      organizationId: 'org-1',
      inviterId: 'user-admin',
      inviterRole: 'ADMIN',
      inviteeEmail: 'developer@example.com',
      assignedRole: 'COLLABORATOR',
    });

    assert.strictEqual(invitation.status, 'PENDING');
    assert.strictEqual(invitation.assignedRole, 'COLLABORATOR');
    assert.ok(invitation.token);

    const accepted = service.acceptInvitation(invitation.token, 'user-new-dev');
    assert.strictEqual(accepted.status, 'ACCEPTED');
    assert.strictEqual(accepted.acceptedBy, 'user-new-dev');
    assert.ok(accepted.acceptedAt);
  });

  it('rejects role escalation attempts where inviter assigns higher role than their own', () => {
    const service = new InvitationService();

    // COLLABORATOR attempting to invite an ADMIN
    assert.throws(
      () => {
        service.createInvitation({
          organizationId: 'org-1',
          inviterId: 'user-collab',
          inviterRole: 'COLLABORATOR',
          inviteeEmail: 'attacker@example.com',
          assignedRole: 'ADMIN',
        });
      },
      (err: any) => {
        assert.ok(err instanceof RoleEscalationError);
        assert.ok(err.message.includes('Role escalation rejected'));
        return true;
      }
    );
  });

  it('rejects acceptance of revoked invitations', () => {
    const service = new InvitationService();

    const invitation = service.createInvitation({
      organizationId: 'org-1',
      inviterId: 'user-admin',
      inviterRole: 'ADMIN',
      inviteeEmail: 'contractor@example.com',
      assignedRole: 'VIEWER',
    });

    service.revokeInvitation(invitation.id, 'user-admin', 'ADMIN');

    assert.throws(
      () => {
        service.acceptInvitation(invitation.token, 'user-contractor');
      },
      (err: any) => {
        assert.ok(err instanceof InvitationRevokedError);
        return true;
      }
    );
  });

  it('rejects acceptance of expired invitations', () => {
    const service = new InvitationService();

    const invitation = service.createInvitation({
      organizationId: 'org-1',
      inviterId: 'user-owner',
      inviterRole: 'OWNER',
      inviteeEmail: 'slow-user@example.com',
      assignedRole: 'VIEWER',
      expiresInMs: -1000, // already expired in the past
    });

    assert.throws(
      () => {
        service.acceptInvitation(invitation.token, 'user-slow');
      },
      (err: any) => {
        assert.ok(err instanceof InvitationExpiredError);
        return true;
      }
    );
  });

  it('throttles abusive invite floods from the same inviter and spam to the same recipient', () => {
    const service = new InvitationService({
      maxInvitesPerWindow: 2,
      windowMs: 60000,
      maxInvitesPerTargetEmail: 1,
    });

    // 1st invite succeeds
    service.createInvitation({
      organizationId: 'org-1',
      inviterId: 'user-spammer',
      inviterRole: 'OWNER',
      inviteeEmail: 'victim1@example.com',
      assignedRole: 'VIEWER',
    });

    // Same recipient target throttle
    assert.throws(
      () => {
        service.createInvitation({
          organizationId: 'org-1',
          inviterId: 'user-other',
          inviterRole: 'OWNER',
          inviteeEmail: 'victim1@example.com', // already invited
          assignedRole: 'VIEWER',
        });
      },
      (err: any) => {
        assert.ok(err instanceof InvitationThrottledError);
        assert.ok(err.message.includes('Too many invitations sent to recipient'));
        return true;
      }
    );

    // 2nd invite for inviter succeeds with different recipient
    service.createInvitation({
      organizationId: 'org-1',
      inviterId: 'user-spammer',
      inviterRole: 'OWNER',
      inviteeEmail: 'victim2@example.com',
      assignedRole: 'VIEWER',
    });

    // 3rd invite from same inviter triggers inviter window throttle
    assert.throws(
      () => {
        service.createInvitation({
          organizationId: 'org-1',
          inviterId: 'user-spammer',
          inviterRole: 'OWNER',
          inviteeEmail: 'victim3@example.com',
          assignedRole: 'VIEWER',
        });
      },
      (err: any) => {
        assert.ok(err instanceof InvitationThrottledError);
        assert.ok(err.message.includes('Limit is 2'));
        return true;
      }
    );
  });
});
