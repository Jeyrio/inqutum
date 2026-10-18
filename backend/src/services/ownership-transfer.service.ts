/**
 * Safe Ownership Transfer Service (Issue #300).
 *
 * Coordinates the multi-step lifecycle of ownership reassignment:
 *  1. Initiation with TTL and secret token.
 *  2. Verification and authorization gating.
 *  3. Pending state management with automatic/lazy expiration.
 *  4. Secure acceptance and atomic owner transition.
 *  5. Cancellation, rejection, and recovery paths.
 *
 * Time Complexity:
 *  - O(1) for initiate, accept, cancel, reject, and lookup operations.
 * Space Complexity:
 *  - O(T) where T is the number of active/historical transfer records.
 */

import crypto from 'crypto';
import {
  OwnershipTransferRecord,
  InitiateTransferInput,
  OwnershipTransferNotFoundError,
  UnauthorizedTransferError,
  UnauthorizedAcceptorError,
  SelfTransferForbiddenError,
  PendingTransferExistsError,
  OwnershipTransferExpiredError,
  InvalidTransferStateError,
  InvalidTargetOwnerError,
} from '../domain/ownership-transfer';

export interface OwnershipTransferAuditCallback {
  (event: {
    type: string;
    transferId: string;
    resourceType: string;
    resourceId: string;
    actorId: string;
    details: Record<string, unknown>;
  }): void;
}

export class OwnershipTransferService {
  private transfers = new Map<string, OwnershipTransferRecord>();
  private activePendingByResource = new Map<string, string>(); // resourceId -> transferId
  private tokenIndex = new Map<string, string>(); // transferToken -> transferId
  private resourceOwners = new Map<string, string>(); // resourceId -> currentOwnerId

  constructor(
    private readonly auditCallback?: OwnershipTransferAuditCallback,
    private readonly defaultTtlMs = 48 * 60 * 60 * 1000 // 48 hours
  ) {}

  /**
   * Set or seed the known owner of a resource for authorization testing and runtime verification.
   */
  public registerResourceOwner(resourceId: string, ownerId: string): void {
    this.resourceOwners.set(resourceId, ownerId);
  }

  /**
   * Retrieve the current registered owner of a resource.
   */
  public getResourceOwner(resourceId: string): string | undefined {
    return this.resourceOwners.get(resourceId);
  }

  /**
   * Initiates a safe ownership transfer with pending acceptance and expiry.
   *
   * Time Complexity: O(1)
   */
  public initiateTransfer(input: InitiateTransferInput): OwnershipTransferRecord {
    // 1. Authorization: verify initiator is the current owner
    const registeredOwner = this.resourceOwners.get(input.resourceId);
    if (registeredOwner && registeredOwner !== input.currentOwnerId) {
      throw new UnauthorizedTransferError(
        `Actor '${input.currentOwnerId}' is not the current owner of ${input.resourceType} '${input.resourceId}'.`
      );
    }

    // 2. Self-transfer guard
    if (input.currentOwnerId === input.targetOwnerId) {
      throw new SelfTransferForbiddenError();
    }

    // 3. Target owner validation
    if (!input.targetOwnerId || input.targetOwnerId.trim().length === 0) {
      throw new InvalidTargetOwnerError('Target owner ID or Stellar public key is required.');
    }

    // 4. Check for existing pending transfer for this resource
    const existingTransferId = this.activePendingByResource.get(input.resourceId);
    if (existingTransferId) {
      const existing = this.transfers.get(existingTransferId);
      if (existing && existing.status === 'PENDING_ACCEPTANCE') {
        // Evaluate expiry lazily
        if (Date.now() > existing.expiresAt.getTime()) {
          existing.status = 'EXPIRED';
          this.activePendingByResource.delete(input.resourceId);
        } else {
          throw new PendingTransferExistsError(existingTransferId);
        }
      }
    }

    // 5. Generate record with cryptographically secure token
    const id = crypto.randomUUID();
    const transferToken = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.defaultTtlMs;
    const expiresAt = new Date(now.getTime() + ttlMs);

    const record: OwnershipTransferRecord = {
      id,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      currentOwnerId: input.currentOwnerId,
      targetOwnerId: input.targetOwnerId,
      targetOwnerEmail: input.targetOwnerEmail?.toLowerCase().trim(),
      transferToken,
      status: 'PENDING_ACCEPTANCE',
      reason: input.reason || 'Ownership transfer requested by owner.',
      createdAt: now,
      expiresAt,
      previousOwnerRolePostTransfer: input.previousOwnerRolePostTransfer || 'ADMIN',
    };

    // Store records and indexes
    this.transfers.set(id, record);
    this.activePendingByResource.set(input.resourceId, id);
    this.tokenIndex.set(transferToken, id);
    if (!this.resourceOwners.has(input.resourceId)) {
      this.resourceOwners.set(input.resourceId, input.currentOwnerId);
    }

    this.emitAudit('OWNERSHIP_TRANSFER_INITIATED', record, input.currentOwnerId, {
      targetOwnerId: input.targetOwnerId,
      expiresAt: expiresAt.toISOString(),
    });

    return record;
  }

  /**
   * Accepts a pending ownership transfer using the transfer ID or secret token.
   * Atomically reassigns ownership to the nominated target owner.
   *
   * Time Complexity: O(1)
   */
  public acceptTransfer(transferIdOrToken: string, acceptorId: string): OwnershipTransferRecord {
    const transfer = this.findTransferByIdOrToken(transferIdOrToken);
    if (!transfer) {
      throw new OwnershipTransferNotFoundError(transferIdOrToken);
    }

    // 1. Authorization: Only the nominated target owner can accept
    if (transfer.targetOwnerId !== acceptorId) {
      throw new UnauthorizedAcceptorError(
        `Actor '${acceptorId}' is not the nominated target owner for this transfer.`
      );
    }

    // 2. Status validation
    if (transfer.status !== 'PENDING_ACCEPTANCE') {
      throw new InvalidTransferStateError(transfer.status);
    }

    // 3. Expiry check
    if (Date.now() > transfer.expiresAt.getTime()) {
      transfer.status = 'EXPIRED';
      this.activePendingByResource.delete(transfer.resourceId);
      this.emitAudit('OWNERSHIP_TRANSFER_EXPIRED', transfer, acceptorId, {});
      throw new OwnershipTransferExpiredError();
    }

    // 4. Atomic execution: reassign owner
    const previousOwnerId = transfer.currentOwnerId;
    transfer.status = 'ACCEPTED';
    transfer.acceptedAt = new Date();
    this.resourceOwners.set(transfer.resourceId, transfer.targetOwnerId);
    this.activePendingByResource.delete(transfer.resourceId);

    this.emitAudit('OWNERSHIP_TRANSFER_ACCEPTED', transfer, acceptorId, {
      previousOwnerId,
      newOwnerId: transfer.targetOwnerId,
      previousOwnerRole: transfer.previousOwnerRolePostTransfer,
    });

    return transfer;
  }

  /**
   * Cancels a pending ownership transfer. Can only be performed by the current owner.
   *
   * Time Complexity: O(1)
   */
  public cancelTransfer(transferId: string, actorId: string, reason?: string): OwnershipTransferRecord {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new OwnershipTransferNotFoundError(transferId);
    }

    // Authorization: Only the current owner can cancel
    if (transfer.currentOwnerId !== actorId) {
      throw new UnauthorizedTransferError(
        `Only the current owner ('${transfer.currentOwnerId}') can cancel this ownership transfer.`
      );
    }

    if (transfer.status !== 'PENDING_ACCEPTANCE') {
      throw new InvalidTransferStateError(transfer.status);
    }

    transfer.status = 'CANCELLED';
    transfer.cancelledAt = new Date();
    this.activePendingByResource.delete(transfer.resourceId);

    this.emitAudit('OWNERSHIP_TRANSFER_CANCELLED', transfer, actorId, {
      reason: reason || 'Cancelled by current owner',
    });

    return transfer;
  }

  /**
   * Declines a pending ownership transfer. Can only be performed by the nominated target owner.
   *
   * Time Complexity: O(1)
   */
  public rejectTransfer(transferId: string, actorId: string, reason?: string): OwnershipTransferRecord {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new OwnershipTransferNotFoundError(transferId);
    }

    // Authorization: Only the nominated target owner can decline
    if (transfer.targetOwnerId !== actorId) {
      throw new UnauthorizedAcceptorError(
        `Only the nominated target owner ('${transfer.targetOwnerId}') can decline this transfer.`
      );
    }

    if (transfer.status !== 'PENDING_ACCEPTANCE') {
      throw new InvalidTransferStateError(transfer.status);
    }

    transfer.status = 'REJECTED';
    transfer.rejectedAt = new Date();
    this.activePendingByResource.delete(transfer.resourceId);

    this.emitAudit('OWNERSHIP_TRANSFER_REJECTED', transfer, actorId, {
      reason: reason || 'Declined by nominee',
    });

    return transfer;
  }

  /**
   * Fetches an ownership transfer record by ID with lazy expiry resolution.
   *
   * Time Complexity: O(1)
   */
  public getTransfer(transferId: string): OwnershipTransferRecord | undefined {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return undefined;

    if (transfer.status === 'PENDING_ACCEPTANCE' && Date.now() > transfer.expiresAt.getTime()) {
      transfer.status = 'EXPIRED';
      this.activePendingByResource.delete(transfer.resourceId);
    }

    return transfer;
  }

  /**
   * Lists all transfer history for a given resource.
   *
   * Time Complexity: O(T)
   */
  public listTransfers(resourceId: string): OwnershipTransferRecord[] {
    const results: OwnershipTransferRecord[] = [];
    const now = Date.now();

    for (const record of this.transfers.values()) {
      if (record.resourceId === resourceId) {
        if (record.status === 'PENDING_ACCEPTANCE' && now > record.expiresAt.getTime()) {
          record.status = 'EXPIRED';
          this.activePendingByResource.delete(resourceId);
        }
        results.push(record);
      }
    }

    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private findTransferByIdOrToken(idOrToken: string): OwnershipTransferRecord | undefined {
    if (this.transfers.has(idOrToken)) {
      return this.transfers.get(idOrToken);
    }
    const idFromToken = this.tokenIndex.get(idOrToken);
    if (idFromToken) {
      return this.transfers.get(idFromToken);
    }
    return undefined;
  }

  private emitAudit(
    type: string,
    record: OwnershipTransferRecord,
    actorId: string,
    details: Record<string, unknown>
  ): void {
    if (this.auditCallback) {
      this.auditCallback({
        type,
        transferId: record.id,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        actorId,
        details,
      });
    }
  }
}
