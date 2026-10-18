import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchemaSql } from '../src/db/migration-safety';
import {
  assertMigrationCompatible,
  checkMigrationCompatibility,
  MigrationCompatibilityError,
} from '../src/db/migration-compatibility';
import { DeadLetterOperator, OperatorAuthorizationError } from '../src/jobs/dead-letter-operator';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { JobQueue, JobWorker } from '../src/jobs/worker';
import { DEFAULT_RETRY_POLICY } from '../src/jobs/job-types';
import { MemoryCheckpointStore, CheckpointKeyReusedError } from '../src/recovery/side-effect-checkpoint';
import { SideEffectDispatcher } from '../src/recovery/side-effect-dispatcher';
import { CURRENT_SCHEMA_VERSION, versionStamp } from '../src/schema/schema-version';
import { transformForRead, transformForWrite } from '../src/schema/compatibility';

describe('Issues #237, #238, #276 and #281', () => {
  it('#237 replays a successful side effect without executing it twice', async () => {
    const dispatcher = new SideEffectDispatcher(new MemoryCheckpointStore());
    let executions = 0;
    const request = { key: 'invoice:1:email', effect: 'email.send', payload: { invoiceId: '1' } };
    const first = await dispatcher.dispatch(request, async () => ({ providerId: ++executions }));
    const replay = await dispatcher.dispatch(request, async () => ({ providerId: ++executions }));
    assert.deepEqual(replay, first);
    assert.equal(executions, 1);
  });

  it('#237 refuses the same idempotency key for a different payload', async () => {
    const dispatcher = new SideEffectDispatcher(new MemoryCheckpointStore());
    await dispatcher.dispatch({ key: 'same-key', effect: 'notify', payload: { id: 1 } }, async () => 'sent');
    await assert.rejects(
      dispatcher.dispatch({ key: 'same-key', effect: 'notify', payload: { id: 2 } }, async () => 'wrong'),
      (error: unknown) => error instanceof CheckpointKeyReusedError,
    );
  });

  it('#238 upgrades legacy records and stamps every write', () => {
    const legacy = { id: 'invoice-1', amount: 10 };
    assert.equal(transformForRead(legacy).assetCode, 'XLM');
    assert.equal(transformForWrite(legacy)._schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(versionStamp(legacy)._schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it('#238 rejects a future record instead of silently returning an incompatible response', () => {
    assert.throws(
      () => transformForRead({ id: 'invoice-1', _schemaVersion: '99.0' }),
      (error: any) => error.code === 'UNSUPPORTED_SCHEMA_VERSION',
    );
  });

  it('#276 accepts a normal next-version plan and rejects unapproved destructive work', () => {
    const plan = parseSchemaSql('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS schema_version INTEGER;');
    assert.equal(checkMigrationCompatibility(plan, { currentVersion: 1, targetVersion: 2 }).ok, true);
    assert.throws(
      () => assertMigrationCompatible(parseSchemaSql('DROP TABLE IF EXISTS legacy;'), { currentVersion: 1, targetVersion: 2 }),
      (error: unknown) => error instanceof MigrationCompatibilityError,
    );
    assert.doesNotThrow(() => assertMigrationCompatible(parseSchemaSql('DROP TABLE IF EXISTS legacy;'), { currentVersion: 1, targetVersion: 2, allowDestructive: true }));
  });

  it('#276 fails closed for a skipped version so rollback can be planned', () => {
    const report = checkMigrationCompatibility(parseSchemaSql('CREATE TABLE IF NOT EXISTS x (id int);'), { currentVersion: 1, targetVersion: 3 });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((failure) => failure.name.includes('single-step')));
  });

  it('#281 lets an authorized operator inspect and retry dead-letter jobs', async () => {
    const store = new MemoryJobStore();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const queue = new JobQueue(store, { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }, () => now);
    const { job } = await queue.enqueue('dead.test', {}, { idempotencyKey: 'dead-1' });
    const worker = new JobWorker({ store, workerId: 'test-worker', now: () => now, log: () => undefined });
    worker.register('dead.test', async () => { throw new Error('provider unavailable'); });
    await worker.runOnce();
    const operator = new DeadLetterOperator(store);
    assert.equal((await operator.inspect({ id: 'ops-1', role: 'operator' })).total, 1);
    assert.equal((await operator.retry({ id: 'ops-1', role: 'operator' }, job.id, new Date('2026-01-01T00:00:00.000Z'))).status, 'queued');
    await assert.rejects(operator.inspect({ id: '', role: 'operator' }), (error: unknown) => error instanceof OperatorAuthorizationError);
  });
});
