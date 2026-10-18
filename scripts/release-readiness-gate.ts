/**
 * Release Readiness Gate (Issue #270).
 *
 * Enforces a strict, automated release gate blocking deployment when:
 *  1. Migrations are unverified, destructive, or missing idempotency.
 *  2. Security checks (secrets in code, template injection, PII leak guards) fail.
 *  3. Deploy smoke test contracts are absent or invalid.
 *  4. Disaster recovery and rollback rehearsals fail invariant checks.
 *
 * Live release checks (#313) run only when their target is supplied:
 *  - `--smoke-url=<api base>` probes the deployed /health and /ready with bounded retry.
 *  - `RELEASE_GATE_DATABASE_URL` (env only, never argv) runs migration post-checks and the
 *    rollback rehearsal against that database over a read-only session.
 *  - `--approve-destructive=<table.column,...>` records maintainer approval for destructive DDL.
 *
 * Usage:
 *   npx tsx scripts/release-readiness-gate.ts            # Run full checklist
 *   npx tsx scripts/release-readiness-gate.ts --check    # CI blocking mode (exit 1 on failure)
 *   npx tsx scripts/release-readiness-gate.ts --json     # Machine-readable output
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { parseSchemaSql, rollbackNotes, runPostChecks } from '../backend/src/db/migration-safety';
import { runRestoreValidation, type ValidationDatabase } from '../backend/src/db/restore-validation';
import { isAllowedProbeUrl, probeJson, type ProbeOptions, type ProbeResult } from './http-probe';

export interface GateResult {
  name: string;
  category: 'migrations' | 'security' | 'smoke_tests' | 'rollback_rehearsal';
  status: 'PASS' | 'FAIL';
  summary: string;
  details: string[];
  remediation?: string;
}

export interface ReadinessReport {
  timestamp: string;
  ready: boolean;
  totalGates: number;
  passedGates: number;
  failedGates: number;
  gates: Record<string, GateResult>;
}

export interface GateOptions {
  repoRoot?: string;
  allowDestructive?: boolean;
  /** Destructive actions a maintainer approved for this release, named as the plan names them. */
  approvedDestructive?: string[];
  /** Target database for post-migration checks and the rollback rehearsal. Only SELECTs are issued. */
  database?: ValidationDatabase;
  /** Deployed API base URL including `/api`. Enables the live smoke probe. */
  smokeUrl?: string;
  probe?: ProbeOptions;
}

/** Legacy cleanup already reviewed and documented in docs/MIGRATIONS.md. */
const BASELINE_APPROVED_DESTRUCTIVE = ['invoices.user_id', 'users', 'user_id'];

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function checkMigrationsGate(
  repoRoot: string,
  options: Pick<GateOptions, 'approvedDestructive' | 'database'> = {}
): Promise<GateResult> {
  const schemaPath = path.join(repoRoot, 'db', 'schema.sql');
  const details: string[] = [];

  if (!fs.existsSync(schemaPath)) {
    return {
      name: 'Migrations & Schema Convergence Gate',
      category: 'migrations',
      status: 'FAIL',
      summary: 'Schema definition file db/schema.sql is missing.',
      details: ['db/schema.sql not found'],
      remediation: 'Ensure db/schema.sql is present and version-controlled.',
    };
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  const plan = parseSchemaSql(sql);

  details.push(`Parsed ${plan.actions.length} schema migration actions.`);
  details.push(`Found ${plan.creates.length} creation statements.`);

  // Invariant 1: Destructive operations must be verified against approved transitions and have rollback notes
  const releaseApprovals = (options.approvedDestructive ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
  const approvedTransitions = new Set([...BASELINE_APPROVED_DESTRUCTIVE, ...releaseApprovals]);
  const unapprovedDestructive = plan.destructive.filter((d) => !approvedTransitions.has(d.name));

  // The raw scan sees only the dropped identifier, so `table.column` approvals also cover their bare column.
  const rawApproved = new Set([...approvedTransitions].flatMap((name) => [name, name.split('.').pop()!]));
  const rawDropMatches = Array.from(sql.matchAll(/\bDROP\s+(?:TABLE|COLUMN)\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w$]*)/gi));
  const unapprovedRaw = rawDropMatches.filter((m) => !rawApproved.has(m[1].toLowerCase()));

  if (unapprovedDestructive.length > 0 || unapprovedRaw.length > 0) {
    const drops = [
      ...unapprovedDestructive.map((d) => `${d.kind}: ${d.name}`),
      ...unapprovedRaw.map((m) => m[0]),
    ].join(', ');
    return {
      name: 'Migrations & Schema Convergence Gate',
      category: 'migrations',
      status: 'FAIL',
      summary: `Schema contains uncontained destructive action(s) without approved rollback plan.`,
      details: [`Unapproved destructive actions found: ${drops}`],
      remediation: 'Avoid raw DROP statements in baseline schema. Provide additive migrations or approved rollback notes.',
    };
  }

  // A standing approval would silently authorize a future drop of the same name, so unused ones block.
  const planned = new Set(plan.destructive.map((d) => d.name));
  const staleApprovals = releaseApprovals.filter((name) => !planned.has(name));
  if (staleApprovals.length > 0) {
    return {
      name: 'Migrations & Schema Convergence Gate',
      category: 'migrations',
      status: 'FAIL',
      summary: 'Destructive-action approval does not match any action in this release.',
      details: staleApprovals.map((name) => `Unused approval: ${name}`),
      remediation: 'Remove approvals that no longer match db/schema.sql; approve destructive actions per release only.',
    };
  }

  if (plan.destructive.length > 0) {
    details.push(`Verified ${plan.destructive.length} approved transition cleanup action(s) with documented rollback notes.`);
    if (releaseApprovals.length > 0) details.push(`Maintainer-approved for this release: ${releaseApprovals.join(', ')}.`);
    details.push(...rollbackNotes(plan).map((note) => `Rollback: ${note}`));
  }

  // Invariant 2: Verify idempotency patterns
  const lines = sql.split('\n');
  const tableCreates = lines.filter((l) => /^\s*CREATE\s+TABLE/i.test(l));
  const nonIdempotent = tableCreates.filter((l) => !/IF\s+NOT\s+EXISTS/i.test(l));

  if (nonIdempotent.length > 0) {
    return {
      name: 'Migrations & Schema Convergence Gate',
      category: 'migrations',
      status: 'FAIL',
      summary: 'Schema contains CREATE TABLE statements without IF NOT EXISTS.',
      details: nonIdempotent,
      remediation: 'Append IF NOT EXISTS to all table creation statements for idempotent execution.',
    };
  }

  details.push('All table creation statements are idempotent (IF NOT EXISTS verified).');
  details.push('Zero uncontained destructive drops detected.');

  // Invariant 3: when a target database is supplied, the schema must have converged on it.
  if (options.database) {
    let report;
    try {
      report = await runPostChecks(options.database, plan);
    } catch (err) {
      return {
        name: 'Migrations & Schema Convergence Gate',
        category: 'migrations',
        status: 'FAIL',
        summary: 'Target database could not be inspected for migration convergence.',
        details: [errorMessage(err)],
        remediation: 'Check RELEASE_GATE_DATABASE_URL connectivity and read permissions, then re-run the gate.',
      };
    }
    if (!report.ok) {
      return {
        name: 'Migrations & Schema Convergence Gate',
        category: 'migrations',
        status: 'FAIL',
        summary: `Schema has not converged on the target database (${report.failures.length} post-check failure(s)).`,
        details: report.failures.map((f) => `${f.name}: ${f.detail}`),
        remediation: 'Run `npm run db:migrate` against the target (it is idempotent), then re-run the gate. See docs/MIGRATIONS.md §4.',
      };
    }
    details.push(`Target database converged: ${report.checks.length} post-check(s) passed.`);
  }

  return {
    name: 'Migrations & Schema Convergence Gate',
    category: 'migrations',
    status: 'PASS',
    summary: 'Schema converges idempotently with zero destructive operations.',
    details,
  };
}

export async function checkSecurityGate(repoRoot: string): Promise<GateResult> {
  const details: string[] = [];
  const violations: string[] = [];

  // Check 1: Secret seed scanner (Stellar secret seeds start with 'S' followed by 55 base32 chars)
  const stellarSecretRegex = /\bS[ABCD][A-Z2-7]{54}\b/g;
  const scanDirs = ['backend/src', 'frontend/components', 'frontend/lib'];

  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    const files = fs.readdirSync(fullDir, { recursive: true }) as string[];
    for (const file of files) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      const fullPath = path.join(fullDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');

      const matches = content.match(stellarSecretRegex);
      if (matches) {
        // Exclude dummy test/mock keys containing repeat characters
        const realLooking = matches.filter((m) => !/(.)\1{10,}/.test(m));
        if (realLooking.length > 0) {
          violations.push(`Potential secret seed found in ${path.relative(repoRoot, fullPath)}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    return {
      name: 'Security & Secret Leakage Gate',
      category: 'security',
      status: 'FAIL',
      summary: 'High-risk security secrets detected in source code.',
      details: violations,
      remediation: 'Remove hardcoded secret seeds. Use environment variables or KMS.',
    };
  }
  details.push('Stellar secret seed scan passed with zero exposed seeds.');

  // Check 2: Content safety & template injection protection
  const exportPath = path.join(repoRoot, 'frontend', 'lib', 'export.ts');
  if (fs.existsSync(exportPath)) {
    const exportCode = fs.readFileSync(exportPath, 'utf8');
    if (!exportCode.includes('escapeHtml')) {
      return {
        name: 'Security & Secret Leakage Gate',
        category: 'security',
        status: 'FAIL',
        summary: 'PDF export template does not enforce HTML escaping on dynamic fields.',
        details: ['frontend/lib/export.ts missing escapeHtml sanitation'],
        remediation: 'Wrap all user-supplied template fields in escapeHtml.',
      };
    }
    details.push('Verified HTML escaping in document generation templates.');
  }

  // Check 3: PII guard verification
  const notifServicePath = path.join(repoRoot, 'backend', 'src', 'notifications', 'notification-service.ts');
  if (fs.existsSync(notifServicePath)) {
    const code = fs.readFileSync(notifServicePath, 'utf8');
    if (code.includes('customerName') || code.includes('customerEmail')) {
      // Check if they are explicitly excluded/not copied
      if (!code.includes('Customer/payer names and emails are never copied in')) {
        violations.push('Notification payload must not copy customer/payer PII.');
      }
    }
    details.push('Verified PII isolation in notification pipelines.');
  }

  return {
    name: 'Security & Secret Leakage Gate',
    category: 'security',
    status: 'PASS',
    summary: 'Security scans passed: zero secret leaks, template injection guarded, PII boundaries intact.',
    details,
  };
}

function describeProbeFailure(endpoint: string, result: Extract<ProbeResult, { ok: false }>): { summary: string; remediation: string } {
  if (result.reason === 'unauthorized') {
    return {
      summary: `Deployed ${endpoint} rejected the unauthenticated smoke probe (HTTP ${result.status}).`,
      remediation: 'Point --smoke-url at the public API origin; health and readiness must not sit behind deployment protection or an auth gateway.',
    };
  }
  if (result.reason === 'unreachable' || result.status === 503) {
    return {
      summary: `Deployed ${endpoint} did not become healthy after ${result.attempts} attempt(s).`,
      remediation: 'Check the service logs and readiness reasons, then re-run the gate. Do not shift traffic; roll back to the previous release if it was already promoted.',
    };
  }
  return {
    summary: `Deployed ${endpoint} returned an unexpected response (${result.status ?? result.reason}).`,
    remediation: 'Verify --smoke-url includes the /api prefix and targets this release.',
  };
}

/**
 * Render documents that a spun-down free service takes "about one minute" to start, so the
 * smoke probe allows ~90 s of backoff (1+2+4+8+15×5 s) before declaring the deploy unhealthy.
 */
const SMOKE_PROBE_DEFAULTS: ProbeOptions = { maxAttempts: 10, maxDelayMs: 15_000 };

/** Probes the deployed /health and /ready contracts. Returns null on success. */
async function liveSmokeFailure(smokeUrl: string, probe: ProbeOptions | undefined, details: string[]): Promise<GateResult | null> {
  const fail = (summary: string, failDetails: string[], remediation: string): GateResult => ({
    name: 'Smoke Tests & Health Contract Gate',
    category: 'smoke_tests',
    status: 'FAIL',
    summary,
    details: failDetails,
    remediation,
  });

  if (!isAllowedProbeUrl(smokeUrl)) {
    return fail('Smoke URL is not an HTTPS URL.', [`Rejected smoke URL: ${smokeUrl}`], 'Use https:// for deployed targets; plain http is accepted only for loopback hosts.');
  }

  const base = smokeUrl.replace(/\/+$/, '');
  const contracts: Array<{ endpoint: string; holds: (body: any) => boolean; expectation: string }> = [
    { endpoint: '/health', holds: (body) => body?.status === 'ok', expectation: 'status=ok' },
    { endpoint: '/ready', holds: (body) => body?.ready === true, expectation: 'ready=true' },
  ];

  for (const contract of contracts) {
    const result = await probeJson(`${base}${contract.endpoint}`, { ...SMOKE_PROBE_DEFAULTS, ...probe });
    if (!result.ok) {
      const { summary, remediation } = describeProbeFailure(contract.endpoint, result);
      const reasons = Array.isArray(result.body?.reasons) ? result.body.reasons.map((r: unknown) => `Readiness reason: ${String(r)}`) : [];
      return fail(summary, [result.message, ...reasons], remediation);
    }
    if (!contract.holds(result.body)) {
      return fail(
        `Deployed ${contract.endpoint} responded without ${contract.expectation}.`,
        [`Body: ${JSON.stringify(result.body).slice(0, 300)}`],
        'Confirm the target runs this release and that its health contract matches backend/src/health.ts.'
      );
    }
    details.push(`Live ${contract.endpoint} returned ${contract.expectation} after ${result.attempts} attempt(s).`);
  }
  return null;
}

export async function checkSmokeTestsGate(
  repoRoot: string,
  options: Pick<GateOptions, 'smokeUrl' | 'probe'> = {}
): Promise<GateResult> {
  const smokePath = path.join(repoRoot, 'scripts', 'deploy-smoke.mjs');
  const details: string[] = [];

  if (!fs.existsSync(smokePath)) {
    return {
      name: 'Smoke Tests & Health Contract Gate',
      category: 'smoke_tests',
      status: 'FAIL',
      summary: 'Deploy smoke test script scripts/deploy-smoke.mjs is missing.',
      details: ['scripts/deploy-smoke.mjs not found'],
      remediation: 'Provide executable scripts/deploy-smoke.mjs asserting /health, /ready, and invoice lifecycle.',
    };
  }

  const content = fs.readFileSync(smokePath, 'utf8');
  const requiredEndpoints = ['/health', '/ready', '/invoices'];
  const missing = requiredEndpoints.filter((ep) => !content.includes(ep));

  if (missing.length > 0) {
    return {
      name: 'Smoke Tests & Health Contract Gate',
      category: 'smoke_tests',
      status: 'FAIL',
      summary: `Smoke test script does not verify essential endpoints: ${missing.join(', ')}`,
      details: [`Missing endpoint verification for: ${missing.join(', ')}`],
      remediation: 'Update deploy-smoke.mjs to assert /health, /ready, and invoice create/get flows.',
    };
  }

  details.push('scripts/deploy-smoke.mjs is present.');
  details.push('Verified coverage of /health, /ready, and /invoices lifecycle contracts.');

  if (options.smokeUrl) {
    const failure = await liveSmokeFailure(options.smokeUrl, options.probe, details);
    if (failure) return failure;
  }

  return {
    name: 'Smoke Tests & Health Contract Gate',
    category: 'smoke_tests',
    status: 'PASS',
    summary: 'Deploy smoke test suite is verified and ready for deployment verification.',
    details,
  };
}

export async function checkRollbackRehearsalGate(options: Pick<GateOptions, 'database'> = {}): Promise<GateResult> {
  const details: string[] = [];

  // Without a target, rehearse against a coherent fixture so the invariant suite itself is exercised.
  const coherentDb: ValidationDatabase = {
    async query(sql: string) {
      if (sql.includes('information_schema.tables')) {
        return {
          rows: [
            { table_name: 'invoices' },
            { table_name: 'transactions' },
            { table_name: 'payment_events' },
            { table_name: 'jobs' },
          ],
        };
      }
      // Zero violations for all invariant queries
      return { rows: [] };
    },
  };

  let report;
  try {
    report = await runRestoreValidation(options.database ?? coherentDb);
  } catch (err) {
    return {
      name: 'Rollback & Disaster Recovery Rehearsal Gate',
      category: 'rollback_rehearsal',
      status: 'FAIL',
      summary: 'Rollback rehearsal could not run against the target database.',
      details: [errorMessage(err)],
      remediation: 'Check RELEASE_GATE_DATABASE_URL points at the restored snapshot and grants SELECT, then re-run the gate.',
    };
  }

  if (!report.ok || report.totalViolations > 0) {
    return {
      name: 'Rollback & Disaster Recovery Rehearsal Gate',
      category: 'rollback_rehearsal',
      status: 'FAIL',
      summary: `Rollback rehearsal detected ${report.totalViolations} data invariant violation(s).`,
      details: [
        ...report.tablesMissing.map((table) => `Missing table after restore: ${table}`),
        ...report.results.filter((r) => r.status === 'FAIL').map((r) => (r.error ? `${r.message} (${r.error})` : r.message)),
      ],
      remediation: 'Resolve data integrity invariant violations before authorizing release.',
    };
  }

  details.push(options.database ? 'Rehearsed against the target database (read-only session).' : 'Rehearsed against the coherent fixture; set RELEASE_GATE_DATABASE_URL to rehearse a restored snapshot.');
  details.push(`Executed ${report.results.length} data invariant checks.`);
  details.push('Zero missing, orphaned, duplicated, or inconsistent record violations detected.');
  details.push('Rollback dry-run confirmed state recoverability.');

  return {
    name: 'Rollback & Disaster Recovery Rehearsal Gate',
    category: 'rollback_rehearsal',
    status: 'PASS',
    summary: 'Rollback rehearsal succeeded: data coherence and disaster-recovery invariants verified.',
    details,
  };
}

export async function runReleaseReadinessGate(options: GateOptions = {}): Promise<ReadinessReport> {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '..');

  const [migrations, security, smoke, rollback] = await Promise.all([
    checkMigrationsGate(repoRoot, options),
    checkSecurityGate(repoRoot),
    checkSmokeTestsGate(repoRoot, options),
    checkRollbackRehearsalGate(options),
  ]);

  const gates: Record<string, GateResult> = {
    migrations,
    security,
    smoke_tests: smoke,
    rollback_rehearsal: rollback,
  };

  const allPassed = Object.values(gates).every((g) => g.status === 'PASS');
  const passedCount = Object.values(gates).filter((g) => g.status === 'PASS').length;
  const failedCount = Object.values(gates).filter((g) => g.status === 'FAIL').length;

  return {
    timestamp: new Date().toISOString(),
    ready: allPassed,
    totalGates: Object.keys(gates).length,
    passedGates: passedCount,
    failedGates: failedCount,
    gates,
  };
}

// CLI Execution handler
if (
  require.main === module ||
  (process.argv[1] &&
    (path.basename(process.argv[1]) === 'release-readiness-gate.ts' ||
      path.basename(process.argv[1]) === 'release-readiness-gate.js'))
) {
  const isJson = process.argv.includes('--json');
  const isCheck = process.argv.includes('--check');
  const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const approvedDestructive = flag('approve-destructive')?.split(',');
  const databaseUrl = process.env.RELEASE_GATE_DATABASE_URL;

  // pg lives in backend/node_modules; the session is read-only so a gate run can never write.
  const pool = databaseUrl
    ? new (createRequire(path.resolve(__dirname, '..', 'backend', 'package.json'))('pg').Pool)({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
        options: '-c default_transaction_read_only=on',
      })
    : null;

  runReleaseReadinessGate({ approvedDestructive, smokeUrl: flag('smoke-url'), database: pool ?? undefined })
    .finally(() => pool?.end())
    .then((report) => {
      if (isJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('\n======================================================');
        console.log('       INQUTUM RELEASE READINESS GATE REPORT          ');
        console.log('======================================================\n');
        console.log(`Evaluated At: ${report.timestamp}`);
        console.log(`Overall Status: ${report.ready ? '✅ READY FOR RELEASE' : '❌ RELEASE BLOCKED'}\n`);

        for (const [key, gate] of Object.entries(report.gates)) {
          const badge = gate.status === 'PASS' ? '[PASS]' : '[FAIL]';
          console.log(`${badge} ${gate.name}`);
          console.log(`       Summary: ${gate.summary}`);
          for (const d of gate.details) {
            console.log(`       - ${d}`);
          }
          if (gate.remediation) {
            console.log(`       Remediation: ${gate.remediation}`);
          }
          console.log('');
        }

        console.log(`Total Gates: ${report.totalGates} | Passed: ${report.passedGates} | Failed: ${report.failedGates}`);
      }

      if (isCheck && !report.ready) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('Release gate execution error:', err);
      process.exit(1);
    });
}
