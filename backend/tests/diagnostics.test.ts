import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Networks } from '@stellar/stellar-sdk';
import {
  runDiagnostics,
  formatDiagnosticsOutput,
  checkWorkspaceDependencies,
  checkAdminAuthorization,
  checkHorizonNetwork,
  checkSeedData,
  checkCommonFailureFixes,
  STELLAR_NETWORK_PASSPHRASES,
} from '../../scripts/diagnostics';
import type { ProbeOptions } from '../../scripts/http-probe';

describe('Contributor Diagnostics Suite (Issue #91)', () => {
  it('runs diagnostics without throwing and checks core environment categories', async () => {
    const summary = await runDiagnostics({
      NODE_ENV: 'development',
      PORT: '3001',
      STELLAR_NETWORK: 'TESTNET',
      FRONTEND_URL: 'http://localhost:3000',
    });

    assert.ok(summary.totalChecks >= 4);
    assert.ok(summary.passed >= 3);
    assert.strictEqual(summary.failures, 0);

    const categories = summary.results.map((r) => r.category);
    assert.ok(categories.includes('runtime'));
    assert.ok(categories.includes('fixtures'));
    assert.ok(categories.includes('config'));
    assert.ok(categories.includes('network'));
  });

  it('reports actionable remediation text when misconfigurations are detected', async () => {
    const summary = await runDiagnostics({
      NODE_ENV: 'production',
      ALLOW_SIMULATE: 'true', // Forbidden in production
    });

    const configResult = summary.results.find((r) => r.name === 'Environment Validation');
    assert.ok(configResult);
    assert.strictEqual(configResult.status, 'FAIL');
    assert.ok(configResult.remediation);
    assert.ok(configResult.remediation.includes('backend/env'));
  });

  it('formats output with clear visual indicators and actionable sections', async () => {
    const summary = await runDiagnostics({});
    const output = formatDiagnosticsOutput(summary);

    assert.ok(output.includes('Inqutum Contributor Local Health Diagnostics'));
    assert.ok(output.includes('Summary:'));
    assert.ok(output.includes('Node.js Version'));
  });
});

/** Scripted fetch: each call consumes the next response (the last one repeats). */
function scriptedProbe(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: string[] = [];
  const probe: ProbeOptions = {
    maxAttempts: 3,
    baseDelayMs: 1,
    sleep: async () => undefined,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  };
  return { probe, calls };
}

const TESTNET_ROOT = { status: 200, body: { network_passphrase: Networks.TESTNET, current_protocol_version: 23 } };

/** Builds a throwaway repo root with one workspace. */
function workspaceFixture(setup: { lock?: object | null; installed?: Record<string, string> }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const ws = path.join(root, 'backend');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ dependencies: { zod: '^3.23.8' }, devDependencies: { typescript: '^5.3.3' } }));
  const lock = setup.lock === undefined
    ? {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { zod: '^3.23.8' }, devDependencies: { typescript: '^5.3.3' } },
          'node_modules/zod': { version: '3.23.8' },
          'node_modules/typescript': { version: '5.4.5' },
        },
      }
    : setup.lock;
  if (lock) fs.writeFileSync(path.join(ws, 'package-lock.json'), JSON.stringify(lock));
  for (const [name, version] of Object.entries(setup.installed ?? {})) {
    fs.mkdirSync(path.join(ws, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('Contributor diagnostics: dependency, authorization and network validation (Issue #311)', () => {
  it('pins the Stellar network passphrases to the SDK constants', () => {
    assert.equal(STELLAR_NETWORK_PASSPHRASES.TESTNET, Networks.TESTNET);
    assert.equal(STELLAR_NETWORK_PASSPHRASES.PUBLIC, Networks.PUBLIC);
  });

  describe('workspace dependencies', () => {
    it('passes when the lockfile is in sync and every package is installed at its locked version', () => {
      const { root, cleanup } = workspaceFixture({ installed: { zod: '3.23.8', typescript: '5.4.5' } });
      try {
        const result = checkWorkspaceDependencies(root, 'backend');
        assert.equal(result.status, 'PASS', result.message);
        assert.match(result.message, /all 2 declared packages/);
      } finally {
        cleanup();
      }
    });

    it('fails when package.json and package-lock.json drift, naming the packages', () => {
      const { root, cleanup } = workspaceFixture({
        lock: { lockfileVersion: 3, packages: { '': { dependencies: { zod: '^3.22.0' }, devDependencies: { typescript: '^5.3.3' } } } },
      });
      try {
        const result = checkWorkspaceDependencies(root, 'backend');
        assert.equal(result.status, 'FAIL');
        assert.match(result.message, /disagree on: zod/);
        assert.match(result.remediation ?? '', /npm install/);
      } finally {
        cleanup();
      }
    });

    it('fails when the lockfile is missing', () => {
      const { root, cleanup } = workspaceFixture({ lock: null });
      try {
        const result = checkWorkspaceDependencies(root, 'backend');
        assert.equal(result.status, 'FAIL');
        assert.match(result.message, /package-lock.json is missing/);
      } finally {
        cleanup();
      }
    });

    it('warns (retryable with npm ci) when packages are missing or stale', () => {
      const { root, cleanup } = workspaceFixture({ installed: { zod: '3.20.0' } });
      try {
        const result = checkWorkspaceDependencies(root, 'backend');
        assert.equal(result.status, 'WARN');
        assert.match(result.message, /1 not installed \(typescript\)/);
        assert.match(result.message, /1 differ from the lockfile \(zod\)/);
        assert.match(result.remediation ?? '', /npm ci/);
      } finally {
        cleanup();
      }
    });
  });

  describe('admin authorization secrets', () => {
    const WEAK = 'short-secret';

    it('passes when unset (routes disabled) or strong', () => {
      assert.equal(checkAdminAuthorization({}).status, 'PASS');
      const strong = checkAdminAuthorization({ JOBS_ADMIN_TOKEN: 'a'.repeat(32), MAINTAINER_INTENT_SECRET: 'b'.repeat(32) });
      assert.equal(strong.status, 'PASS');
      assert.match(strong.message, /JOBS_ADMIN_TOKEN configured; MAINTAINER_INTENT_SECRET configured/);
    });

    it('flags a short intent secret that would silently disable approvals, without echoing it', () => {
      const dev = checkAdminAuthorization({ JOBS_ADMIN_TOKEN: 'a'.repeat(32), MAINTAINER_INTENT_SECRET: WEAK });
      assert.equal(dev.status, 'WARN');
      assert.match(dev.message, /approvals stay disabled/);
      assert.ok(!JSON.stringify(dev).includes(WEAK));

      const prod = checkAdminAuthorization({ NODE_ENV: 'production', JOBS_ADMIN_TOKEN: WEAK });
      assert.equal(prod.status, 'FAIL');
      assert.ok(!JSON.stringify(prod).includes(WEAK));
    });

    it('warns when the intent secret is set but the admin guard is not', () => {
      const result = checkAdminAuthorization({ MAINTAINER_INTENT_SECRET: 'b'.repeat(32) });
      assert.equal(result.status, 'WARN');
      assert.match(result.message, /\/ops\/intents routes are unreachable/);
    });
  });

  describe('Horizon network probe', () => {
    const URL = 'https://horizon-testnet.stellar.org';

    it('passes when Horizon serves the configured network', async () => {
      const { probe, calls } = scriptedProbe([TESTNET_ROOT]);
      const result = await checkHorizonNetwork(URL, 'TESTNET', false, probe);
      assert.equal(result.status, 'PASS');
      assert.match(result.message, /protocol 23/);
      assert.deepEqual(calls, [URL]);
    });

    it('fails when Horizon serves a different network than STELLAR_NETWORK', async () => {
      const { probe } = scriptedProbe([TESTNET_ROOT]);
      const result = await checkHorizonNetwork(URL, 'PUBLIC', false, probe);
      assert.equal(result.status, 'FAIL');
      assert.match(result.message, /wrong network/);
    });

    it('retries transient failures before succeeding', async () => {
      const { probe, calls } = scriptedProbe([new Error('ETIMEDOUT'), { status: 429 }, TESTNET_ROOT]);
      const result = await checkHorizonNetwork(URL, 'TESTNET', false, probe);
      assert.equal(result.status, 'PASS');
      assert.match(result.message, /after 3 attempt/);
      assert.equal(calls.length, 3);
    });

    it('fails without retrying when the provider rejects the request', async () => {
      const { probe, calls } = scriptedProbe([{ status: 403 }]);
      const result = await checkHorizonNetwork(URL, 'TESTNET', false, probe);
      assert.equal(result.status, 'FAIL');
      assert.match(result.message, /HTTP 403/);
      assert.equal(calls.length, 1);
    });

    it('warns when offline in development and fails in production', async () => {
      const offline = () => scriptedProbe([new Error('getaddrinfo ENOTFOUND')]).probe;
      assert.equal((await checkHorizonNetwork(URL, 'TESTNET', false, offline())).status, 'WARN');
      assert.equal((await checkHorizonNetwork(URL, 'TESTNET', true, offline())).status, 'FAIL');
      assert.equal((await checkHorizonNetwork('http://horizon.example.com', 'TESTNET', false, offline())).status, 'WARN');
    });
  });

  it('stays offline by default and probes Horizon only when asked', async () => {
    const offlineRun = scriptedProbe([TESTNET_ROOT]);
    const quiet = await runDiagnostics({ NODE_ENV: 'development' }, { probe: offlineRun.probe });
    assert.equal(offlineRun.calls.length, 0);
    assert.ok(quiet.results.some((r) => r.category === 'dependencies'));
    assert.ok(quiet.results.some((r) => r.category === 'authorization'));

    const networkRun = scriptedProbe([TESTNET_ROOT]);
    const probed = await runDiagnostics({ NODE_ENV: 'development' }, { network: true, probe: networkRun.probe });
    assert.equal(networkRun.calls.length, 1);
    assert.equal(probed.results.find((r) => r.name === 'Stellar Horizon Reachability')?.status, 'PASS');
  });

  describe('database seed data and schema fixtures (Issue #258)', () => {
    it('passes when db/seed.sql and db/schema.sql are present and structurally valid', () => {
      const root = path.resolve(__dirname, '../..');
      const result = checkSeedData(root, {});
      assert.equal(result.status, 'PASS');
      assert.match(result.message, /demo seller wallets configured/);
    });

    it('fails when db/seed.sql is missing', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
      try {
        const result = checkSeedData(tempDir, {});
        assert.equal(result.status, 'FAIL');
        assert.match(result.message, /db\/seed\.sql is missing/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('warns when db/seed.sql has no Stellar G-addresses', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
      const dbDir = path.join(tempDir, 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      fs.writeFileSync(path.join(dbDir, 'schema.sql'), 'CREATE TABLE invoices();');
      fs.writeFileSync(path.join(dbDir, 'seed.sql'), 'SELECT 1;');
      try {
        const result = checkSeedData(tempDir, {});
        assert.equal(result.status, 'WARN');
        assert.match(result.message, /no standard Stellar G\.\.\. seller addresses/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('common setup failure fixes and --fix automation (Issue #258)', () => {
    it('detects missing backend/.env and applies safe automated fix when fix=true', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-test-'));
      const backendDir = path.join(tempDir, 'backend');
      const frontendDir = path.join(tempDir, 'frontend');
      fs.mkdirSync(backendDir, { recursive: true });
      fs.mkdirSync(frontendDir, { recursive: true });
      fs.writeFileSync(path.join(backendDir, 'env.mvp.example'), 'PORT=3001\n');
      fs.writeFileSync(path.join(frontendDir, 'env.mvp.local'), 'NEXT_PUBLIC_API_URL=http://localhost:3001/api\n');

      try {
        // Without fix: warns that backend/.env is missing
        const dryRun = checkCommonFailureFixes(tempDir, {}, { fix: false });
        assert.equal(dryRun.status, 'WARN');
        assert.match(dryRun.message, /backend\/\.env is missing/);

        // With fix: creates .env from example
        const fixedRun = checkCommonFailureFixes(tempDir, {}, { fix: true });
        assert.equal(fixedRun.status, 'PASS');
        assert.match(fixedRun.message, /Auto-fixes applied successfully/);
        assert.ok(fs.existsSync(path.join(backendDir, '.env')));
        assert.ok(fs.existsSync(path.join(frontendDir, '.env.local')));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('warns when backend PORT conflicts with frontend default port 3000', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-test-'));
      const backendDir = path.join(tempDir, 'backend');
      const frontendDir = path.join(tempDir, 'frontend');
      fs.mkdirSync(backendDir, { recursive: true });
      fs.mkdirSync(frontendDir, { recursive: true });
      fs.writeFileSync(path.join(backendDir, '.env'), 'PORT=3000\n');
      fs.writeFileSync(path.join(frontendDir, '.env.local'), 'PORT=3000\n');

      try {
        const result = checkCommonFailureFixes(tempDir, { PORT: '3000' });
        assert.equal(result.status, 'WARN');
        assert.match(result.message, /conflicts with default frontend Next\.js port/);
        assert.match(result.remediation ?? '', /Set PORT=3001/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
