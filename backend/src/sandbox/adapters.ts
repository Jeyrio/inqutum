/**
 * Sandbox adapter (issue #81): a fake Horizon that returns canned,
 * deterministic responses. Nothing here opens a socket or reads a key.
 */
import {
  checkTxHash,
  failure,
  verifyHorizonPayment,
} from '../services/payment-verification';
import type { ExpectedPayment, VerificationResult, VerifiedPayment } from '../services/payment-verification';
import { SANDBOX_TRANSACTIONS, SANDBOX_TX_HASHES } from './fixtures';
import type { SandboxTransaction } from './fixtures';

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxConfigError';
  }
}

export function isSandboxMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INQUTUM_SANDBOX === 'true';
}

/**
 * Refuses to start a sandbox that is pointed at mainnet or holds a real
 * secret, so a stray env file cannot turn a test run into a live one.
 */
export function assertSandboxSafe(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.STELLAR_NETWORK || 'TESTNET').toUpperCase() === 'PUBLIC') {
    throw new SandboxConfigError('Sandbox mode cannot run with STELLAR_NETWORK=PUBLIC');
  }
  if (env.SELLER_SECRET_KEY) {
    throw new SandboxConfigError('Sandbox mode must not be given SELLER_SECRET_KEY');
  }
}

export class SandboxHorizon {
  private readonly transactions = new Map<string, SandboxTransaction>();

  constructor() {
    for (const [scenario, record] of Object.entries(SANDBOX_TRANSACTIONS)) {
      this.transactions.set(SANDBOX_TX_HASHES[scenario as keyof typeof SANDBOX_TRANSACTIONS], record);
    }
  }

  /** Same shape and failure mode as StellarService.getTransaction. */
  async getTransaction(txHash: string): Promise<SandboxTransaction> {
    const record = this.transactions.get(txHash.toLowerCase());
    if (!record) throw new Error(`Transaction not found: ${txHash}`);
    return structuredClone(record);
  }

  /** Mirrors StellarService.verifyPayment, backed by the fixtures instead of Horizon. */
  async verifyPayment(
    txHash: string,
    expected: ExpectedPayment,
    network = 'TESTNET'
  ): Promise<VerificationResult<VerifiedPayment>> {
    const hashCheck = checkTxHash(txHash);
    if (!hashCheck.ok) return hashCheck;

    let details: SandboxTransaction;
    try {
      details = await this.getTransaction(hashCheck.value);
    } catch {
      return failure('TRANSACTION_NOT_FOUND');
    }

    return verifyHorizonPayment({ txHash: hashCheck.value, expected, network, ...details });
  }
}
