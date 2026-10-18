import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryAuditStore,
  exportAuditEvents,
  AuditEvent,
} from '../src/audit/audit-service';

describe('Audit-Grade Event Trail (Issue #46)', () => {
  let store: MemoryAuditStore;

  beforeEach(() => {
    store = new MemoryAuditStore(50);
    store.clear();
  });

  describe('Event Recording and Actor Attribution', () => {
    it('records an audit event with actor, scope, timestamp, and state transitions', () => {
      const event = store.recordEvent({
        action: 'INVOICE_CREATED',
        actor: {
          type: 'seller',
          id: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          ip: '192.168.1.1',
          userAgent: 'Mozilla/5.0 Freighter/2.0',
        },
        scope: {
          entityType: 'invoice',
          entityId: 'inv-uuid-1234',
        },
        reason: 'Seller issued invoice for design work',
        beforeState: null,
        afterState: {
          id: 'inv-uuid-1234',
          amount: 500,
          assetCode: 'USDC',
          status: 'PENDING',
        },
        metadata: {
          memo: 'INV-1234',
        },
        correlationId: 'req-corr-1',
      });

      assert.ok(event.id);
      assert.equal(event.action, 'INVOICE_CREATED');
      assert.equal(event.actor.type, 'seller');
      assert.equal(event.actor.id, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
      assert.equal(event.scope.entityId, 'inv-uuid-1234');
      assert.equal(event.correlationId, 'req-corr-1');
      assert.equal(event.afterState?.status, 'PENDING');
    });

    it('records settlement audit events with payer attribution and tx hash', () => {
      const event = store.recordEvent({
        action: 'PAYMENT_VERIFIED',
        actor: {
          type: 'payer',
          id: 'GC5F6UDFX5QG2N46TWBWWVWW5I523N2P42T3N6A7P63L6G4M6N6Q7Y64',
          ip: '10.0.0.1',
        },
        scope: {
          entityType: 'invoice',
          entityId: 'inv-uuid-1234',
        },
        reason: 'Payment verified on Horizon',
        beforeState: { status: 'PENDING' },
        afterState: {
          status: 'PAID',
          paymentTxHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
      });

      assert.equal(event.action, 'PAYMENT_VERIFIED');
      assert.equal(event.actor.type, 'payer');
      assert.equal(event.afterState?.status, 'PAID');
    });

    it('chains event hashes and detects tampering or reordered history', () => {
      const first = store.recordEvent({
        action: 'INVOICE_CREATED',
        actor: { type: 'seller', id: 'seller-1' },
        scope: { entityType: 'invoice', entityId: 'inv-1' },
        afterState: { status: 'PENDING' },
      });
      const second = store.recordEvent({
        action: 'INVOICE_CANCELLED',
        actor: { type: 'seller', id: 'seller-1' },
        scope: { entityType: 'invoice', entityId: 'inv-1' },
        beforeState: { status: 'PENDING' },
        afterState: { status: 'CANCELLED' },
      });

      assert.equal(second.previousHash, first.hash);
      assert.deepEqual(store.verifyChain(), { valid: true, checked: 2 });

      second.afterState!.status = 'PAID';
      const broken = store.verifyChain();
      assert.equal(broken.valid, false);
      assert.equal(broken.failure?.reason, 'event_hash');
    });

    it('detects missing or reordered audit history', () => {
      const first = store.recordEvent({
        action: 'INVOICE_CREATED',
        actor: { type: 'seller', id: 'seller-1' },
        scope: { entityType: 'invoice', entityId: 'inv-1' },
      });
      const second = store.recordEvent({
        action: 'PAYMENT_VERIFIED',
        actor: { type: 'payer', id: 'payer-1' },
        scope: { entityType: 'invoice', entityId: 'inv-1' },
      });
      assert.equal(second.previousHash, first.hash);

      first.previousHash = 'missing-link';
      const broken = store.verifyChain();
      assert.equal(broken.valid, false);
      assert.equal(broken.failure?.reason, 'previous_hash');
    });

    it('automatically sanitizes secret keys from audit event before/after states and metadata', () => {
      const event = store.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'admin-1' },
        scope: { entityType: 'system', entityId: 'config' },
        metadata: {
          secret: 'SB3T7Y2Y64D6V7M6F6K5VNJZ6Z7UHQ67ZYZJ4R3N6Q7Y64D6V7M6F6K5',
          password: 'plain-password-leak',
          safeField: 'ok',
        },
      });

      assert.equal(event.metadata?.secret, '[REDACTED]');
      assert.equal(event.metadata?.password, '[REDACTED]');
      assert.equal(event.metadata?.safeField, 'ok');
    });
  });

  describe('Maintainer Queries, Filtering, and Pagination', () => {
    beforeEach(() => {
      // Create 10 events across different actions and entities
      for (let i = 1; i <= 10; i++) {
        store.recordEvent({
          action: i % 2 === 0 ? 'PAYMENT_VERIFIED' : 'INVOICE_CREATED',
          actor: {
            type: i % 2 === 0 ? 'payer' : 'seller',
            id: `actor-${i % 3}`,
          },
          scope: {
            entityType: 'invoice',
            entityId: `inv-${i}`,
          },
          correlationId: `corr-${i}`,
        });
      }
    });

    it('filters audit records by entityId with indexed O(K) lookup', () => {
      const events = store.getEventsByEntity('inv-3');
      assert.equal(events.length, 1);
      assert.equal(events[0].scope.entityId, 'inv-3');
    });

    it('filters audit records by action and actorId with pagination', () => {
      const query = store.queryEvents({
        action: 'PAYMENT_VERIFIED',
        limit: 3,
        offset: 0,
      });

      assert.equal(query.total, 5);
      assert.equal(query.events.length, 3);
      for (const e of query.events) {
        assert.equal(e.action, 'PAYMENT_VERIFIED');
      }
    });

    it('enforces ring-buffer capacity bound to prevent unbounded memory usage', () => {
      const smallStore = new MemoryAuditStore(5);
      for (let i = 1; i <= 10; i++) {
        smallStore.recordEvent({
          action: 'INVOICE_CREATED',
          actor: { type: 'seller', id: 's1' },
          scope: { entityType: 'invoice', entityId: `inv-${i}` },
        });
      }

      assert.equal(smallStore.size(), 5);
      const query = smallStore.queryEvents();
      assert.equal(query.events.length, 5);
      // Newest events (inv-10 down to inv-6) should be present
      assert.equal(query.events[0].scope.entityId, 'inv-10');
      assert.equal(query.events[4].scope.entityId, 'inv-6');
    });
  });

  describe('Maintainer Export Formats', () => {
    it('exports audit records in JSON, NDJSON, and CSV formats', () => {
      const events: AuditEvent[] = [
        {
          id: 'evt-1',
          timestamp: '2026-09-25T12:00:00.000Z',
          action: 'INVOICE_CREATED',
          actor: { type: 'seller', id: 'GSELLER' },
          scope: { entityType: 'invoice', entityId: 'inv-1' },
          reason: 'Created invoice',
          correlationId: 'corr-1',
        },
      ];

      // JSON format
      const json = exportAuditEvents(events, 'json');
      assert.ok(json.startsWith('['));
      assert.ok(json.includes('evt-1'));

      // NDJSON format
      const ndjson = exportAuditEvents(events, 'ndjson');
      assert.ok(!ndjson.startsWith('['));
      assert.ok(ndjson.includes('"id":"evt-1"'));

      // CSV format
      const csv = exportAuditEvents(events, 'csv');
      assert.ok(csv.includes('Event ID,Timestamp,Action,Actor Type,Actor ID'));
      assert.ok(csv.includes('"evt-1","2026-09-25T12:00:00.000Z","INVOICE_CREATED","seller","GSELLER"'));
    });
  });
});
