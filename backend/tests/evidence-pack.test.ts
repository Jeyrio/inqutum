import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isPackStale,
  renderEvidenceMarkdown,
  readEvidencePack,
  requiredScenarios,
  explorerTxUrl,
  writeEvidencePack,
  EVIDENCE_STALE_AFTER_MS,
  type EvidencePack,
} from '../../scripts/generate-evidence-pack';

/**
 * Evidence pack generation (#32).
 *
 * The testable half of the generator: staleness detection (the guard that stops
 * a demo serving dead links after a Testnet reset), scenario coverage, and
 * artifact rendering.
 */
function makePack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  const scenarios = requiredScenarios();
  return {
    version: 1,
    network: 'TESTNET',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    ledgerAtCapture: 1_000_000,
    generatedAt: new Date().toISOString(),
    entries: scenarios.map((scenario, i) => ({
      scenario,
      invoiceId: `evidence-${scenario}`,
      memo: `EVID${i}`,
      asset: 'XLM',
      amount: '1.0000000',
      sellerPublicKey: 'GSELLER',
      payerPublicKey: 'GPAYER',
      paymentTxHash: 'a'.repeat(64),
      ledger: 1_000_000 + i,
      verified: true,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${'a'.repeat(64)}`,
      capturedAt: new Date().toISOString(),
    })),
    ...overrides,
  };
}

describe('Evidence pack generation (Issue #32)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inqutum-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Scenario coverage', () => {
    it('covers XLM, issued-asset and a memo variant', () => {
      assert.deepEqual(requiredScenarios(), [
        'xlm-payment',
        'issued-asset-payment',
        'memo-variant',
      ]);
    });

    it('treats a pack missing a required scenario as stale', () => {
      const pack = makePack({
        entries: makePack().entries.filter((e) => e.scenario !== 'issued-asset-payment'),
      });
      const verdict = isPackStale(pack);
      assert.equal(verdict.stale, true);
      assert.match(String(verdict.reason), /issued-asset-payment/);
    });

    it('treats an unverified entry as stale', () => {
      const pack = makePack();
      pack.entries[0].verified = false;
      const verdict = isPackStale(pack);
      assert.equal(verdict.stale, true);
      assert.match(String(verdict.reason), /missing verified scenario/);
    });
  });

  describe('Staleness detection', () => {
    it('accepts a fresh, complete pack', () => {
      assert.equal(isPackStale(makePack()).stale, false);
    });

    it('flags a missing pack', () => {
      const verdict = isPackStale(null);
      assert.equal(verdict.stale, true);
      assert.match(String(verdict.reason), /no evidence pack/);
    });

    it('flags a pack older than the staleness window', () => {
      const old = new Date(Date.now() - EVIDENCE_STALE_AFTER_MS - 60_000).toISOString();
      const verdict = isPackStale(makePack({ generatedAt: old }));
      assert.equal(verdict.stale, true);
      assert.match(String(verdict.reason), /day\(s\) old/);
    });

    it('flags an empty pack', () => {
      const verdict = isPackStale(makePack({ entries: [] }));
      assert.equal(verdict.stale, true);
      assert.match(String(verdict.reason), /no evidence entries/);
    });

    it('flags a pack captured on the wrong network', () => {
      const verdict = isPackStale(makePack({ network: 'PUBLIC' as any }));
      assert.equal(verdict.stale, true);
      assert.match(String(verdict.reason), /not TESTNET/);
    });

    it('flags an unreadable timestamp', () => {
      const verdict = isPackStale(makePack({ generatedAt: 'not-a-date' }));
      assert.equal(verdict.stale, true);
    });
  });

  describe('Artifacts', () => {
    it('writes a versioned pack and a rendered sheet', () => {
      const pack = makePack();
      const { packPath, markdownPath } = writeEvidencePack(pack, tmpDir);

      const written = JSON.parse(fs.readFileSync(packPath, 'utf-8')) as EvidencePack;
      assert.equal(written.version, 1);
      assert.equal(written.network, 'TESTNET');
      assert.equal(written.entries.length, 3);

      const markdown = fs.readFileSync(markdownPath, 'utf-8');
      assert.match(markdown, /Do not edit by hand/);
      assert.match(markdown, /Testnet was reset/);
      assert.match(markdown, /xlm-payment/);
    });

    it('records the ledger fingerprint used for the capture', () => {
      const pack = makePack({ ledgerAtCapture: 4_242_424 });
      assert.equal(pack.ledgerAtCapture, 4_242_424);
      assert.match(renderEvidenceMarkdown(pack), /4242424/);
    });

    it('builds a testnet explorer URL', () => {
      assert.equal(
        explorerTxUrl('https://horizon-testnet.stellar.org', 'abc'),
        'https://stellar.expert/explorer/testnet/tx/abc',
      );
      assert.equal(
        explorerTxUrl('https://horizon.stellar.org', 'abc'),
        'https://stellar.expert/explorer/mainnet/tx/abc',
      );
    });

    it('returns null when no pack file exists', () => {
      assert.equal(readEvidencePack(path.join(tmpDir, 'missing.json')), null);
    });

    it('reads back a pack it just wrote', () => {
      const { packPath } = writeEvidencePack(makePack(), tmpDir);
      assert.equal(readEvidencePack(packPath)?.entries.length, 3);
    });
  });
});
