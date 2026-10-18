import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  CURRENT_SCHEMA_VERSION,
  versionStamp,
  isLegacyRecord,
} from '../src/schema/schema-version';
import {
  transformForRead,
  transformForWrite,
  DEPRECATION_POLICY,
} from '../src/schema/compatibility';

const SAMPLE_INVOICE = {
  id: '00000000-0000-0000-0000-000000000001',
  sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
  amount: 100,
  assetCode: 'XLM',
  memo: 'TEST_MEMO',
  status: 'PENDING' as const,
  createdAt: new Date('2025-01-01'),
  expiresAt: new Date('2025-01-08'),
};

describe('Schema Versioning', () => {
  describe('versionStamp', () => {
    it('stamps a record with the current schema version', () => {
      const stamped = versionStamp(SAMPLE_INVOICE);
      assert.strictEqual(stamped._schemaVersion, CURRENT_SCHEMA_VERSION);
    });

    it('preserves all original fields', () => {
      const stamped = versionStamp(SAMPLE_INVOICE);
      assert.strictEqual(stamped.id, SAMPLE_INVOICE.id);
      assert.strictEqual(stamped.amount, SAMPLE_INVOICE.amount);
      assert.strictEqual(stamped.assetCode, SAMPLE_INVOICE.assetCode);
      assert.strictEqual(stamped.sellerPublicKey, SAMPLE_INVOICE.sellerPublicKey);
    });

    it('overwrites existing _schemaVersion', () => {
      const old = { ...SAMPLE_INVOICE, _schemaVersion: '0.1' };
      const stamped = versionStamp(old);
      assert.strictEqual(stamped._schemaVersion, CURRENT_SCHEMA_VERSION);
    });

    it('rejects null and array inputs with a stable validation code', () => {
      for (const value of [null, []]) {
        assert.throws(
          () => versionStamp(value as any),
          (error: any) => error.code === 'INVALID_SCHEMA_RECORD'
        );
      }
    });

    it('does not mutate the source record when stamping', () => {
      const original = { id: 'invoice-1', _schemaVersion: '0' };
      const stamped = versionStamp(original);

      assert.equal(original._schemaVersion, '0');
      assert.equal(stamped._schemaVersion, CURRENT_SCHEMA_VERSION);
    });
  });

  describe('isLegacyRecord', () => {
    it('returns true for records without _schemaVersion', () => {
      assert.strictEqual(isLegacyRecord(SAMPLE_INVOICE), true);
    });

    it('returns false for versioned records', () => {
      const versioned = versionStamp(SAMPLE_INVOICE);
      assert.strictEqual(isLegacyRecord(versioned), false);
    });

    it('returns true when _schemaVersion is null', () => {
      assert.strictEqual(isLegacyRecord({ ...SAMPLE_INVOICE, _schemaVersion: null }), true);
    });

    it('does not treat an inherited schema version as a persisted version', () => {
      const record = Object.create({ _schemaVersion: CURRENT_SCHEMA_VERSION });
      record.id = SAMPLE_INVOICE.id;

      assert.equal(isLegacyRecord(record), true);
    });

    it('rejects malformed records with a stable validation code', () => {
      assert.throws(
        () => isLegacyRecord(null as any),
        (error: any) => error.code === 'INVALID_SCHEMA_RECORD'
      );
    });
  });

  describe('transformForRead', () => {
    it('upgrades a legacy record (no version) to current schema', () => {
      const result = transformForRead(SAMPLE_INVOICE);
      assert.strictEqual(result._schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.strictEqual(result.id, SAMPLE_INVOICE.id);
      assert.strictEqual(result.amount, SAMPLE_INVOICE.amount);
      assert.strictEqual(result.assetCode, 'XLM');
    });

    it('passes through a record already at current version', () => {
      const current = versionStamp(SAMPLE_INVOICE);
      const result = transformForRead(current);
      assert.strictEqual(result._schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.strictEqual(result.id, SAMPLE_INVOICE.id);
    });

    it('fills defaults for legacy records with missing fields', () => {
      const sparse = { id: SAMPLE_INVOICE.id, sellerPublicKey: SAMPLE_INVOICE.sellerPublicKey, amount: 50, memo: 'M', createdAt: new Date(), expiresAt: new Date() };
      const result = transformForRead(sparse);
      assert.strictEqual(result._schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.strictEqual(result.assetCode, 'XLM');
      assert.strictEqual(result.status, 'PENDING');
    });

    it('throws for unsupported schema versions', () => {
      const future = { ...SAMPLE_INVOICE, _schemaVersion: '99.0' };
      assert.throws(
        () => transformForRead(future),
        (err: any) => {
          assert.strictEqual(err.code, 'UNSUPPORTED_SCHEMA_VERSION');
          return true;
        }
      );
    });

    it('accepts an explicit fromVersion override', () => {
      const result = transformForRead(SAMPLE_INVOICE, '0');
      assert.strictEqual(result._schemaVersion, CURRENT_SCHEMA_VERSION);
    });

    it('preserves all existing fields during upgrade', () => {
      const full = {
        ...SAMPLE_INVOICE,
        sellerName: 'Alice',
        sellerEmail: 'alice@example.com',
        description: 'Test invoice',
        customerName: 'Bob',
        assetIssuer: undefined,
        metadata: { custom: true },
      };
      const result = transformForRead(full);
      assert.strictEqual(result.sellerName, 'Alice');
      assert.strictEqual(result.sellerEmail, 'alice@example.com');
      assert.strictEqual(result.description, 'Test invoice');
      assert.strictEqual(result.customerName, 'Bob');
      assert.deepStrictEqual(result.metadata, { custom: true });
    });
  });

  describe('transformForWrite', () => {
    it('adds the current schema version to write payloads', () => {
      const result = transformForWrite(SAMPLE_INVOICE);
      assert.strictEqual(result._schemaVersion, CURRENT_SCHEMA_VERSION);
    });

    it('preserves all input fields', () => {
      const result = transformForWrite(SAMPLE_INVOICE);
      assert.strictEqual(result.id, SAMPLE_INVOICE.id);
      assert.strictEqual(result.amount, SAMPLE_INVOICE.amount);
    });
  });

  describe('DEPRECATION_POLICY', () => {
    it('current version is in the supported list', () => {
      assert.ok(DEPRECATION_POLICY.supported.versions.includes(CURRENT_SCHEMA_VERSION));
    });

    it('legacy version 0 is deprecated, not unsupported', () => {
      assert.ok(DEPRECATION_POLICY.deprecated.versions.includes('0'));
      assert.ok(!DEPRECATION_POLICY.unsupported.versions.includes('0'));
    });
  });
});
