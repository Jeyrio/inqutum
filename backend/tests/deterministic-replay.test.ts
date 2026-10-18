import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeterministicReplayEngine,
  SimulationEvent,
  SimulatedResource,
} from '../src/concurrency/deterministic-replay-engine';

describe('Deterministic Replay for Concurrent Writes & Retries (Issue #274)', () => {
  const initialResource: SimulatedResource = {
    id: 'inv-test-replay-1',
    version: 1,
    status: 'PENDING',
    fields: { description: 'Initial', customerName: 'Alice' },
    settledAmount: 0,
  };

  describe('Normal Path & Seed Determinism', () => {
    it('produces 100% identical execution traces when executed with the same random seed', async () => {
      const events: SimulationEvent[] = [
        {
          id: 'ev-1',
          clientId: 'client-1',
          role: 'ADMIN',
          action: 'UPDATE_FIELD',
          field: 'description',
          value: 'Updated by Admin',
        },
        {
          id: 'ev-2',
          clientId: 'client-2',
          role: 'OWNER',
          action: 'UPDATE_FIELD',
          field: 'customerName',
          value: 'Alice Cooper',
        },
      ];

      const engine1 = new DeterministicReplayEngine(initialResource, 1337);
      const res1 = await engine1.executeConcurrentBatch(events);

      const engine2 = new DeterministicReplayEngine(initialResource, 1337);
      const res2 = await engine2.executeConcurrentBatch(events);

      assert.deepEqual(res1.finalState, res2.finalState);
      assert.deepEqual(res1.trace, res2.trace);
      assert.equal(res1.successfulWrites, 2);
    });
  });

  describe('Failure Path & Optimistic Concurrency Conflicts', () => {
    it('detects and records version conflicts deterministically when clients race on stale versions', async () => {
      const conflictingEvents: SimulationEvent[] = [
        {
          id: 'ev-race-1',
          clientId: 'client-A',
          role: 'ADMIN',
          action: 'UPDATE_FIELD',
          field: 'description',
          value: 'Edit from client A',
          expectedVersion: 1, // Will succeed and bump to 2
        },
        {
          id: 'ev-race-2',
          clientId: 'client-B',
          role: 'ADMIN',
          action: 'UPDATE_FIELD',
          field: 'description',
          value: 'Edit from client B',
          expectedVersion: 1, // Will fail if executed second
        },
      ];

      const engine = new DeterministicReplayEngine(initialResource, 42);
      const result = await engine.executeConcurrentBatch(conflictingEvents);

      assert.equal(result.successfulWrites, 1);
      assert.equal(result.conflicts, 1);
      assert.equal(result.finalState.version, 2);

      const conflictStep = result.trace.find((t) => t.status === 'CONFLICT');
      assert.ok(conflictStep);
      assert.match(conflictStep.error!, /VERSION_CONFLICT/);
    });
  });

  describe('Retry Path & Idempotent Replays', () => {
    it('handles simulated network drops and retries with idempotency keys without side-effect duplication', async () => {
      const retryEvents: SimulationEvent[] = [
        {
          id: 'ev-network-fail',
          clientId: 'client-C',
          role: 'ADMIN',
          action: 'SETTLE_PAYMENT',
          value: 100,
          idempotencyKey: 'idemp-tx-1234',
          shouldFailNetwork: true, // Network drops first attempt
        },
        {
          id: 'ev-retry-attempt-1',
          clientId: 'client-C',
          role: 'ADMIN',
          action: 'SETTLE_PAYMENT',
          value: 100,
          idempotencyKey: 'idemp-tx-1234', // Successful retry
        },
        {
          id: 'ev-duplicate-delivery',
          clientId: 'client-C',
          role: 'ADMIN',
          action: 'SETTLE_PAYMENT',
          value: 100,
          idempotencyKey: 'idemp-tx-1234', // Redundant retry / delayed packet
        },
      ];

      const engine = new DeterministicReplayEngine(initialResource, 99);
      const result = await engine.executeConcurrentBatch(retryEvents);

      // Settle should only happen ONCE
      assert.equal(result.finalState.status, 'PAID');
      assert.equal(result.finalState.settledAmount, 100);
      assert.equal(result.retriesHandled, 1); // ev-duplicate-delivery caught as IDEMPOTENT_HIT

      const netDrop = result.trace.find((t) => t.status === 'NETWORK_ERROR');
      const hit = result.trace.find((t) => t.status === 'IDEMPOTENT_HIT');
      assert.ok(netDrop);
      assert.ok(hit);
    });
  });

  describe('Authorization Race Path', () => {
    it('rejects unauthorized writes racing with authorized operations without tainting state', async () => {
      const racingEvents: SimulationEvent[] = [
        {
          id: 'ev-unauth',
          clientId: 'attacker',
          role: 'UNAUTHORIZED',
          action: 'CANCEL_INVOICE',
        },
        {
          id: 'ev-auth',
          clientId: 'owner',
          role: 'OWNER',
          action: 'UPDATE_FIELD',
          field: 'description',
          value: 'Legitimate update',
        },
      ];

      const engine = new DeterministicReplayEngine(initialResource, 7);
      const result = await engine.executeConcurrentBatch(racingEvents);

      assert.equal(result.finalState.status, 'PENDING'); // Cannot be cancelled by attacker
      assert.equal(result.finalState.fields.description, 'Legitimate update');

      const unauthStep = result.trace.find((t) => t.status === 'UNAUTHORIZED');
      assert.ok(unauthStep);
    });
  });
});
