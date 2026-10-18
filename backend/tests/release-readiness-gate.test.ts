import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as path from 'path';
import * as fs from 'fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  runReleaseReadinessGate,
  checkMigrationsGate,
  checkSecurityGate,
  checkSmokeTestsGate,
  checkRollbackRehearsalGate,
} from '../../scripts/release-readiness-gate';
import { backoffDelay, isAllowedProbeUrl, type ProbeOptions } from '../../scripts/http-probe';
import type { ValidationDatabase } from '../src/db/restore-validation';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('Release readiness gate contract (Issue #270)', () => {
  it('evaluates all 4 required gates successfully on current codebase', async () => {
    const report = await runReleaseReadinessGate({ repoRoot: REPO_ROOT });

    assert.equal(report.ready, true);
    assert.equal(report.totalGates, 4);
    assert.equal(report.passedGates, 4);
    assert.equal(report.failedGates, 0);

    assert.equal(report.gates.migrations.status, 'PASS');
    assert.equal(report.gates.security.status, 'PASS');
    assert.equal(report.gates.smoke_tests.status, 'PASS');
    assert.equal(report.gates.rollback_rehearsal.status, 'PASS');
  });

  it('blocks release if schema contains uncontained or unapproved destructive operations', async () => {
    // Test with temporary directory containing a destructive drop
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-bad-schema');
    fs.mkdirSync(path.join(tempDir, 'db'), { recursive: true });

    try {
      fs.writeFileSync(
        path.join(tempDir, 'db', 'schema.sql'),
        `CREATE TABLE IF NOT EXISTS invoices (id UUID PRIMARY KEY);\nDROP TABLE invoices CASCADE;`
      );

      const result = await checkMigrationsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /destructive action/i);
      assert.ok(result.details.some((d) => d.toLowerCase().includes('invoices')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks release if schema table creations are non-idempotent', async () => {
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-non-idempotent-schema');
    fs.mkdirSync(path.join(tempDir, 'db'), { recursive: true });

    try {
      fs.writeFileSync(
        path.join(tempDir, 'db', 'schema.sql'),
        `CREATE TABLE raw_invoices (id UUID PRIMARY KEY);`
      );

      const result = await checkMigrationsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /without IF NOT EXISTS/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks release if deploy smoke test is missing', async () => {
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-empty-repo');
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });

    try {
      const result = await checkSmokeTestsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /deploy-smoke.mjs is missing/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks release if smoke test script lacks required endpoint coverage', async () => {
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-incomplete-smoke');
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });

    try {
      fs.writeFileSync(
        path.join(tempDir, 'scripts', 'deploy-smoke.mjs'),
        `console.log("smoke test with no endpoints");`
      );

      const result = await checkSmokeTestsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /does not verify essential endpoints/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('validates rollback rehearsal invariants and produces actionable failure details on violations', async () => {
    const rehearsalResult = await checkRollbackRehearsalGate();
    assert.equal(rehearsalResult.status, 'PASS');
    assert.ok(rehearsalResult.details.some((d) => d.includes('data invariant checks')));
  });
});

/** Scripted fetch: each call consumes the next response (the last one repeats). */
function scriptedFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function probeWith(fetchImpl: typeof fetch, sleeps: number[] = []): ProbeOptions {
  return { fetchImpl, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, sleep: async (ms) => { sleeps.push(ms); } };
}

const HEALTHY = { status: 200, body: { status: 'ok', ready: true } };

describe('Release readiness checks for migrations, smoke tests and rollback (Issue #313)', () => {
  describe('bounded retry probe', () => {
    it('backs off exponentially, caps the delay, and honours Retry-After', () => {
      assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffDelay(n, 1_000, 8_000)), [1_000, 2_000, 4_000, 8_000, 8_000]);
      assert.equal(backoffDelay(1, 1_000, 8_000, '3'), 3_000);
      assert.equal(backoffDelay(1, 1_000, 8_000, '120'), 8_000);
      const now = Date.parse('2026-10-17T12:00:00Z');
      assert.equal(backoffDelay(1, 1_000, 8_000, 'Sat, 17 Oct 2026 12:00:05 GMT', () => now), 5_000);
      assert.equal(backoffDelay(2, 1_000, 8_000, 'not-a-date'), 2_000);
    });

    it('accepts HTTPS anywhere and plain HTTP only on loopback', () => {
      assert.equal(isAllowedProbeUrl('https://api.example.com/api'), true);
      assert.equal(isAllowedProbeUrl('http://127.0.0.1:3001/api'), true);
      assert.equal(isAllowedProbeUrl('http://localhost:3001/api'), true);
      assert.equal(isAllowedProbeUrl('http://api.example.com/api'), false);
      assert.equal(isAllowedProbeUrl('not a url'), false);
    });
  });

  describe('live smoke against a running MVP server (normal path)', () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
      process.env.NODE_ENV = 'production';
      process.env.FRONTEND_URL = 'https://quittance.example';
      process.env.ALLOW_SIMULATE = 'false';
      process.env.STELLAR_NETWORK = 'TESTNET';
      process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
      const { default: app } = await import('../src/server-mvp.ts');
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('passes when the deployed /health and /ready contracts hold', async () => {
      const result = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: baseUrl });
      assert.equal(result.status, 'PASS', JSON.stringify(result));
      assert.ok(result.details.includes('Live /health returned status=ok after 1 attempt(s).'));
      assert.ok(result.details.includes('Live /ready returned ready=true after 1 attempt(s).'));
    });
  });

  describe('live smoke failure, retry and authorization paths', () => {
    it('retries a cold-starting target and passes once it is ready', async () => {
      const sleeps: number[] = [];
      const { fetchImpl, calls } = scriptedFetch([new Error('ECONNREFUSED'), { status: 503, body: { ready: false } }, HEALTHY]);
      const result = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'https://api.example.com/api/', probe: probeWith(fetchImpl, sleeps) });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(sleeps, [100, 200]);
      assert.equal(calls[0], 'https://api.example.com/api/health');
      assert.ok(result.details.includes('Live /health returned status=ok after 3 attempt(s).'));
    });

    it('blocks the release when readiness never recovers and surfaces its reasons', async () => {
      const { fetchImpl, calls } = scriptedFetch([HEALTHY, { status: 503, body: { ready: false, reasons: ['ALLOW_SIMULATE must be false in deploy environments'] } }]);
      const result = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'https://api.example.com/api', probe: probeWith(fetchImpl) });
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /\/ready did not become healthy after 3 attempt/);
      assert.ok(result.details.some((d) => d.includes('ALLOW_SIMULATE must be false')));
      assert.match(result.remediation ?? '', /roll back/);
      assert.equal(calls.length, 4);
    });

    it('fails fast without retrying when the target rejects the probe (401/403)', async () => {
      const sleeps: number[] = [];
      const { fetchImpl, calls } = scriptedFetch([{ status: 401, body: { error: 'Authentication required' } }]);
      const result = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'https://preview.example.com/api', probe: probeWith(fetchImpl, sleeps) });
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /rejected the unauthenticated smoke probe \(HTTP 401\)/);
      assert.match(result.remediation ?? '', /deployment protection/);
      assert.equal(calls.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('retries a non-JSON success (interstitial page) and fails it only after the budget', async () => {
      const recovering = scriptedFetch([{ status: 200, body: undefined }, HEALTHY]);
      const passed = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'https://api.example.com/api', probe: probeWith(recovering.fetchImpl) });
      assert.equal(passed.status, 'PASS');
      assert.ok(passed.details.includes('Live /health returned status=ok after 2 attempt(s).'));

      const stuck = scriptedFetch([{ status: 200, body: undefined }]);
      const failed = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'https://api.example.com/api', probe: probeWith(stuck.fetchImpl) });
      assert.equal(failed.status, 'FAIL');
      assert.ok(failed.details.some((d) => d.includes('returned non-JSON')));
      assert.equal(stuck.calls.length, 3);
    });

    it('allows a cold start of about one minute by default', async () => {
      const sleeps: number[] = [];
      const { fetchImpl, calls } = scriptedFetch([{ status: 503 }]);
      await checkSmokeTestsGate(REPO_ROOT, {
        smokeUrl: 'https://api.example.com/api',
        probe: { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } },
      });
      assert.equal(calls.length, 10);
      assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 90_000);
    });

    it('rejects plaintext non-loopback targets and broken health contracts', async () => {
      const insecure = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'http://api.example.com/api' });
      assert.equal(insecure.status, 'FAIL');
      assert.match(insecure.summary, /not an HTTPS URL/);

      const { fetchImpl } = scriptedFetch([{ status: 200, body: { status: 'degraded' } }]);
      const degraded = await checkSmokeTestsGate(REPO_ROOT, { smokeUrl: 'https://api.example.com/api', probe: probeWith(fetchImpl) });
      assert.equal(degraded.status, 'FAIL');
      assert.match(degraded.summary, /\/health responded without status=ok/);
    });
  });

  describe('destructive migration approvals', () => {
    async function withSchema(name: string, sql: string, run: (dir: string) => Promise<void>) {
      const dir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', name);
      fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'db', 'schema.sql'), sql);
      try {
        await run(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    const DROP_SQL = 'CREATE TABLE IF NOT EXISTS invoices (id UUID PRIMARY KEY);\nALTER TABLE invoices DROP COLUMN IF EXISTS legacy_note;';

    it('blocks an unapproved drop and passes it once a maintainer approves it for this release', () =>
      withSchema('temp-approved-drop', DROP_SQL, async (dir) => {
        const blocked = await checkMigrationsGate(dir);
        assert.equal(blocked.status, 'FAIL');
        assert.ok(blocked.details.some((d) => d.includes('invoices.legacy_note')));

        const approved = await checkMigrationsGate(dir, { approvedDestructive: ['Invoices.Legacy_Note'] });
        assert.equal(approved.status, 'PASS', JSON.stringify(approved));
        assert.ok(approved.details.some((d) => d.startsWith('Maintainer-approved for this release: invoices.legacy_note')));
        assert.ok(approved.details.some((d) => d.startsWith('Rollback: invoices.legacy_note')));
      }));

    it('rejects standing approvals that match nothing in the release', async () => {
      const result = await checkMigrationsGate(REPO_ROOT, { approvedDestructive: ['invoices.amount'] });
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /does not match any action/);
      assert.deepEqual(result.details, ['Unused approval: invoices.amount']);
    });
  });

  describe('target database convergence and rollback rehearsal', () => {
    // Catalog lookups find every table; invariant and backfill queries find no offending rows.
    const converged: ValidationDatabase = {
      async query(sql: string) {
        const catalog = sql.includes('pg_class') || sql.includes('information_schema');
        return { rows: catalog ? ['invoices', 'transactions', 'payment_events', 'jobs'].map((name) => ({ name })) : [] };
      },
    };
    const empty: ValidationDatabase = { async query() { return { rows: [] }; } };
    const unreachable: ValidationDatabase = { async query() { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } };

    it('passes migrations when every declared object exists on the target', async () => {
      const result = await checkMigrationsGate(REPO_ROOT, { database: converged });
      assert.equal(result.status, 'PASS', JSON.stringify(result));
      assert.ok(result.details.some((d) => /^Target database converged: \d+ post-check\(s\) passed\.$/.test(d)));
    });

    it('blocks when the target has not converged, naming the missing objects', async () => {
      const result = await checkMigrationsGate(REPO_ROOT, { database: empty });
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /has not converged/);
      assert.ok(result.details.includes('table invoices exists: missing after migration'));
      assert.match(result.remediation ?? '', /db:migrate/);
    });

    it('rehearses rollback against the target and reports violations and missing tables', async () => {
      const restored: ValidationDatabase = {
        async query(sql: string) {
          if (sql.includes('pg_class')) return { rows: [{ name: 'invoices' }, { name: 'transactions' }, { name: 'payment_events' }] };
          return { rows: [{ id: 'inv-1', count: 2 }] };
        },
      };
      const result = await checkRollbackRehearsalGate({ database: restored });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.details.includes('Missing table after restore: jobs'));
    });

    it('fails closed when the target database is unreachable', async () => {
      const migrations = await checkMigrationsGate(REPO_ROOT, { database: unreachable });
      assert.equal(migrations.status, 'FAIL');
      assert.ok(migrations.details.some((d) => d.includes('ECONNREFUSED')));

      const rollback = await checkRollbackRehearsalGate({ database: unreachable });
      assert.equal(rollback.status, 'FAIL');
      assert.ok(rollback.details.some((d) => d.includes('ECONNREFUSED')));
    });

    it('passes the full gate with a converged target and a healthy deploy', async () => {
      const { fetchImpl } = scriptedFetch([HEALTHY]);
      const report = await runReleaseReadinessGate({
        repoRoot: REPO_ROOT,
        database: converged,
        smokeUrl: 'https://api.example.com/api',
        probe: probeWith(fetchImpl),
      });
      assert.equal(report.ready, true, JSON.stringify(report.gates, null, 2));
      assert.ok(report.gates.rollback_rehearsal.details.includes('Rehearsed against the target database (read-only session).'));
    });
  });
});
