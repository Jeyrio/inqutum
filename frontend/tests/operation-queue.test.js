const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OperationQueue,
  OperationStatus,
  ConflictResolutionAction,
  STORAGE_KEY,
} = require('../lib/operation-queue');

// Mock in-memory Web Storage
function createMockStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

// Mock BroadcastChannel
function createMockBroadcastChannel() {
  const listeners = [];
  return {
    listeners,
    addEventListener: (event, handler) => listeners.push(handler),
    removeEventListener: (event, handler) => {
      const idx = listeners.indexOf(handler);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    postMessage: (data) => {
      // Simulate broadcasting to other tabs
      for (const fn of listeners) {
        fn({ data });
      }
    },
  };
}

test('OperationQueue: enqueues work and persists to storage across simulated refresh', () => {
  const storage = createMockStorage();
  const queue1 = new OperationQueue({ storage });

  const op = queue1.enqueue({
    type: 'CANCEL_INVOICE',
    entityId: 'inv-101',
    payload: { reason: 'Customer requested cancellation' },
    baseVersion: 1,
    baseStatus: 'PENDING',
  });

  assert.equal(op.entityId, 'inv-101');
  assert.equal(op.status, OperationStatus.QUEUED);
  assert.ok(storage.getItem(STORAGE_KEY), 'Stored in localStorage');

  // Simulate page refresh by creating a new queue instance with the same storage
  const queue2 = new OperationQueue({ storage });
  const restored = queue2.getOperation(op.id);

  assert.ok(restored, 'Operation survived refresh');
  assert.equal(restored.entityId, 'inv-101');
  assert.equal(restored.status, OperationStatus.QUEUED);
});

test('OperationQueue: processes successful operation when versions match', async () => {
  const storage = createMockStorage();
  const queue = new OperationQueue({ storage });

  const op = queue.enqueue({
    type: 'UPDATE_INVOICE',
    entityId: 'inv-202',
    payload: { description: 'Updated design specs' },
    baseVersion: 2,
    baseStatus: 'PENDING',
  });

  let executed = false;
  const result = await queue.processOperation(
    op.id,
    async () => ({ version: 2, status: 'PENDING' }), // Current server state matches
    async (operation) => {
      executed = true;
      return { success: true, updatedVersion: 3 };
    }
  );

  assert.equal(executed, true);
  assert.equal(result.status, OperationStatus.COMMITTED);
  assert.deepEqual(result.result, { success: true, updatedVersion: 3 });
});

test('OperationQueue: detects stale state version conflict (optimistic lock divergence)', async () => {
  const storage = createMockStorage();
  const queue = new OperationQueue({ storage });

  const op = queue.enqueue({
    type: 'UPDATE_INVOICE',
    entityId: 'inv-303',
    payload: { description: 'Stale update attempt' },
    baseVersion: 1, // Client thought version was 1
    baseStatus: 'PENDING',
  });

  let executorInvoked = false;
  const result = await queue.processOperation(
    op.id,
    async () => ({ version: 2, status: 'PENDING' }), // Server has moved to version 2
    async () => {
      executorInvoked = true;
    }
  );

  assert.equal(executorInvoked, false, 'Executor must NOT run on conflict');
  assert.equal(result.status, OperationStatus.CONFLICT);
  assert.equal(result.conflict.reason, 'VERSION_MISMATCH');
  assert.equal(result.conflict.expected.version, 1);
  assert.equal(result.conflict.actual.version, 2);
});

test('OperationQueue: detects terminal status conflict when invoice settled concurrently', async () => {
  const storage = createMockStorage();
  const queue = new OperationQueue({ storage });

  const op = queue.enqueue({
    type: 'CANCEL_INVOICE',
    entityId: 'inv-404',
    payload: { reason: 'Void duplicate' },
    baseVersion: 1,
    baseStatus: 'PENDING',
  });

  const result = await queue.processOperation(
    op.id,
    async () => ({ version: 2, status: 'PAID' }), // Concurrent payment landed
    async () => {}
  );

  assert.equal(result.status, OperationStatus.CONFLICT);
  assert.equal(result.conflict.reason, 'TERMINAL_STATUS_CONFLICT');
  assert.match(result.conflict.message, /terminal state \[PAID\]/);
});

test('OperationQueue: exposes deterministic DISCARD resolution choice', () => {
  const storage = createMockStorage();
  const queue = new OperationQueue({ storage });

  const op = queue.enqueue({
    type: 'CANCEL_INVOICE',
    entityId: 'inv-505',
    baseVersion: 1,
  });

  // Manually set to CONFLICT
  op.status = OperationStatus.CONFLICT;

  const resolved = queue.resolveConflict(op.id, ConflictResolutionAction.DISCARD);
  assert.equal(resolved.status, OperationStatus.DISCARDED);
  assert.equal(resolved.conflict, null);

  // Clear completed cleans up discarded items
  const cleared = queue.clearCompleted();
  assert.equal(cleared, 1);
  assert.equal(queue.getOperation(op.id), null);
});

test('OperationQueue: exposes deterministic RETRY_WITH_LATEST resolution choice', async () => {
  const storage = createMockStorage();
  const queue = new OperationQueue({ storage });

  const op = queue.enqueue({
    type: 'UPDATE_INVOICE',
    entityId: 'inv-606',
    baseVersion: 1,
    baseStatus: 'PENDING',
  });

  op.status = OperationStatus.CONFLICT;

  // Retry with latest state (version 3, PENDING)
  const resolved = queue.resolveConflict(op.id, ConflictResolutionAction.RETRY_WITH_LATEST, {
    version: 3,
    status: 'PENDING',
  });

  assert.equal(resolved.status, OperationStatus.QUEUED);
  assert.equal(resolved.baseVersion, 3);
  assert.equal(resolved.conflict, null);

  // Now process with matching version 3
  let executed = false;
  await queue.processOperation(
    op.id,
    async () => ({ version: 3, status: 'PENDING' }),
    async () => {
      executed = true;
      return { success: true };
    }
  );

  assert.equal(executed, true);
  assert.equal(queue.getOperation(op.id).status, OperationStatus.COMMITTED);
});

test('OperationQueue: coordinates across browser tabs via simulated broadcast channel', () => {
  const channel = createMockBroadcastChannel();
  const storage = createMockStorage();

  const tab1 = new OperationQueue({ storage, broadcastChannel: channel, tabId: 'tab_A' });
  const tab2 = new OperationQueue({ storage, broadcastChannel: channel, tabId: 'tab_B' });

  let tab2Notified = false;
  tab2.subscribe((event, data) => {
    if (event === 'REMOTE_SYNC') {
      tab2Notified = true;
    }
  });

  // Tab 1 enqueues an operation
  const op = tab1.enqueue({
    type: 'CREATE_INVOICE',
    entityId: 'inv-707',
    payload: { amount: 100 },
  });

  assert.equal(tab2Notified, true, 'Tab 2 received multi-tab synchronization');
  assert.ok(tab2.getOperation(op.id), 'Tab 2 has access to queued operation from Tab 1');
});
