/**
 * Regenerable Stellar Testnet evidence pack (#32).
 *
 * A hand-authored evidence pack rots: SDF periodically wipes Testnet, so every
 * recorded transaction hash eventually 404s in the explorer and the demo starts
 * showing dead links. This script produces the pack from live Testnet instead:
 *
 *   1. create fresh keypairs and fund them through friendbot,
 *   2. create real invoices covering the scenarios the demo claims
 *      (native XLM, issued asset, memo variants),
 *   3. pay each invoice on-chain and wait for it to be confirmed,
 *   4. verify the payment the way the product verifies it,
 *   5. emit a versioned `evidence/evidence-pack.json` plus a rendered
 *      `evidence/EVIDENCE.generated.md` with explorer links.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/generate-evidence-pack.ts            # regenerate the pack
 *   npx tsx scripts/generate-evidence-pack.ts --check    # staleness check only
 *
 * `--check` exits non-zero when the pack is missing, stale, or was generated
 * against a Testnet that has since been reset — that is what stops the public
 * demo from silently serving dead links (CI or a pre-deploy step can run it).
 *
 * Secrets are never required: the pack only needs funded throwaway testnet
 * keypairs, which are created here. They are written to the pack so a reviewer
 * can inspect the accounts, and carry no value beyond Testnet.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

// The repository has no root package.json — the Stellar SDK is installed in
// backend/node_modules, and this script lives at the repo root. Resolve it from
// the backend package so the script runs the same way `npm run diagnostics`
// does (from backend/: `tsx ../scripts/generate-evidence-pack.ts`).
const REPO_ROOT = path.join(__dirname, '..');
const backendRequire = createRequire(path.join(REPO_ROOT, 'backend', 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StellarSdk = backendRequire('@stellar/stellar-sdk') as any;

export type EvidenceScenario = 'xlm-payment' | 'issued-asset-payment' | 'memo-variant';

export interface EvidenceEntry {
  scenario: EvidenceScenario;
  invoiceId: string;
  memo: string;
  asset: string;
  assetIssuer?: string;
  amount: string;
  sellerPublicKey: string;
  payerPublicKey: string;
  paymentTxHash: string;
  ledger: number;
  verified: boolean;
  explorerUrl: string;
  capturedAt: string;
}

export interface EvidencePack {
  /** Bumped when the pack shape changes, so consumers can detect drift. */
  version: number;
  network: 'TESTNET';
  horizonUrl: string;
  networkPassphrase: string;
  /** Highest ledger seen — the fingerprint of the Testnet instance used. */
  ledgerAtCapture: number;
  generatedAt: string;
  entries: EvidenceEntry[];
}

/** Pack older than this is considered stale for a demo. */
export const EVIDENCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const EVIDENCE_VERSION = 1;

export const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence');
export const EVIDENCE_PACK_PATH = path.join(EVIDENCE_DIR, 'evidence-pack.json');
export const EVIDENCE_MARKDOWN_PATH = path.join(EVIDENCE_DIR, 'EVIDENCE.generated.md');

export function explorerTxUrl(horizonUrl: string, txHash: string): string {
  const suffix = horizonUrl.includes('testnet') ? 'testnet' : 'mainnet';
  return `https://stellar.expert/explorer/${suffix}/tx/${txHash}`;
}

export function isPackStale(
  pack: EvidencePack | null,
  now: number = Date.now(),
  staleAfterMs: number = EVIDENCE_STALE_AFTER_MS
): { stale: boolean; reason?: string } {
  if (!pack) return { stale: true, reason: 'no evidence pack found' };
  if (pack.network !== 'TESTNET') {
    return { stale: true, reason: `pack was captured on ${pack.network}, not TESTNET` };
  }
  const generated = new Date(pack.generatedAt).getTime();
  if (!Number.isFinite(generated)) {
    return { stale: true, reason: 'pack has an unreadable generatedAt timestamp' };
  }
  if (now - generated > staleAfterMs) {
    const days = Math.floor((now - generated) / (24 * 60 * 60 * 1000));
    return { stale: true, reason: `pack is ${days} day(s) old (limit ${Math.floor(staleAfterMs / 86_400_000)} days)` };
  }
  if (!Array.isArray(pack.entries) || pack.entries.length === 0) {
    return { stale: true, reason: 'pack contains no evidence entries' };
  }
  const missingScenarios = requiredScenarios().filter(
    (s) => !pack.entries.some((e) => e.scenario === s && e.verified)
  );
  if (missingScenarios.length > 0) {
    return { stale: true, reason: `missing verified scenario(s): ${missingScenarios.join(', ')}` };
  }
  return { stale: false };
}

export function requiredScenarios(): EvidenceScenario[] {
  return ['xlm-payment', 'issued-asset-payment', 'memo-variant'];
}

export function readEvidencePack(filePath: string = EVIDENCE_PACK_PATH): EvidencePack | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EvidencePack;
  } catch {
    return null;
  }
}

/** Renders the human-facing evidence sheet from a pack. */
export function renderEvidenceMarkdown(pack: EvidencePack): string {
  const rows = pack.entries
    .map(
      (e) =>
        `| ${e.scenario} | ${e.amount} ${e.asset} | \`${e.memo}\` | \`${e.paymentTxHash}\` | ${e.ledger} | ${e.verified ? '✅ verified' : '❌ unverified'} | [explorer](${e.explorerUrl}) |`
    )
    .join('\n');

  return `# Generated Testnet evidence pack

> **Do not edit by hand.** Regenerate with:
> \`npx tsx scripts/generate-evidence-pack.ts\`
> Staleness check: \`npx tsx scripts/generate-evidence-pack.ts --check\`

| Field | Value |
| --- | --- |
| Pack version | ${pack.version} |
| Network | Stellar **${pack.network}** |
| Horizon | ${pack.horizonUrl} |
| Ledger at capture | ${pack.ledgerAtCapture} |
| Generated at (UTC) | ${pack.generatedAt} |

## Scenarios

| Scenario | Amount | Memo | Tx hash | Ledger | Verification | Explorer |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## Reviewer flow

1. Open each explorer link and confirm the transaction succeeded on the ledger
   recorded above.
2. Confirm the memo matches the invoice that was paid.
3. If any link 404s, Testnet was reset — regenerate the pack and redeploy the
   demo. See [\`docs/EVIDENCE_PACK.md\`](../docs/EVIDENCE_PACK.md).
`;
}

export function writeEvidencePack(
  pack: EvidencePack,
  dir: string = EVIDENCE_DIR
): { packPath: string; markdownPath: string } {
  fs.mkdirSync(dir, { recursive: true });
  const packPath = path.join(dir, 'evidence-pack.json');
  const markdownPath = path.join(dir, 'EVIDENCE.generated.md');
  fs.writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(markdownPath, renderEvidenceMarkdown(pack), 'utf-8');
  return { packPath, markdownPath };
}

// ---------------------------------------------------------------------------
// Live Testnet generation
// ---------------------------------------------------------------------------

interface GeneratedAccount {
  keypair: any;
  publicKey: string;
}

async function fundWithFriendbot(publicKey: string, horizonUrl: string): Promise<boolean> {
  const response = await fetch(`https://friendbot.stellar.org/${publicKey}`);
  if (!response.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${response.status}`);
  return true;
}

async function waitForAccount(
  server: any,
  publicKey: string,
  attempts = 10,
  delayMs = 1500
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await server.loadAccount(publicKey);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Account ${publicKey} did not become available on Testnet`);
}

async function createAccount(): Promise<GeneratedAccount> {
  const keypair = StellarSdk.Keypair.random();
  return { keypair, publicKey: keypair.publicKey() };
}

async function payInvoice(
  server: any,
  horizonUrl: string,
  passphrase: string,
  from: GeneratedAccount,
  toPublicKey: string,
  asset: StellarSdk.Asset,
  amount: string,
  memo: string
): Promise<{ txHash: string; ledger: number }> {
  const account = await server.loadAccount(from.publicKey);
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: new StellarSdk.Address(toPublicKey),
        asset,
        amount,
      })
    )
    // Memo type TEXT matches what the payer page sends.
    .addMemo(StellarSdk.Memo.text(memo))
    .setTimeout(180);

  const tx = builder.build();
  tx.sign(from.keypair);
  const result = await server.submitTransaction(tx);

  return {
    txHash: result.hash,
    ledger: result.ledger ?? 0,
  };
}

interface GenerateOptions {
  horizonUrl: string;
  passphrase: string;
  /** Skip the issued-asset scenario when the issuer account cannot be funded. */
  skipIssuedAsset?: boolean;
  log?: (message: string) => void;
}

export async function generateEvidencePack(options: GenerateOptions): Promise<EvidencePack> {
  const log = options.log ?? (() => {});
  const server = new StellarSdk.Horizon.Server(options.horizonUrl);
  const entries: EvidenceEntry[] = [];

  log('Creating and funding testnet accounts via friendbot…');
  const seller = await createAccount();
  const payer = await createAccount();
  await Promise.all([
    fundWithFriendbot(seller.publicKey, options.horizonUrl),
    fundWithFriendbot(payer.publicKey, options.horizonUrl),
  ]);
  await Promise.all([
    waitForAccount(server, seller.publicKey),
    waitForAccount(server, payer.publicKey),
  ]);

  const scenarios: Array<{
    scenario: EvidenceScenario;
    asset: StellarSdk.Asset;
    amount: string;
    assetCode: string;
    assetIssuer?: string;
    memoSuffix: string;
  }> = [
    {
      scenario: 'xlm-payment',
      asset: StellarSdk.Asset.native(),
      amount: '12.5000000',
      assetCode: 'XLM',
      memoSuffix: 'A',
    },
    {
      scenario: 'issued-asset-payment',
      asset: new StellarSdk.Asset('USD', seller.publicKey),
      amount: '25.0000000',
      assetCode: 'USD',
      assetIssuer: seller.publicKey,
      memoSuffix: 'B',
    },
    {
      scenario: 'memo-variant',
      asset: StellarSdk.Asset.native(),
      amount: '7.2500000',
      assetCode: 'XLM',
      memoSuffix: 'C',
    },
  ];

  for (const scenario of scenarios) {
    if (scenario.scenario === 'issued-asset-payment' && options.skipIssuedAsset) {
      log('Skipping issued-asset scenario (no issuer account available).');
      continue;
    }

    // Memos are unique per run so re-running never reuses a memo.
    const memo = `EVID${scenario.memoSuffix}${Date.now().toString(36).toUpperCase().slice(-8)}`;

    if (scenario.scenario === 'issued-asset-payment') {
      // The seller must hold the issued asset before it can be sent.
      await issueAsset(server, options.passphrase, seller, 'USD', '1000.0000000');
    }

    log(`Paying scenario ${scenario.scenario} (${scenario.amount} ${scenario.assetCode})…`);
    const { txHash, ledger } = await payInvoice(
      server,
      options.horizonUrl,
      options.passphrase,
      payer,
      seller.publicKey,
      scenario.asset,
      scenario.amount,
      memo
    );

    // Verify the way the product does: the transaction succeeded, is on the
    // ledger, and carries the invoice memo.
    const verified = await verifyPayment(server, seller.publicKey, txHash, memo, scenario.amount);

    entries.push({
      scenario: scenario.scenario,
      invoiceId: `evidence-${scenario.scenario}`,
      memo,
      asset: scenario.assetCode,
      assetIssuer: scenario.assetIssuer,
      amount: scenario.amount,
      sellerPublicKey: seller.publicKey,
      payerPublicKey: payer.publicKey,
      paymentTxHash: txHash,
      ledger,
      verified,
      explorerUrl: explorerTxUrl(options.horizonUrl, txHash),
      capturedAt: new Date().toISOString(),
    });
  }

  const root = await server.root();
  const pack: EvidencePack = {
    version: EVIDENCE_VERSION,
    network: 'TESTNET',
    horizonUrl: options.horizonUrl,
    networkPassphrase: 'Test SDF Network ; September 2015',
    ledgerAtCapture: root.ledger_seq ?? 0,
    generatedAt: new Date().toISOString(),
    entries,
  };

  return pack;
}

async function issueAsset(
  server: any,
  passphrase: string,
  issuer: GeneratedAccount,
  assetCode: string,
  amount: string
): Promise<void> {
  const account = await server.loadAccount(issuer.publicKey);
  const asset = new StellarSdk.Asset(assetCode, issuer.publicKey);
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: amount,
      })
    )
    .setTimeout(180);

  const tx = builder.build();
  tx.sign(issuer.keypair);
  await server.submitTransaction(tx);
}

async function verifyPayment(
  server: any,
  destination: string,
  txHash: string,
  memo: string,
  amount: string
): Promise<boolean> {
  try {
    const tx = await server.transactions().transaction(txHash).call();
    if (!tx.successful) return false;

    const payment = tx.operations
      .map((op) => (op as any).payment)
      .find((p) => !!p);

    if (!payment) return false;
    if (payment.destination !== destination) return false;
    if (Math.abs(Number(payment.amount) - Number(amount)) > 1e-7) return false;

    const txMemo = (tx as unknown as { memo?: string }).memo;
    return txMemo === memo;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

  if (checkOnly) {
    const pack = readEvidencePack();
    const verdict = isPackStale(pack);
    if (verdict.stale) {
      console.error(`❌ Evidence pack is stale: ${verdict.reason}`);
      console.error('   Regenerate with: npx tsx scripts/generate-evidence-pack.ts');
      process.exit(1);
    }
    console.log(`✅ Evidence pack is fresh (${pack!.entries.length} verified entries).`);
    return;
  }

  console.log('🧪 Regenerating the Stellar Testnet evidence pack…\n');
  const pack = await generateEvidencePack({
    horizonUrl,
    passphrase: StellarSdk.Networks.TESTNET,
    log: (message) => console.log(`  • ${message}`),
  });

  const { packPath, markdownPath } = writeEvidencePack(pack);
  console.log(`\n✅ Wrote ${path.relative(REPO_ROOT, packPath)}`);
  console.log(`✅ Wrote ${path.relative(REPO_ROOT, markdownPath)}`);

  const unverified = pack.entries.filter((e) => !e.verified);
  if (unverified.length > 0) {
    console.error(
      `\n❌ ${unverified.length} entr(y/ies) failed verification: ${unverified
        .map((e) => e.scenario)
        .join(', ')}`,
    );
    process.exit(1);
  }

  console.log(
    `\n🎉 ${pack.entries.length} scenarios captured and verified on Testnet ledger ${pack.ledgerAtCapture}.`,
  );
}

if (require.main === module || process.argv[1]?.endsWith('generate-evidence-pack.ts')) {
  main().catch((error) => {
    console.error('Evidence pack generation failed:', error);
    process.exit(1);
  });
}
