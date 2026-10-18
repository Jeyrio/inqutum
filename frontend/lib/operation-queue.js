/**
 * Conflict-aware offline and multi-tab operation queue (Issue #265).
 *
 * Requirements:
 *  - Queued mutations survive page refreshes and network disconnects.
 *  - Detects stale state conflicts (concurrency version divergence, unexpected target status).
 *  - Exposes deterministic choices for operators and UI: RETRY_WITH_LATEST, DISCARD, FORCE_APPLY.
 *  - Coordinates across browser tabs via BroadcastChannel or storage events to prevent race conditions.
 *  - Implemented as CommonJS for universal Node.js test runner and browser compatibility.
 */

const STORAGE_KEY = 'inqutum_operation_queue_v1';
const CHANNEL_NAME = 'inqutum_operation_queue_sync';

/**
 * Status of a queued operation.
 */
const OperationStatus = Object.freeze({
  QUEUED: 'QUEUED',
  IN_FLIGHT: 'IN_FLIGHT',
  COMMITTED: 'COMMITTED',
  CONFLICT: 'CONFLICT',
  DISCARDED: 'DISCARDED',
  FAILED: 'FAILED',
});

/**
 * Deterministic resolution actions for a detected conflict.
 */
const ConflictResolutionAction = Object.freeze({
  RETRY_WITH_LATEST: 'RETRY_WITH_LATEST',
  DISCARD: 'DISCARD',
  FORCE_APPLY: 'FORCE_APPLY',
});

class OperationQueue {
  constructor(options = {}) {
    this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.broadcastChannel = options.broadcastChannel || null;
    this.now = options.now || (() => new Date());
    this.maxRetries = options.maxRetries ?? 3;
    this.operations = new Map();
    this.listeners = new Set();
    this.tabId = options.tabId || `tab_${Math.random().toString(36).substring(2, 9)}`;

    this.initChannel();
    this.loadFromStorage();
  }

  initChannel() {
    if (!this.broadcastChannel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
        if (typeof this.broadcastChannel.unref === 'function') {
          this.broadcastChannel.unref();
        }
      } catch {
        this.broadcastChannel = null;
      }
    }

    if (this.broadcastChannel && typeof this.broadcastChannel.addEventListener === 'function') {
      this.channelHandler = (event) => {
        const message = event.data;
        if (!message || message.sourceTabId === this.tabId) return;

        if (message.type === 'QUEUE_MUTATED') {
          this.loadFromStorage(false);
          this.notifyListeners('REMOTE_SYNC', message.payload);
        }
      };
      this.broadcastChannel.addEventListener('message', this.channelHandler);
    }
  }

  close() {
    if (this.broadcastChannel) {
      if (this.channelHandler && typeof this.broadcastChannel.removeEventListener === 'function') {
        this.broadcastChannel.removeEventListener('message', this.channelHandler);
      }
      if (typeof this.broadcastChannel.close === 'function') {
        this.broadcastChannel.close();
      }
      this.broadcastChannel = null;
    }
  }

  loadFromStorage(triggerPersist = true) {
    if (!this.storage) return;

    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;

      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        this.operations.clear();
        for (const item of items) {
          // If in-flight on reload, reset to QUEUED to resume execution
          if (item.status === OperationStatus.IN_FLIGHT) {
            item.status = OperationStatus.QUEUED;
          }
          this.operations.set(item.id, item);
        }
      }
    } catch (err) {
      console.error('[OperationQueue] Failed to load operations from storage:', err);
    }

    if (triggerPersist) {
      this.persistToStorage();
    }
  }

  persistToStorage() {
    if (!this.storage) return;

    try {
      const items = Array.from(this.operations.values());
      this.storage.setItem(STORAGE_KEY, JSON.stringify(items));
      this.broadcastUpdate('QUEUE_MUTATED', { count: items.length });
    } catch (err) {
      console.error('[OperationQueue] Failed to persist operations to storage:', err);
    }
  }

  broadcastUpdate(type, payload) {
    if (this.broadcastChannel && typeof this.broadcastChannel.postMessage === 'function') {
      try {
        this.broadcastChannel.postMessage({
          type,
          sourceTabId: this.tabId,
          payload,
          timestamp: this.now().toISOString(),
        });
      } catch {
        // Channel unavailable or closed
      }
    }
  }

  enqueue(op) {
    if (!op || !op.type || !op.entityId) {
      throw new Error('Operation must specify type and entityId');
    }

    const id = op.id || `op_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const operation = {
      id,
      type: op.type,
      entityId: op.entityId,
      payload: op.payload || {},
      baseVersion: op.baseVersion ?? 1,
      baseStatus: op.baseStatus ?? 'PENDING',
      status: OperationStatus.QUEUED,
      attempts: 0,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      conflict: null,
      error: null,
    };

    this.operations.set(id, operation);
    this.persistToStorage();
    this.notifyListeners('ENQUEUED', operation);
    return operation;
  }

  /**
   * Evaluates if applying this operation against the latest entity state
   * causes a concurrency conflict.
   */
  evaluateConflict(operation, currentState) {
    if (!currentState) {
      return {
        hasConflict: true,
        reason: 'ENTITY_NOT_FOUND',
        message: `Target entity ${operation.entityId} does not exist in authoritative storage.`,
        expected: { version: operation.baseVersion, status: operation.baseStatus },
        actual: null,
      };
    }

    // Status conflict: target state transitioned to terminal state (e.g. PAID or CANCELLED)
    if (operation.baseStatus && currentState.status && currentState.status !== operation.baseStatus) {
      const isTerminalConflict =
        currentState.status === 'PAID' ||
        currentState.status === 'CANCELLED' ||
        currentState.status === 'EXPIRED';

      if (isTerminalConflict && operation.type !== 'GET') {
        return {
          hasConflict: true,
          reason: 'TERMINAL_STATUS_CONFLICT',
          message: `Status divergence: entity transitioned to terminal state [${currentState.status}], invalidating pending mutation from [${operation.baseStatus}].`,
          expected: { version: operation.baseVersion, status: operation.baseStatus },
          actual: { version: currentState.version, status: currentState.status },
        };
      }
    }

    // Version conflict: optimistic lock detection
    if (typeof currentState.version === 'number' && currentState.version !== operation.baseVersion) {
      return {
        hasConflict: true,
        reason: 'VERSION_MISMATCH',
        message: `Version conflict: client expected version ${operation.baseVersion}, but storage truth is at version ${currentState.version}.`,
        expected: { version: operation.baseVersion, status: operation.baseStatus },
        actual: { version: currentState.version, status: currentState.status },
      };
    }

    return { hasConflict: false };
  }

  /**
   * Processes a queued operation through an execution callback with conflict detection.
   */
  async processOperation(operationId, currentStateFetcher, executor) {
    const op = this.operations.get(operationId);
    if (!op) throw new Error(`Operation ${operationId} not found`);

    if (op.status !== OperationStatus.QUEUED && op.status !== OperationStatus.FAILED) {
      return op;
    }

    op.status = OperationStatus.IN_FLIGHT;
    op.attempts += 1;
    op.updatedAt = this.now().toISOString();
    this.persistToStorage();

    try {
      const currentState = await currentStateFetcher(op.entityId);
      const conflictCheck = this.evaluateConflict(op, currentState);

      if (conflictCheck.hasConflict) {
        op.status = OperationStatus.CONFLICT;
        op.conflict = conflictCheck;
        op.updatedAt = this.now().toISOString();
        this.persistToStorage();
        this.notifyListeners('CONFLICT_DETECTED', op);
        return op;
      }

      // Execute mutation
      const result = await executor(op, currentState);
      op.status = OperationStatus.COMMITTED;
      op.result = result;
      op.updatedAt = this.now().toISOString();
      this.persistToStorage();
      this.notifyListeners('COMMITTED', op);
      return op;
    } catch (err) {
      const isExhausted = op.attempts >= this.maxRetries;
      op.status = isExhausted ? OperationStatus.FAILED : OperationStatus.QUEUED;
      op.error = err instanceof Error ? err.message : String(err);
      op.updatedAt = this.now().toISOString();
      this.persistToStorage();
      this.notifyListeners('ERROR', op);
      return op;
    }
  }

  /**
   * Deterministically resolves a conflict based on user/operator choice.
   */
  resolveConflict(operationId, action, latestState) {
    const op = this.operations.get(operationId);
    if (!op) throw new Error(`Operation ${operationId} not found`);
    if (op.status !== OperationStatus.CONFLICT) {
      throw new Error(`Operation ${operationId} is not in CONFLICT status (current: ${op.status})`);
    }

    switch (action) {
      case ConflictResolutionAction.DISCARD: {
        op.status = OperationStatus.DISCARDED;
        op.conflict = null;
        op.updatedAt = this.now().toISOString();
        this.persistToStorage();
        this.notifyListeners('DISCARDED', op);
        return op;
      }

      case ConflictResolutionAction.RETRY_WITH_LATEST: {
        if (!latestState) {
          throw new Error('RETRY_WITH_LATEST requires latest authoritative state');
        }
        op.baseVersion = latestState.version ?? op.baseVersion;
        op.baseStatus = latestState.status ?? op.baseStatus;
        op.status = OperationStatus.QUEUED;
        op.conflict = null;
        op.error = null;
        op.updatedAt = this.now().toISOString();
        this.persistToStorage();
        this.notifyListeners('RETRY_QUEUED', op);
        return op;
      }

      case ConflictResolutionAction.FORCE_APPLY: {
        op.status = OperationStatus.QUEUED;
        op.conflict = null;
        // Bump version assumption to force attempt
        if (latestState?.version) {
          op.baseVersion = latestState.version;
        }
        op.updatedAt = this.now().toISOString();
        this.persistToStorage();
        this.notifyListeners('FORCE_QUEUED', op);
        return op;
      }

      default:
        throw new Error(`Unsupported conflict resolution action: ${action}`);
    }
  }

  getOperation(id) {
    return this.operations.get(id) || null;
  }

  getPendingOperations() {
    return Array.from(this.operations.values()).filter(
      (op) => op.status === OperationStatus.QUEUED || op.status === OperationStatus.IN_FLIGHT
    );
  }

  getConflictedOperations() {
    return Array.from(this.operations.values()).filter(
      (op) => op.status === OperationStatus.CONFLICT
    );
  }

  getAllOperations() {
    return Array.from(this.operations.values());
  }

  clearCompleted() {
    let cleared = 0;
    for (const [id, op] of Array.from(this.operations.entries())) {
      if (op.status === OperationStatus.COMMITTED || op.status === OperationStatus.DISCARDED) {
        this.operations.delete(id);
        cleared++;
      }
    }
    if (cleared > 0) {
      this.persistToStorage();
    }
    return cleared;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyListeners(event, data) {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error('[OperationQueue] Listener error:', err);
      }
    }
  }
}

module.exports = {
  OperationQueue,
  OperationStatus,
  ConflictResolutionAction,
  STORAGE_KEY,
  CHANNEL_NAME,
};
