/**
 * Deterministic Conflict Resolver for Multi-Client Edits (Issue #284).
 *
 * Implements a deterministic three-way merge algorithm and conflict resolution
 * engine for concurrent updates from multiple clients, tabs, or offline queues.
 *
 * Architecture & Invariants:
 *  - Deterministic 3-Way Merge: Base ($V_{base}$), Server Truth ($V_{server}$), and Incoming Client ($V_{client}$).
 *  - Field-Level Granularity: Non-overlapping edits to distinct fields merge cleanly without data loss.
 *  - Deep Metadata Merge: JSONB metadata subkeys merge recursively.
 *  - Immutability Guards: Financial and settlement identity fields (amount, memo, asset, txHash, addresses)
 *    are strictly immutable and reject modification attempts.
 *  - Terminal State Protection: Invoices in terminal states (PAID, CANCELLED, EXPIRED) reject edits.
 *  - Deterministic Tie-Breaking: When identical fields have concurrent differing edits, deterministic
 *    tie-breaking resolves based on strategy (timestamp, actor identity, or explicit server-truth retention).
 *
 * Time Complexity:
 *  - O(F) where F is the number of edited fields (O(1) average per field using Maps/Sets).
 * Space Complexity:
 *  - O(F) to construct the merged invoice delta and resolution report.
 */

import type { StoredInvoice } from '../storage/invoice-storage';

export type ConflictResolutionStrategy =
  | 'AUTO_MERGE'       // Deterministic 3-way merge: non-conflicting fields merge cleanly, collisions tie-break deterministically
  | 'SERVER_WINS'      // On field collision, server truth takes precedence
  | 'CLIENT_WINS'      // On field collision, incoming client edit takes precedence (requires authorization)
  | 'STRICT';          // On any conflicting field collision, refuse merge and return unresolvable conflict report

export interface ConflictResolverOptions {
  strategy?: ConflictResolutionStrategy;
  clientTimestamp?: number;
  actorId?: string;
  actorRole?: 'OWNER' | 'ADMIN' | 'SELLER' | 'COLLABORATOR' | 'VIEWER';
}

export interface FieldResolutionDetail {
  field: string;
  baseValue: unknown;
  serverValue: unknown;
  clientValue: unknown;
  chosenValue: unknown;
  resolution: 'CLEAN_MERGE' | 'CONVERGENT' | 'TIE_BREAK_CLIENT' | 'TIE_BREAK_SERVER' | 'MANUAL_REQUIRED';
  reason: string;
}

export interface UnresolvedFieldConflict {
  field: string;
  serverValue: unknown;
  clientValue: unknown;
  reason: string;
}

export interface ConflictResolutionResult {
  resolved: boolean;
  hasConflicts: boolean;
  mergedInvoice: StoredInvoice | null;
  resolvedFields: FieldResolutionDetail[];
  unresolvedFields: UnresolvedFieldConflict[];
  baseVersion: number;
  serverVersion: number;
  newVersion: number;
  summary: string;
}

export class ConflictResolverError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 409) {
    super(message);
    this.name = 'ConflictResolverError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ImmutableFieldConflictError extends ConflictResolverError {
  constructor(field: string) {
    super(
      'IMMUTABLE_FIELD_CONFLICT',
      `Modification of immutable invoice field '${field}' is strictly prohibited. Financial and settlement parameters cannot be changed.`,
      400
    );
    this.name = 'ImmutableFieldConflictError';
  }
}

export class TerminalStatusConflictError extends ConflictResolverError {
  constructor(status: string) {
    super(
      'TERMINAL_STATUS_CONFLICT',
      `Invoice is in terminal status '${status}'. Edits to settled, cancelled, or expired invoices are strictly prohibited.`,
      409
    );
    this.name = 'TerminalStatusConflictError';
  }
}

export class UnauthorizedEditError extends ConflictResolverError {
  constructor(actorId?: string) {
    super(
      'UNAUTHORIZED_EDIT',
      `Actor '${actorId || 'unknown'}' is not authorized to edit this invoice.`,
      403
    );
    this.name = 'UnauthorizedEditError';
  }
}

/** Fields that can never be modified post-creation under any circumstances */
export const IMMUTABLE_FIELDS = new Set<string>([
  'id',
  'sellerPublicKey',
  'amount',
  'assetCode',
  'assetIssuer',
  'memo',
  'createdAt',
  'paymentTxHash',
  'payerPublicKey',
  'paidAt',
]);

/** Fields that are safely editable by authorized sellers/collaborators */
export const EDITABLE_FIELDS = new Set<string>([
  'description',
  'customerName',
  'customerEmail',
  'sellerName',
  'sellerEmail',
  'metadata',
  'expiresAt',
]);

/**
 * Deep equality check for scalar and JSON-compatible values.
 * O(K) where K is number of nested keys.
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!isDeepEqual((a as any)[key], (b as any)[key])) return false;
  }

  return true;
}

/**
 * Recursively merge JSON metadata objects.
 */
function mergeMetadataObjects(
  base: Record<string, unknown> = {},
  server: Record<string, unknown> = {},
  client: Record<string, unknown> = {},
  strategy: ConflictResolutionStrategy,
  clientTimestamp: number,
  serverTimestamp: number,
  actorId: string
): { merged: Record<string, unknown>; collisions: string[] } {
  const allKeys = new Set([...Object.keys(base), ...Object.keys(server), ...Object.keys(client)]);
  const merged: Record<string, unknown> = {};
  const collisions: string[] = [];

  for (const key of allKeys) {
    const valBase = base[key];
    const valServer = server[key];
    const valClient = client[key];

    // Case 1: Client didn't touch it -> take server
    if (isDeepEqual(valBase, valClient)) {
      if (valServer !== undefined) merged[key] = valServer;
      continue;
    }

    // Case 2: Server didn't touch it -> take client
    if (isDeepEqual(valBase, valServer)) {
      if (valClient !== undefined) merged[key] = valClient;
      continue;
    }

    // Case 3: Both changed to identical value -> convergent
    if (isDeepEqual(valServer, valClient)) {
      if (valClient !== undefined) merged[key] = valClient;
      continue;
    }

    // Case 4: Both changed to objects -> recurse
    if (
      valServer !== null &&
      typeof valServer === 'object' &&
      !Array.isArray(valServer) &&
      valClient !== null &&
      typeof valClient === 'object' &&
      !Array.isArray(valClient)
    ) {
      const nestedBase = (valBase !== null && typeof valBase === 'object' && !Array.isArray(valBase))
        ? (valBase as Record<string, unknown>)
        : {};
      const sub = mergeMetadataObjects(
        nestedBase,
        valServer as Record<string, unknown>,
        valClient as Record<string, unknown>,
        strategy,
        clientTimestamp,
        serverTimestamp,
        actorId
      );
      merged[key] = sub.merged;
      if (sub.collisions.length > 0) {
        collisions.push(...sub.collisions.map((c) => `${key}.${c}`));
      }
      continue;
    }

    // Case 5: Collision on scalar or array
    if (strategy === 'SERVER_WINS') {
      if (valServer !== undefined) merged[key] = valServer;
    } else if (strategy === 'CLIENT_WINS') {
      if (valClient !== undefined) merged[key] = valClient;
    } else if (strategy === 'AUTO_MERGE') {
      // Deterministic tie breaker: clientTimestamp > serverTimestamp, or lexicographical actor ID tie-break
      const clientWins = clientTimestamp > serverTimestamp || (clientTimestamp === serverTimestamp && actorId > 'server');
      merged[key] = clientWins ? valClient : valServer;
    } else {
      // STRICT
      collisions.push(key);
    }
  }

  return { merged, collisions };
}

/**
 * Deterministically resolves multi-client concurrent edits using a 3-way merge.
 *
 * @param base Snapshot invoice state observed by the client when edit began
 * @param server Current authoritative invoice state on server
 * @param client Incoming client edit payload
 * @param options Resolution configuration and actor context
 *
 * Time Complexity: O(F) where F is the number of fields in the edit payload.
 * Space Complexity: O(F) to allocate the merged invoice representation.
 */
export function resolveMultiClientConflict(
  base: StoredInvoice,
  server: StoredInvoice,
  client: Partial<StoredInvoice>,
  options: ConflictResolverOptions = {}
): ConflictResolutionResult {
  const strategy = options.strategy || 'AUTO_MERGE';
  const clientTimestamp = options.clientTimestamp || Date.now();
  const serverTimestamp = server.paidAt?.getTime() || server.createdAt.getTime();
  const actorId = options.actorId || 'client';

  // 1. Terminal State Check: strictly disallow edits if server state is terminal
  if (server.status === 'PAID' || server.status === 'CANCELLED' || server.status === 'EXPIRED') {
    throw new TerminalStatusConflictError(server.status);
  }

  // 2. Authorization check
  if (options.actorRole === 'VIEWER') {
    throw new UnauthorizedEditError(actorId);
  }

  const baseVersion = base.version ?? 1;
  const serverVersion = server.version ?? 1;
  const resolvedFields: FieldResolutionDetail[] = [];
  const unresolvedFields: UnresolvedFieldConflict[] = [];

  // Clone server state as base for merged result
  const merged: StoredInvoice = {
    ...server,
    metadata: server.metadata ? JSON.parse(JSON.stringify(server.metadata)) : {},
  };

  let hasConflicts = false;

  // 3. Inspect every field in the incoming client update
  for (const [key, clientVal] of Object.entries(client)) {
    if (key === 'version' || key === '_schemaVersion') {
      continue;
    }

    // Guard: Immutable fields
    if (IMMUTABLE_FIELDS.has(key)) {
      const baseVal = (base as any)[key];
      if (!isDeepEqual(baseVal, clientVal)) {
        throw new ImmutableFieldConflictError(key);
      }
      continue;
    }

    if (!EDITABLE_FIELDS.has(key)) {
      // Ignore undeclared / internal fields
      continue;
    }

    const baseVal = (base as any)[key];
    const serverVal = (server as any)[key];

    // Case A: Client did not modify this field relative to base -> Keep server
    if (isDeepEqual(baseVal, clientVal)) {
      continue;
    }

    // Case B: Server did not modify this field relative to base -> Clean merge client's change
    if (isDeepEqual(baseVal, serverVal)) {
      (merged as any)[key] = clientVal;
      resolvedFields.push({
        field: key,
        baseValue: baseVal,
        serverValue: serverVal,
        clientValue: clientVal,
        chosenValue: clientVal,
        resolution: 'CLEAN_MERGE',
        reason: 'Client modified field while server was unchanged; adopted client edit.',
      });
      continue;
    }

    // Case C: Both modified to identical value -> Convergent
    if (isDeepEqual(serverVal, clientVal)) {
      (merged as any)[key] = clientVal;
      resolvedFields.push({
        field: key,
        baseValue: baseVal,
        serverValue: serverVal,
        clientValue: clientVal,
        chosenValue: clientVal,
        resolution: 'CONVERGENT',
        reason: 'Both sessions set identical value; convergent resolution.',
      });
      continue;
    }

    // Case D: Collision! Both modified to different values
    hasConflicts = true;

    if (key === 'metadata') {
      const baseMeta = (base.metadata && typeof base.metadata === 'object') ? base.metadata : {};
      const serverMeta = (server.metadata && typeof server.metadata === 'object') ? server.metadata : {};
      const clientMeta = (clientVal && typeof clientVal === 'object') ? (clientVal as Record<string, unknown>) : {};

      const metaRes = mergeMetadataObjects(
        baseMeta,
        serverMeta,
        clientMeta,
        strategy,
        clientTimestamp,
        serverTimestamp,
        actorId
      );

      if (metaRes.collisions.length > 0 && strategy === 'STRICT') {
        unresolvedFields.push({
          field: 'metadata',
          serverValue: serverMeta,
          clientValue: clientMeta,
          reason: `Collisions in nested metadata keys: ${metaRes.collisions.join(', ')}`,
        });
      } else {
        merged.metadata = metaRes.merged;
        resolvedFields.push({
          field: 'metadata',
          baseValue: baseMeta,
          serverValue: serverMeta,
          clientValue: clientMeta,
          chosenValue: metaRes.merged,
          resolution: strategy === 'SERVER_WINS' ? 'TIE_BREAK_SERVER' : 'TIE_BREAK_CLIENT',
          reason: 'Deep-merged nested metadata using deterministic field resolution.',
        });
      }
      continue;
    }

    // Scalar collision resolution based on strategy
    switch (strategy) {
      case 'SERVER_WINS': {
        (merged as any)[key] = serverVal;
        resolvedFields.push({
          field: key,
          baseValue: baseVal,
          serverValue: serverVal,
          clientValue: clientVal,
          chosenValue: serverVal,
          resolution: 'TIE_BREAK_SERVER',
          reason: 'Conflict resolved via SERVER_WINS strategy; preserved server truth.',
        });
        break;
      }
      case 'CLIENT_WINS': {
        (merged as any)[key] = clientVal;
        resolvedFields.push({
          field: key,
          baseValue: baseVal,
          serverValue: serverVal,
          clientValue: clientVal,
          chosenValue: clientVal,
          resolution: 'TIE_BREAK_CLIENT',
          reason: 'Conflict resolved via CLIENT_WINS strategy; applied client update.',
        });
        break;
      }
      case 'AUTO_MERGE': {
        // Deterministic tie-breaking:
        // 1. Highest timestamp wins
        // 2. If equal, lexicographical actor ID tie-break
        const clientWins =
          clientTimestamp > serverTimestamp ||
          (clientTimestamp === serverTimestamp && actorId.localeCompare('server') > 0);

        const chosen = clientWins ? clientVal : serverVal;
        (merged as any)[key] = chosen;
        resolvedFields.push({
          field: key,
          baseValue: baseVal,
          serverValue: serverVal,
          clientValue: clientVal,
          chosenValue: chosen,
          resolution: clientWins ? 'TIE_BREAK_CLIENT' : 'TIE_BREAK_SERVER',
          reason: clientWins
            ? `Deterministic auto-merge: client timestamp (${clientTimestamp}) or actorId won tie-break.`
            : `Deterministic auto-merge: server timestamp (${serverTimestamp}) won tie-break.`,
        });
        break;
      }
      case 'STRICT':
      default: {
        unresolvedFields.push({
          field: key,
          serverValue: serverVal,
          clientValue: clientVal,
          reason: `Concurrent divergent modification to '${key}'. Base: '${String(baseVal)}', Server: '${String(serverVal)}', Client: '${String(clientVal)}'.`,
        });
        break;
      }
    }
  }

  const isResolved = unresolvedFields.length === 0;
  const newVersion = isResolved ? serverVersion + 1 : serverVersion;
  if (isResolved) {
    merged.version = newVersion;
  }

  const summary = isResolved
    ? hasConflicts
      ? `Deterministic merge succeeded with ${resolvedFields.length} field(s) resolved (version ${serverVersion} -> ${newVersion}).`
      : `Clean merge succeeded with 0 conflicts (version ${serverVersion} -> ${newVersion}).`
    : `Conflict resolution failed with ${unresolvedFields.length} unresolvable field collision(s). Manual intervention required.`;

  return {
    resolved: isResolved,
    hasConflicts,
    mergedInvoice: isResolved ? merged : null,
    resolvedFields,
    unresolvedFields,
    baseVersion,
    serverVersion,
    newVersion,
    summary,
  };
}
