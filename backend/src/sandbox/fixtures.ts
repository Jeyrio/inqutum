/**
 * Sandbox scenarios (issue #81). Every value is fixed so a run gives the same
 * result on every machine. The accounts are valid strkeys derived from fixed
 * test seeds; they are never funded and never touch a real network.
 */
import type { HorizonOperationLike, HorizonTransactionLike } from '../services/payment-verification';

export const SANDBOX_SELLER = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
export const SANDBOX_PAYER = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';

export type SandboxScenario =
  | 'success'
  | 'memo_mismatch'
  | 'underpaid'
  | 'wrong_destination'
  | 'not_found';

export interface SandboxTransaction {
  transaction: HorizonTransactionLike;
  operations: HorizonOperationLike[];
}

export const SANDBOX_INVOICE = {
  memo: 'INV-SANDBOX1',
  amount: '25.0000000',
  assetCode: 'XLM',
  destination: SANDBOX_SELLER,
} as const;

/** Tx hash per scenario: the scenario index repeated to 64 hex characters. */
export const SANDBOX_TX_HASHES: Record<SandboxScenario, string> = {
  success: '1'.repeat(64),
  memo_mismatch: '2'.repeat(64),
  underpaid: '3'.repeat(64),
  wrong_destination: '4'.repeat(64),
  not_found: '5'.repeat(64),
};

const payment = (overrides: Partial<HorizonOperationLike> = {}): HorizonOperationLike => ({
  type: 'payment',
  from: SANDBOX_PAYER,
  to: SANDBOX_SELLER,
  amount: SANDBOX_INVOICE.amount,
  asset_type: 'native',
  ...overrides,
});

const tx = (memo: string): HorizonTransactionLike => ({ memo, memo_type: 'text' });

export const SANDBOX_TRANSACTIONS: Record<Exclude<SandboxScenario, 'not_found'>, SandboxTransaction> = {
  success: { transaction: tx(SANDBOX_INVOICE.memo), operations: [payment()] },
  memo_mismatch: { transaction: tx('INV-OTHER'), operations: [payment()] },
  underpaid: { transaction: tx(SANDBOX_INVOICE.memo), operations: [payment({ amount: '10.0000000' })] },
  wrong_destination: { transaction: tx(SANDBOX_INVOICE.memo), operations: [payment({ to: SANDBOX_PAYER })] },
};
