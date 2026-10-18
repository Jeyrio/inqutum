import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { ConflictError, InvalidVersionError, checkVersion } from '../src/concurrency/optimistic-lock';
import { MemoryStorage } from '../src/storage/memory-storage';

describe('Optimistic Concurrency', () => {
  describe('checkVersion', () => {
    it('passes when expected matches actual', () => {
      assert.doesNotThrow(() => checkVersion(1, 1));
    });

    it('passes when expected is undefined (old client)', () => {
      assert.doesNotThrow(() => checkVersion(undefined, 5));
    });

    it('throws ConflictError when versions mismatch', () => {
      assert.throws(
        () => checkVersion(1, 2),
        (err: any) => {
          assert.ok(err instanceof ConflictError);
          assert.strictEqual(err.code, 'CONFLICT');
          assert.strictEqual(err.currentVersion, 2);
          assert.strictEqual(err.attemptedVersion, 1);
          return true;
        }
      );
    });

    it('rejects invalid expected and actual versions with a stable code', () => {
      for (const call of [
        () => checkVersion(-1, 1),
        () => checkVersion(1.5, 1),
        () => checkVersion(1, -1),
        () => checkVersion(1, Number.MAX_SAFE_INTEGER + 1),
      ]) {
        assert.throws(call, (err: any) => {
          assert.ok(err instanceof InvalidVersionError);
          assert.strictEqual(err.code, 'INVALID_VERSION');
          return true;
        });
      }
    });
  });

  describe('ConflictError', () => {
    it('has correct properties', () => {
      const err = new ConflictError(3, 1);
      assert.strictEqual(err.code, 'CONFLICT');
      assert.strictEqual(err.currentVersion, 3);
      assert.strictEqual(err.attemptedVersion, 1);
      assert.ok(err.message.includes('modified by another session'));
      assert.ok(err instanceof Error);
    });
  });

  describe('MemoryStorage with version tracking', () => {
    let storage: MemoryStorage;

    beforeEach(() => {
      storage = new MemoryStorage();
    });

    it('creates invoices with version 1', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_1',
        expiresAt: new Date(Date.now() + 86400000),
      });
      assert.strictEqual(invoice.version, 1);
    });

    it('increments version on update', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_2',
        expiresAt: new Date(Date.now() + 86400000),
      });
      assert.strictEqual(invoice.version, 1);

      const updated = storage.updateInvoice(invoice.id, { status: 'CANCELLED' });
      assert.strictEqual(updated!.version, 2);
    });

    it('cancel with correct version succeeds', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_3',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const updated = storage.updateInvoice(invoice.id, { status: 'CANCELLED' }, 1);
      assert.ok(updated);
      assert.strictEqual(updated!.version, 2);
      assert.strictEqual(updated!.status, 'CANCELLED');
    });

    it('cancel with stale version throws ConflictError', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_4',
        expiresAt: new Date(Date.now() + 86400000),
      });

      // First update bumps to version 2
      storage.updateInvoice(invoice.id, { description: 'updated' });

      // Trying to update with version 1 (stale) should throw
      assert.throws(
        () => storage.updateInvoice(invoice.id, { status: 'CANCELLED' }, 1),
        (err: any) => {
          assert.ok(err instanceof ConflictError);
          assert.strictEqual(err.currentVersion, 2);
          assert.strictEqual(err.attemptedVersion, 1);
          return true;
        }
      );
    });

    it('cancel without version (old client) succeeds', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_5',
        expiresAt: new Date(Date.now() + 86400000),
      });

      // No expectedVersion = skip check
      const updated = storage.updateInvoice(invoice.id, { status: 'CANCELLED' });
      assert.ok(updated);
      assert.strictEqual(updated!.version, 2);
    });

    it('markAsPaid with stale version throws ConflictError', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_6',
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Bump version via an update
      storage.updateInvoice(invoice.id, { description: 'changed' });

      // markAsPaid with stale version
      assert.throws(
        () => storage.markAsPaid(invoice.id, 'tx123', 'GPAYER', undefined, 1),
        (err: any) => {
          assert.ok(err instanceof ConflictError);
          return true;
        }
      );
    });

    it('simultaneous edits: only one succeeds', () => {
      const invoice = storage.createInvoice({
        sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
        amount: 100,
        memo: 'TEST_MEMO_7',
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Both "sessions" read version 1
      const v = invoice.version!;

      // First cancel succeeds
      const result = storage.updateInvoice(invoice.id, { status: 'CANCELLED' }, v);
      assert.ok(result);
      assert.strictEqual(result!.version, 2);

      // Second cancel with same version fails
      assert.throws(
        () => storage.updateInvoice(invoice.id, { description: 'late' }, v),
        (err: any) => {
          assert.ok(err instanceof ConflictError);
          return true;
        }
      );
    });
  });
});
