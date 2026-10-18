import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InvariantValidator,
  InvariantViolationError,
  STROOPS_PER_XLM,
} from '../src/domain/state-invariants';

describe('State Invariant Verification (Issue #280)', () => {
  describe('Balance Transition Invariants', () => {
    it('validates conservation of value on normal debit and credit with fees', () => {
      const result = InvariantValidator.validateBalanceTransition({
        sourceAccountId: 'account-A',
        destinationAccountId: 'account-B',
        sourceBalanceStroops: 100_000_000n, // 10 XLM
        destinationBalanceStroops: 50_000_000n, // 5 XLM
        transferAmountStroops: 20_000_000n, // 2 XLM
        feeStroops: 100n, // fee
        minimumReserveStroops: 10_000_000n, // 1 XLM reserve
      });

      assert.equal(result.newSourceBalanceStroops, 79_999_900n);
      assert.equal(result.newDestinationBalanceStroops, 70_000_000n);
      assert.equal(result.feeCollectedStroops, 100n);
      assert.equal(result.netTransferStroops, 20_000_000n);
    });

    it('rejects transfers that violate minimum balance reserve limits', () => {
      assert.throws(
        () => {
          InvariantValidator.validateBalanceTransition({
            sourceAccountId: 'account-A',
            destinationAccountId: 'account-B',
            sourceBalanceStroops: 15_000_000n, // 1.5 XLM
            destinationBalanceStroops: 0n,
            transferAmountStroops: 10_000_000n, // 1.0 XLM
            feeStroops: 100n,
            minimumReserveStroops: 10_000_000n, // 1.0 XLM required reserve
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'INSUFFICIENT_FUNDS_OR_RESERVE_BREACH');
          assert.equal(err.domain, 'BALANCE');
          return true;
        }
      );
    });

    it('rejects self-transfer loop corruptions and negative transfers', () => {
      assert.throws(
        () => {
          InvariantValidator.validateBalanceTransition({
            sourceAccountId: 'account-A',
            destinationAccountId: 'account-A',
            sourceBalanceStroops: 100n,
            destinationBalanceStroops: 100n,
            transferAmountStroops: 10n,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'SELF_TRANSFER_DISALLOWED');
          return true;
        }
      );

      assert.throws(
        () => {
          InvariantValidator.validateBalanceTransition({
            sourceAccountId: 'account-A',
            destinationAccountId: 'account-B',
            sourceBalanceStroops: 100n,
            destinationBalanceStroops: 100n,
            transferAmountStroops: -50n,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'INVALID_TRANSFER_AMOUNT');
          return true;
        }
      );
    });
  });

  describe('Ownership Transition Invariants', () => {
    it('permits authorized owner initiation and target acceptance', () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 3600_000);

      // Normal Initiation
      assert.doesNotThrow(() => {
        InvariantValidator.validateOwnershipTransition({
          entityId: 'seller-org-1',
          currentOwnerId: 'owner-alice',
          targetOwnerId: 'target-bob',
          actorId: 'owner-alice',
          actorRole: 'OWNER',
          action: 'INITIATE',
          now,
        });
      });

      // Target Acceptance
      assert.doesNotThrow(() => {
        InvariantValidator.validateOwnershipTransition({
          entityId: 'seller-org-1',
          currentOwnerId: 'owner-alice',
          targetOwnerId: 'target-bob',
          actorId: 'target-bob',
          actorRole: 'ADMIN',
          action: 'ACCEPT',
          transferStatus: 'PENDING_ACCEPTANCE',
          expiresAt,
          now,
        });
      });
    });

    it('rejects self-ownership nomination', () => {
      assert.throws(
        () => {
          InvariantValidator.validateOwnershipTransition({
            entityId: 'seller-org-1',
            currentOwnerId: 'owner-alice',
            targetOwnerId: 'owner-alice',
            actorId: 'owner-alice',
            actorRole: 'OWNER',
            action: 'INITIATE',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'SELF_OWNERSHIP_TRANSFER_FORBIDDEN');
          return true;
        }
      );
    });

    it('enforces authorization gates on ownership transfer acceptance', () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 3600_000);

      // Imposter tries to accept
      assert.throws(
        () => {
          InvariantValidator.validateOwnershipTransition({
            entityId: 'seller-org-1',
            currentOwnerId: 'owner-alice',
            targetOwnerId: 'target-bob',
            actorId: 'eve-imposter',
            actorRole: 'ADMIN',
            action: 'ACCEPT',
            transferStatus: 'PENDING_ACCEPTANCE',
            expiresAt,
            now,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'UNAUTHORIZED_OWNERSHIP_ACCEPTOR');
          assert.equal(err.httpStatus, 403);
          return true;
        }
      );
    });

    it('rejects acceptance of expired ownership transfers', () => {
      const now = new Date();
      const expiredAt = new Date(now.getTime() - 60_000);

      assert.throws(
        () => {
          InvariantValidator.validateOwnershipTransition({
            entityId: 'seller-org-1',
            currentOwnerId: 'owner-alice',
            targetOwnerId: 'target-bob',
            actorId: 'target-bob',
            actorRole: 'ADMIN',
            action: 'ACCEPT',
            transferStatus: 'PENDING_ACCEPTANCE',
            expiresAt: expiredAt,
            now,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'OWNERSHIP_TRANSFER_EXPIRED');
          return true;
        }
      );
    });
  });

  describe('Entitlement & Privilege Invariants', () => {
    it('rejects cross-tenant privilege grants', () => {
      assert.throws(
        () => {
          InvariantValidator.validateEntitlementTransition({
            actorId: 'admin-1',
            actorRole: 'ADMIN',
            targetUserId: 'user-2',
            grantedRole: 'COLLABORATOR',
            actorTenantId: 'tenant-alpha',
            targetTenantId: 'tenant-beta',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'TENANT_BOUNDARY_BREACH');
          return true;
        }
      );
    });

    it('rejects privilege escalation attempts', () => {
      assert.throws(
        () => {
          // ADMIN attempts to grant OWNER
          InvariantValidator.validateEntitlementTransition({
            actorId: 'admin-1',
            actorRole: 'ADMIN',
            targetUserId: 'user-2',
            grantedRole: 'OWNER',
            actorTenantId: 'tenant-alpha',
            targetTenantId: 'tenant-alpha',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'PRIVILEGE_ESCALATION_FORBIDDEN');
          return true;
        }
      );
    });

    it('permits valid within-rank role grants', () => {
      assert.doesNotThrow(() => {
        InvariantValidator.validateEntitlementTransition({
          actorId: 'owner-1',
          actorRole: 'OWNER',
          targetUserId: 'user-2',
          grantedRole: 'ADMIN',
          actorTenantId: 'tenant-alpha',
          targetTenantId: 'tenant-alpha',
        });
      });
    });
  });

  describe('Lifecycle State Invariants & Terminal Monotonicity', () => {
    it('allows valid monotonic forward transitions', () => {
      assert.doesNotThrow(() => {
        InvariantValidator.validateLifecycleTransition({
          entityId: 'inv-1',
          currentStatus: 'PENDING',
          targetStatus: 'PAID',
          requiredAmountStroops: 10_000_000n,
          settledAmountStroops: 10_000_000n,
        });
      });
    });

    it('strictly forbids reversal of terminal PAID state to PENDING or CANCELLED', () => {
      assert.throws(
        () => {
          InvariantValidator.validateLifecycleTransition({
            entityId: 'inv-1',
            currentStatus: 'PAID',
            targetStatus: 'PENDING',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'ILLEGAL_STATE_TRANSITION');
          return true;
        }
      );
    });

    it('rejects transition to PAID when settled amount is insufficient', () => {
      assert.throws(
        () => {
          InvariantValidator.validateLifecycleTransition({
            entityId: 'inv-1',
            currentStatus: 'PENDING',
            targetStatus: 'PAID',
            requiredAmountStroops: 10_000_000n,
            settledAmountStroops: 9_999_999n, // 1 stroop short
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'UNDERPAYMENT_SETTLEMENT_REJECTED');
          return true;
        }
      );
    });

    it('supports idempotent re-application of same state without error', () => {
      assert.doesNotThrow(() => {
        InvariantValidator.validateLifecycleTransition({
          entityId: 'inv-1',
          currentStatus: 'PAID',
          targetStatus: 'PAID',
        });
      });
    });
  });
});
