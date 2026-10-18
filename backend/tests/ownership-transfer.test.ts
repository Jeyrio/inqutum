import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { OwnershipTransferService } from '../src/services/ownership-transfer.service';
import {
  SelfTransferForbiddenError,
  UnauthorizedTransferError,
  UnauthorizedAcceptorError,
  PendingTransferExistsError,
  OwnershipTransferExpiredError,
  InvalidTransferStateError,
  InvalidTargetOwnerError,
} from '../src/domain/ownership-transfer';

describe('Safe Ownership Transfer (#300)', () => {
  let service: OwnershipTransferService;
  let auditLogs: Array<{ type: string; actorId: string; details: any }> = [];

  const OWNER_ALICE = 'G_ALICE_111111111111111111111111111111111111111111111111111';
  const NOMINEE_BOB = 'G_BOB_222222222222222222222222222222222222222222222222222';
  const ATTACKER_EVE = 'G_EVE_333333333333333333333333333333333333333333333333333';
  const ORG_ID = 'org-quittance-main';

  beforeEach(() => {
    auditLogs = [];
    service = new OwnershipTransferService((event) => {
      auditLogs.push(event);
    });
    service.registerResourceOwner(ORG_ID, OWNER_ALICE);
  });

  it('normal path: two-step transfer initiation and acceptance transfers ownership cleanly', () => {
    // 1. Alice initiates transfer to Bob
    const transfer = service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      targetOwnerEmail: 'bob@example.com',
      reason: 'Company restructuring',
    });

    assert.strictEqual(transfer.status, 'PENDING_ACCEPTANCE');
    assert.strictEqual(transfer.currentOwnerId, OWNER_ALICE);
    assert.strictEqual(transfer.targetOwnerId, NOMINEE_BOB);
    assert.ok(transfer.transferToken.length >= 32);
    // Resource owner is still Alice while pending
    assert.strictEqual(service.getResourceOwner(ORG_ID), OWNER_ALICE);

    // 2. Bob accepts transfer
    const accepted = service.acceptTransfer(transfer.id, NOMINEE_BOB);
    assert.strictEqual(accepted.status, 'ACCEPTED');
    assert.ok(accepted.acceptedAt);

    // 3. Ownership is now transferred to Bob
    assert.strictEqual(service.getResourceOwner(ORG_ID), NOMINEE_BOB);

    // Audit logs verify lifecycle
    assert.strictEqual(auditLogs.length, 2);
    assert.strictEqual(auditLogs[0].type, 'OWNERSHIP_TRANSFER_INITIATED');
    assert.strictEqual(auditLogs[1].type, 'OWNERSHIP_TRANSFER_ACCEPTED');
    assert.strictEqual(auditLogs[1].details.newOwnerId, NOMINEE_BOB);
  });

  it('acceptance via secret transfer token succeeds', () => {
    const transfer = service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      reason: 'Token based invite',
    });

    // Accept via token string
    const accepted = service.acceptTransfer(transfer.transferToken, NOMINEE_BOB);
    assert.strictEqual(accepted.id, transfer.id);
    assert.strictEqual(accepted.status, 'ACCEPTED');
    assert.strictEqual(service.getResourceOwner(ORG_ID), NOMINEE_BOB);
  });

  it('self-transfer guard: rejects transfer when target is identical to current owner', () => {
    assert.throws(
      () =>
        service.initiateTransfer({
          resourceType: 'ORGANIZATION',
          resourceId: ORG_ID,
          currentOwnerId: OWNER_ALICE,
          targetOwnerId: OWNER_ALICE,
          reason: 'Invalid self transfer',
        }),
      (err: any) => {
        assert.ok(err instanceof SelfTransferForbiddenError);
        assert.strictEqual(err.code, 'SELF_TRANSFER_FORBIDDEN');
        return true;
      }
    );
  });

  it('authorization path: non-owner cannot initiate ownership transfer', () => {
    assert.throws(
      () =>
        service.initiateTransfer({
          resourceType: 'ORGANIZATION',
          resourceId: ORG_ID,
          currentOwnerId: ATTACKER_EVE, // Eve is not registered owner
          targetOwnerId: NOMINEE_BOB,
          reason: 'Unauthorized attempt',
        }),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedTransferError);
        assert.strictEqual(err.code, 'UNAUTHORIZED_OWNERSHIP_OPERATION');
        assert.strictEqual(err.httpStatus, 403);
        return true;
      }
    );
  });

  it('authorization path: unauthorized third party cannot accept transfer', () => {
    const transfer = service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      reason: 'Valid nomination',
    });

    // Eve attempts to accept
    assert.throws(
      () => service.acceptTransfer(transfer.id, ATTACKER_EVE),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedAcceptorError);
        assert.strictEqual(err.code, 'UNAUTHORIZED_ACCEPTOR');
        assert.strictEqual(err.httpStatus, 403);
        return true;
      }
    );

    // Organization owner remains Alice
    assert.strictEqual(service.getResourceOwner(ORG_ID), OWNER_ALICE);
  });

  it('expiry path: transfer past TTL automatically expires and rejects acceptance', async () => {
    // 10ms short TTL
    const transfer = service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      reason: 'Expiring transfer',
      ttlMs: 15,
    });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 25));

    assert.throws(
      () => service.acceptTransfer(transfer.id, NOMINEE_BOB),
      (err: any) => {
        assert.ok(err instanceof OwnershipTransferExpiredError);
        assert.strictEqual(err.code, 'TRANSFER_EXPIRED');
        assert.strictEqual(err.httpStatus, 410);
        return true;
      }
    );

    const record = service.getTransfer(transfer.id);
    assert.strictEqual(record?.status, 'EXPIRED');
    assert.strictEqual(service.getResourceOwner(ORG_ID), OWNER_ALICE);
  });

  it('cancellation path: owner can cancel pending transfer before acceptance', () => {
    const transfer = service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      reason: 'Change of mind',
    });

    const cancelled = service.cancelTransfer(transfer.id, OWNER_ALICE, 'Mistaken nomination');
    assert.strictEqual(cancelled.status, 'CANCELLED');
    assert.ok(cancelled.cancelledAt);

    // Bob can no longer accept
    assert.throws(
      () => service.acceptTransfer(transfer.id, NOMINEE_BOB),
      (err: any) => {
        assert.ok(err instanceof InvalidTransferStateError);
        assert.strictEqual(err.code, 'INVALID_TRANSFER_STATE');
        return true;
      }
    );
  });

  it('rejection path: nominee can decline pending transfer', () => {
    const transfer = service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      reason: 'Offered position',
    });

    const rejected = service.rejectTransfer(transfer.id, NOMINEE_BOB, 'Cannot take responsibility');
    assert.strictEqual(rejected.status, 'REJECTED');
    assert.ok(rejected.rejectedAt);

    // Resource remains with Alice
    assert.strictEqual(service.getResourceOwner(ORG_ID), OWNER_ALICE);
  });

  it('prevents multiple concurrent pending transfers on the same resource', () => {
    service.initiateTransfer({
      resourceType: 'ORGANIZATION',
      resourceId: ORG_ID,
      currentOwnerId: OWNER_ALICE,
      targetOwnerId: NOMINEE_BOB,
      reason: 'First nomination',
    });

    // Second transfer before first is resolved
    assert.throws(
      () =>
        service.initiateTransfer({
          resourceType: 'ORGANIZATION',
          resourceId: ORG_ID,
          currentOwnerId: OWNER_ALICE,
          targetOwnerId: ATTACKER_EVE,
          reason: 'Second nomination',
        }),
      (err: any) => {
        assert.ok(err instanceof PendingTransferExistsError);
        assert.strictEqual(err.code, 'PENDING_TRANSFER_EXISTS');
        return true;
      }
    );
  });

  it('input validation: rejects blank or empty target owner ID', () => {
    assert.throws(
      () =>
        service.initiateTransfer({
          resourceType: 'ORGANIZATION',
          resourceId: ORG_ID,
          currentOwnerId: OWNER_ALICE,
          targetOwnerId: '   ',
          reason: 'Blank target',
        }),
      (err: any) => {
        assert.ok(err instanceof InvalidTargetOwnerError);
        return true;
      }
    );
  });
});
