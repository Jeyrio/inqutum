import assert from 'node:assert/strict';
import { MemoryAuditStore } from '../src/audit/audit-service';
import { runSyntheticJourney } from '../src/monitoring/synthetic-monitor';

describe('quality hardening', () => {
  it('sorts same-timestamp audit events deterministically', () => {
    const store = new MemoryAuditStore();
    const common = { action: 'MAINTAINER_ACTION' as const, actor: { type: 'system' as const, id: 'system' }, scope: { entityType: 'system' as const, entityId: 'system' }, timestamp: '2026-01-01T00:00:00.000Z' };
    store.recordEvent({ ...common, metadata: { n: 2 } });
    store.recordEvent({ ...common, metadata: { n: 1 } });
    const first = store.queryEvents().events.map((event) => event.id);
    const second = store.queryEvents().events.map((event) => event.id);
    assert.deepEqual(first, second);
  });

  it('stops a synthetic journey at the first failed step', async () => {
    const result = await runSyntheticJourney([
      { name: 'health', run: async () => {} },
      { name: 'payment', run: async () => { throw new Error('rejected'); } },
      { name: 'receipt', run: async () => { throw new Error('must not run'); } },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.steps.map((step) => step.name), ['health', 'payment']);
  });
});
