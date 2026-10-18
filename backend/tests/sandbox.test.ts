import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SandboxConfigError,
  SandboxHorizon,
  assertSandboxSafe,
  isSandboxMode,
} from '../src/sandbox/adapters.ts';
import { SANDBOX_INVOICE, SANDBOX_TX_HASHES } from '../src/sandbox/fixtures.ts';

const expected = { ...SANDBOX_INVOICE, network: 'TESTNET' };

describe('sandbox config', () => {
  it('is off unless explicitly enabled', () => {
    assert.equal(isSandboxMode({}), false);
    assert.equal(isSandboxMode({ INQUTUM_SANDBOX: 'true' }), true);
  });

  it('refuses mainnet and real secrets', () => {
    assert.doesNotThrow(() => assertSandboxSafe({ INQUTUM_SANDBOX: 'true' }));
    assert.throws(() => assertSandboxSafe({ STELLAR_NETWORK: 'public' }), SandboxConfigError);
    assert.throws(() => assertSandboxSafe({ SELLER_SECRET_KEY: 'S' + 'A'.repeat(55) }), SandboxConfigError);
  });
});

describe('sandbox Horizon', () => {
  const horizon = new SandboxHorizon();

  it('verifies the success scenario', async () => {
    const result = await horizon.verifyPayment(SANDBOX_TX_HASHES.success, expected);
    assert.equal(result.ok, true);
  });

  const failures = [
    ['memo_mismatch', 'MEMO_MISMATCH'],
    ['underpaid', 'AMOUNT_MISMATCH'],
    ['wrong_destination', 'DESTINATION_MISMATCH'],
    ['not_found', 'TRANSACTION_NOT_FOUND'],
  ] as const;

  for (const [scenario, code] of failures) {
    it(`returns ${code} for ${scenario}`, async () => {
      const result = await horizon.verifyPayment(SANDBOX_TX_HASHES[scenario], expected);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, code);
    });
  }

  it('gives the same answer every time and hands out copies', async () => {
    const first = await horizon.getTransaction(SANDBOX_TX_HASHES.success);
    first.operations[0].amount = '0';
    const second = await horizon.getTransaction(SANDBOX_TX_HASHES.success);
    assert.equal(second.operations[0].amount, SANDBOX_INVOICE.amount);
  });
});
