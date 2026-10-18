/**
 * Safe Ownership Transfer Domain Model (Issue #300).
 *
 * Implements two-step ownership transfer with pending acceptance and time-based
 * expiration. Protects accounts and organizations against accidental lockouts,
 * typographical destination errors, and unauthorized takeovers.
 *
 * Invariants:
 *  - Two-Step Handshake: Transfer must be explicitly initiated by current OWNER,
 *    and explicitly accepted by the nominated TARGET.
 *  - Time-Bounded Expiry: Transfers automatically expire after a configurable TTL
 *    (default: 48 hours). Expired transfers cannot be accepted.
 *  - Revocation Guarantee: The current owner retains authority and can cancel
 *    the transfer anytime before acceptance.
 *  - Nominee Rejection: Nominated target can decline the transfer.
 *  - Self-Transfer Guard: Initiator cannot nominate themselves.
 *  - Role Reassignment: On acceptance, original owner is demoted to a safe role
 *    (default: ADMIN), preventing orphaned resources and multi-owner anomalies.
 */

export type OwnershipTransferStatus =
  | 'PENDING_ACCEPTANCE'
  | 'ACCEPTED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export type PostTransferPreviousOwnerRole = 'ADMIN' | 'COLLABORATOR' | 'NONE';

export interface OwnershipTransferRecord {
  id: string;
  resourceType: 'SELLER_ACCOUNT' | 'ORGANIZATION';
  resourceId: string;
  currentOwnerId: string;
  targetOwnerId: string;
  targetOwnerEmail?: string;
  transferToken: string;
  status: OwnershipTransferStatus;
  reason: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
  cancelledAt?: Date;
  rejectedAt?: Date;
  previousOwnerRolePostTransfer: PostTransferPreviousOwnerRole;
}

export interface InitiateTransferInput {
  resourceType: 'SELLER_ACCOUNT' | 'ORGANIZATION';
  resourceId: string;
  currentOwnerId: string;
  targetOwnerId: string;
  targetOwnerEmail?: string;
  reason: string;
  ttlMs?: number;
  previousOwnerRolePostTransfer?: PostTransferPreviousOwnerRole;
}

export class OwnershipTransferError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'OwnershipTransferError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class UnauthorizedTransferError extends OwnershipTransferError {
  constructor(message = 'Only the verified resource owner can perform this transfer operation.') {
    super('UNAUTHORIZED_OWNERSHIP_OPERATION', message, 403);
    this.name = 'UnauthorizedTransferError';
  }
}

export class UnauthorizedAcceptorError extends OwnershipTransferError {
  constructor(message = 'Only the nominated target owner can accept or decline this transfer.') {
    super('UNAUTHORIZED_ACCEPTOR', message, 403);
    this.name = 'UnauthorizedAcceptorError';
  }
}

export class SelfTransferForbiddenError extends OwnershipTransferError {
  constructor() {
    super(
      'SELF_TRANSFER_FORBIDDEN',
      'Target owner cannot be identical to the current owner.',
      400
    );
    this.name = 'SelfTransferForbiddenError';
  }
}

export class PendingTransferExistsError extends OwnershipTransferError {
  constructor(transferId: string) {
    super(
      'PENDING_TRANSFER_EXISTS',
      `A pending ownership transfer (${transferId}) is already active for this resource. Cancel it before initiating a new one.`,
      409
    );
    this.name = 'PendingTransferExistsError';
  }
}

export class OwnershipTransferNotFoundError extends OwnershipTransferError {
  constructor(transferId: string) {
    super(
      'TRANSFER_NOT_FOUND',
      `Ownership transfer request '${transferId}' was not found.`,
      404
    );
    this.name = 'OwnershipTransferNotFoundError';
  }
}

export class OwnershipTransferExpiredError extends OwnershipTransferError {
  constructor() {
    super(
      'TRANSFER_EXPIRED',
      'This ownership transfer invitation has expired and can no longer be accepted.',
      410
    );
    this.name = 'OwnershipTransferExpiredError';
  }
}

export class InvalidTransferStateError extends OwnershipTransferError {
  constructor(status: OwnershipTransferStatus) {
    super(
      'INVALID_TRANSFER_STATE',
      `Operation cannot be performed on ownership transfer in status '${status}'. Must be 'PENDING_ACCEPTANCE'.`,
      409
    );
    this.name = 'InvalidTransferStateError';
  }
}

export class InvalidTargetOwnerError extends OwnershipTransferError {
  constructor(reason: string) {
    super('INVALID_TARGET_OWNER', `Target owner invalid: ${reason}`, 400);
    this.name = 'InvalidTargetOwnerError';
  }
}
