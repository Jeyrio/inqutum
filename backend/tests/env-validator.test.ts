import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEnvironment,
  maskSecret,
  isSensitiveKey,
  EnvironmentConfigError,
} from '../src/config/env-validator';

describe('Environment & Secrets Configuration Validation (Issue #90)', () => {
  it('masks secret values and identifies sensitive keys without revealing raw values', () => {
    assert.strictEqual(maskSecret('secret-token-123456789'), 'se***89');
    assert.strictEqual(maskSecret('short'), '***');
    assert.strictEqual(maskSecret(''), '[NOT CONFIGURED]');
    assert.strictEqual(maskSecret(undefined), '[NOT CONFIGURED]');

    assert.strictEqual(isSensitiveKey('DATABASE_PASSWORD'), true);
    assert.strictEqual(isSensitiveKey('OPS_HEALTH_TOKEN'), true);
    assert.strictEqual(isSensitiveKey('JWT_SECRET'), true);
    assert.strictEqual(isSensitiveKey('API_KEY'), true);
    assert.strictEqual(isSensitiveKey('NODE_ENV'), false);
    assert.strictEqual(isSensitiveKey('PORT'), false);
  });

  it('validates a standard development configuration successfully', () => {
    const rawEnv = {
      NODE_ENV: 'development',
      PORT: '3001',
      STELLAR_NETWORK: 'TESTNET',
      FRONTEND_URL: 'http://localhost:3000',
    };

    const result = validateEnvironment(rawEnv);
    assert.strictEqual(result.issues.length, 0);
    assert.strictEqual(result.validated.PORT, 3001);
    assert.strictEqual(result.validated.STELLAR_NETWORK, 'TESTNET');
    assert.strictEqual(result.sanitized.SIMULATION_ENABLED, false);
    assert.strictEqual(result.sanitized.FRONTEND_ORIGINS[0], 'http://localhost:3000');
  });

  it('detects invalid port values and malformed URLs', () => {
    const rawEnv = {
      NODE_ENV: 'development',
      PORT: 'invalid-port',
      STELLAR_HORIZON_URL: 'not-a-valid-url',
    };

    const result = validateEnvironment(rawEnv);
    assert.ok(result.issues.some((i) => i.includes('PORT')));
    assert.ok(result.issues.some((i) => i.includes('STELLAR_HORIZON_URL')));
  });

  it('enforces production safety invariants (disallowing simulate mode and requiring origin)', () => {
    const prodEnvUnsafe = {
      NODE_ENV: 'production',
      ALLOW_SIMULATE: 'true',
      STELLAR_NETWORK: 'PUBLIC',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    };

    const result = validateEnvironment(prodEnvUnsafe, { isProduction: true });
    assert.ok(
      result.issues.some((i) => i.includes('ALLOW_SIMULATE must be false in production')),
      'Should forbid simulate in production'
    );
    assert.ok(
      result.issues.some((i) => i.includes('points to testnet while STELLAR_NETWORK is set to PUBLIC')),
      'Should catch mismatch between horizon testnet URL and PUBLIC network'
    );
    assert.ok(
      result.issues.some((i) => i.includes('FRONTEND_URL')),
      'Should require frontend url in production'
    );
  });

  it('throws EnvironmentConfigError in strict mode when issues exist without leaking secrets', () => {
    const rawEnv = {
      NODE_ENV: 'production',
      ALLOW_SIMULATE: 'true',
      SECRET_DB_PASSWORD: 'SuperSensitivePassword123!',
    };

    assert.throws(
      () => {
        validateEnvironment(rawEnv, { strict: true, isProduction: true });
      },
      (err: any) => {
        assert.ok(err instanceof EnvironmentConfigError);
        assert.ok(!err.message.includes('SuperSensitivePassword123!'), 'Must not leak secret in message');
        return true;
      }
    );
  });
});
