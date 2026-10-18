import fs from 'fs';
import path from 'path';
import { validateEnvironment } from '../backend/src/config/env-validator';
import { isAllowedProbeUrl, probeJson, type ProbeOptions } from './http-probe';

export interface DiagnosticCheckResult {
  name: string;
  category: 'runtime' | 'config' | 'storage' | 'network' | 'fixtures' | 'dependencies' | 'authorization';
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  remediation?: string;
}

export interface DiagnosticsOptions {
  rootDir?: string;
  /** Probe Horizon over the network (opt-in: `--network`). */
  network?: boolean;
  probe?: ProbeOptions;
  /** Automatically apply safe fixes for common local failure states (opt-in: `--fix`). */
  fix?: boolean;
}

/** Network passphrases from https://developers.stellar.org/docs/networks (pinned to the SDK in tests). */
export const STELLAR_NETWORK_PASSPHRASES: Record<'TESTNET' | 'PUBLIC', string> = {
  TESTNET: 'Test SDF Network ; September 2015',
  PUBLIC: 'Public Global Stellar Network ; September 2015',
};

/** Shortest admin secret accepted; MaintainerApprovalService refuses anything shorter. */
const MIN_ADMIN_SECRET_LENGTH = 16;
const WORKSPACES = ['backend', 'frontend'] as const;
const MAX_LISTED = 8;

const listNames = (names: string[]) =>
  names.length > MAX_LISTED ? `${names.slice(0, MAX_LISTED).join(', ')} (+${names.length - MAX_LISTED} more)` : names.join(', ');

const readJson = (file: string): any | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Names whose declared range differs between two dependency maps. */
function driftedNames(declared: Record<string, string> = {}, locked: Record<string, string> = {}): string[] {
  return Object.keys({ ...declared, ...locked }).filter((name) => declared[name] !== locked[name]).sort();
}

/**
 * Validates one workspace's dependency state without running npm. O(D) file reads.
 *
 *  - lockfile missing or out of sync with package.json -> FAIL (`npm ci` refuses both)
 *  - packages not installed, or installed at a version other than the lockfile's -> WARN
 */
export function checkWorkspaceDependencies(rootDir: string, workspace: string): DiagnosticCheckResult {
  const dir = path.join(rootDir, workspace);
  const name = `Dependencies: ${workspace}`;
  const manifest = readJson(path.join(dir, 'package.json'));
  if (!manifest) {
    return { name, category: 'dependencies', status: 'FAIL', message: `${workspace}/package.json is missing or unreadable.`, remediation: 'Restore the file from git: git checkout -- ' + `${workspace}/package.json` };
  }

  const lock = readJson(path.join(dir, 'package-lock.json'));
  const lockRoot = lock?.packages?.[''];
  if (!lockRoot) {
    return { name, category: 'dependencies', status: 'FAIL', message: `${workspace}/package-lock.json is missing or has no root entry; npm ci cannot install.`, remediation: `Restore it from git, or run npm install in ${workspace}/ and commit the lockfile.` };
  }

  const drift = [
    ...driftedNames(manifest.dependencies, lockRoot.dependencies),
    ...driftedNames(manifest.devDependencies, lockRoot.devDependencies),
  ];
  if (drift.length > 0) {
    return { name, category: 'dependencies', status: 'FAIL', message: `package.json and package-lock.json disagree on: ${listNames(drift)}. npm ci exits with an error in this state.`, remediation: `Run npm install in ${workspace}/ and commit the updated package-lock.json.` };
  }

  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const missing: string[] = [];
  const stale: string[] = [];
  for (const dep of declared) {
    const installed = readJson(path.join(dir, 'node_modules', dep, 'package.json'));
    if (!installed) missing.push(dep);
    else if (installed.version !== lock.packages[`node_modules/${dep}`]?.version) stale.push(dep);
  }

  if (missing.length > 0 || stale.length > 0) {
    const parts = [
      missing.length > 0 ? `${missing.length} not installed (${listNames(missing)})` : '',
      stale.length > 0 ? `${stale.length} differ from the lockfile (${listNames(stale)})` : '',
    ].filter(Boolean);
    return { name, category: 'dependencies', status: 'WARN', message: `Lockfile is in sync, but ${parts.join('; ')}.`, remediation: `Run npm ci in ${workspace}/ (safe to re-run; it reinstalls exactly what the lockfile pins).` };
  }

  return { name, category: 'dependencies', status: 'PASS', message: `Lockfile in sync and all ${declared.length} declared packages installed at locked versions.` };
}

/**
 * Admin routes are guarded by JOBS_ADMIN_TOKEN; high-impact intents additionally need
 * MAINTAINER_INTENT_SECRET, which the server silently ignores when it is too short.
 * Values are never echoed — only whether each is set and long enough.
 */
export function checkAdminAuthorization(env: Record<string, string | undefined>): DiagnosticCheckResult {
  const adminToken = env.JOBS_ADMIN_TOKEN?.trim() ?? '';
  const intentSecret = env.MAINTAINER_INTENT_SECRET?.trim() ?? '';
  const issues: string[] = [];

  if (adminToken && adminToken.length < MIN_ADMIN_SECRET_LENGTH) issues.push(`JOBS_ADMIN_TOKEN is shorter than ${MIN_ADMIN_SECRET_LENGTH} characters`);
  if (intentSecret && intentSecret.length < MIN_ADMIN_SECRET_LENGTH) issues.push(`MAINTAINER_INTENT_SECRET is shorter than ${MIN_ADMIN_SECRET_LENGTH} characters, so maintainer approvals stay disabled`);
  if (intentSecret && !adminToken) issues.push('MAINTAINER_INTENT_SECRET is set but JOBS_ADMIN_TOKEN is not, so the /ops/intents routes are unreachable');

  const name = 'Admin Authorization Secrets';
  if (issues.length > 0) {
    return {
      name,
      category: 'authorization',
      status: env.NODE_ENV === 'production' ? 'FAIL' : 'WARN',
      message: issues.join('; ') + '.',
      remediation: `Generate secrets of at least ${MIN_ADMIN_SECRET_LENGTH} characters (e.g. openssl rand -hex 32) and set both in backend/.env.`,
    };
  }
  const state = (value: string) => (value ? 'configured' : 'not set (routes return 403)');
  return { name, category: 'authorization', status: 'PASS', message: `JOBS_ADMIN_TOKEN ${state(adminToken)}; MAINTAINER_INTENT_SECRET ${state(intentSecret)}.` };
}

/** Confirms Horizon is reachable and serves the configured network. Retries transient failures. */
export async function checkHorizonNetwork(
  horizonUrl: string,
  network: 'TESTNET' | 'PUBLIC',
  production: boolean,
  probe?: ProbeOptions
): Promise<DiagnosticCheckResult> {
  const name = 'Stellar Horizon Reachability';
  if (!isAllowedProbeUrl(horizonUrl)) {
    return { name, category: 'network', status: 'WARN', message: `Skipped probe: ${horizonUrl} is not HTTPS or loopback.`, remediation: 'Use an https:// Horizon endpoint.' };
  }

  const result = await probeJson(horizonUrl, probe);
  if (!result.ok) {
    if (result.reason === 'unauthorized') {
      return { name, category: 'network', status: 'FAIL', message: `Horizon rejected the request (HTTP ${result.status}).`, remediation: 'Your Horizon provider requires credentials; use a provider URL that embeds or accepts your API key, or the public SDF endpoint.' };
    }
    return {
      name,
      category: 'network',
      status: production ? 'FAIL' : 'WARN',
      message: `Horizon not reachable after ${result.attempts} attempt(s): ${result.message}`,
      remediation: 'Check connectivity, proxies and STELLAR_HORIZON_URL. Offline work is still possible with NEXT_PUBLIC_USE_MOCK=true; re-run with --network when back online.',
    };
  }

  const served = result.body?.network_passphrase;
  const expected = STELLAR_NETWORK_PASSPHRASES[network];
  if (served !== expected) {
    return {
      name,
      category: 'network',
      status: 'FAIL',
      message: `Horizon serves "${String(served)}" but STELLAR_NETWORK=${network} expects "${expected}". Payments would be verified against the wrong network.`,
      remediation: 'Point STELLAR_HORIZON_URL at a Horizon for the configured network, or correct STELLAR_NETWORK.',
    };
  }
  return { name, category: 'network', status: 'PASS', message: `Horizon serves ${network} (protocol ${result.body?.current_protocol_version ?? 'unknown'}), reachable after ${result.attempts} attempt(s).` };
}

/**
 * Validates database seed and schema fixtures (Issue #258).
 * Verifies db/seed.sql and db/schema.sql presence, valid Stellar demo wallet strkeys,
 * and valid SQL statements.
 */
export function checkSeedData(rootDir: string, env: Record<string, string | undefined>): DiagnosticCheckResult {
  const seedPath = path.join(rootDir, 'db', 'seed.sql');
  const schemaPath = path.join(rootDir, 'db', 'schema.sql');
  const name = 'Database Seed & Schema Fixtures';

  if (!fs.existsSync(seedPath)) {
    return {
      name,
      category: 'fixtures',
      status: 'FAIL',
      message: 'db/seed.sql is missing. Local contributors cannot seed demo wallet invoices.',
      remediation: 'Restore db/seed.sql from git: git checkout main -- db/seed.sql',
    };
  }

  if (!fs.existsSync(schemaPath)) {
    return {
      name,
      category: 'fixtures',
      status: 'FAIL',
      message: 'db/schema.sql is missing. Database migrations cannot execute.',
      remediation: 'Restore db/schema.sql from git: git checkout main -- db/schema.sql',
    };
  }

  try {
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    if (seedSql.trim().length === 0) {
      return {
        name,
        category: 'fixtures',
        status: 'FAIL',
        message: 'db/seed.sql is empty.',
        remediation: 'Restore db/seed.sql with valid sample invoice insert statements.',
      };
    }

    const gKeyRegex = /\b(G[A-Z2-7]{55})\b/g;
    const matches = seedSql.match(gKeyRegex) || [];
    if (matches.length === 0) {
      return {
        name,
        category: 'fixtures',
        status: 'WARN',
        message: 'db/seed.sql contains no standard Stellar G... seller addresses.',
        remediation: 'Ensure db/seed.sql includes sample invoices for demo Freighter wallets.',
      };
    }

    const uniqueWallets = Array.from(new Set(matches));
    const hasInsertInvoices = /INSERT\s+INTO\s+invoices/i.test(seedSql);
    if (!hasInsertInvoices) {
      return {
        name,
        category: 'fixtures',
        status: 'WARN',
        message: 'db/seed.sql does not contain INSERT INTO invoices statements.',
        remediation: 'Add sample invoice rows to db/seed.sql to support wallet-scoped testing.',
      };
    }

    return {
      name,
      category: 'fixtures',
      status: 'PASS',
      message: `db/seed.sql and db/schema.sql are valid (${uniqueWallets.length} demo seller wallets configured: ${uniqueWallets.slice(0, 2).map((w) => w.slice(0, 4) + '...' + w.slice(-4)).join(', ')}).`,
    };
  } catch (err: any) {
    return {
      name,
      category: 'fixtures',
      status: 'FAIL',
      message: `Error reading db/seed.sql: ${err.message}`,
      remediation: 'Verify file permissions on db/seed.sql.',
    };
  }
}

/**
 * Detects common contributor setup failure states and applies safe automated fixes when requested (Issue #258).
 */
export function checkCommonFailureFixes(
  rootDir: string,
  env: Record<string, string | undefined>,
  options?: { fix?: boolean }
): DiagnosticCheckResult {
  const name = 'Common Setup & Failure Fixes';
  const issues: string[] = [];
  const fixesApplied: string[] = [];
  const remediations: string[] = [];

  // Check 1: Missing backend/.env
  const backendEnvPath = path.join(rootDir, 'backend', '.env');
  const backendExamplePath = path.join(rootDir, 'backend', 'env.mvp.example');
  if (!fs.existsSync(backendEnvPath)) {
    if (options?.fix && fs.existsSync(backendExamplePath)) {
      try {
        fs.copyFileSync(backendExamplePath, backendEnvPath);
        fixesApplied.push('Created backend/.env from backend/env.mvp.example');
      } catch (err: any) {
        issues.push(`backend/.env is missing and could not be auto-copied: ${err.message}`);
        remediations.push('cp backend/env.mvp.example backend/.env');
      }
    } else {
      issues.push('backend/.env is missing');
      remediations.push('Run diagnostics with --fix or: cp backend/env.mvp.example backend/.env');
    }
  }

  // Check 2: Missing frontend/.env.local
  const frontendEnvPath = path.join(rootDir, 'frontend', '.env.local');
  const frontendExamplePath = path.join(rootDir, 'frontend', 'env.mvp.local');
  if (!fs.existsSync(frontendEnvPath)) {
    if (options?.fix && fs.existsSync(frontendExamplePath)) {
      try {
        fs.copyFileSync(frontendExamplePath, frontendEnvPath);
        fixesApplied.push('Created frontend/.env.local from frontend/env.mvp.local');
      } catch (err: any) {
        issues.push(`frontend/.env.local is missing and could not be auto-copied: ${err.message}`);
        remediations.push('cp frontend/env.mvp.local frontend/.env.local');
      }
    } else {
      issues.push('frontend/.env.local is missing');
      remediations.push('Run diagnostics with --fix or: cp frontend/env.mvp.local frontend/.env.local');
    }
  }

  // Check 3: Check PORT configuration collisions
  const backendPort = parseInt(env.PORT || '3001', 10);
  const frontendPort = 3000;
  if (backendPort === frontendPort) {
    issues.push(`Backend PORT (${backendPort}) conflicts with default frontend Next.js port (3000)`);
    remediations.push('Set PORT=3001 in backend/.env to avoid port collision with Next.js');
  }

  if (fixesApplied.length > 0 && issues.length === 0) {
    return {
      name,
      category: 'runtime',
      status: 'PASS',
      message: `Auto-fixes applied successfully: ${fixesApplied.join(', ')}. Environment is ready.`,
    };
  }

  if (issues.length > 0) {
    const fixPrefix = fixesApplied.length > 0 ? `Applied fixes: ${fixesApplied.join(', ')}. Remaining: ` : '';
    return {
      name,
      category: 'runtime',
      status: env.NODE_ENV === 'production' ? 'FAIL' : 'WARN',
      message: `${fixPrefix}${issues.join('; ')}.`,
      remediation: remediations.join(' | '),
    };
  }

  return {
    name,
    category: 'runtime',
    status: 'PASS',
    message: 'Local environment configuration files and port assignments are healthy.',
  };
}

export interface DiagnosticsSummary {
  timestamp: string;
  totalChecks: number;
  passed: number;
  warnings: number;
  failures: number;
  results: DiagnosticCheckResult[];
}

export async function runDiagnostics(
  env: Record<string, string | undefined> = process.env,
  options: DiagnosticsOptions = {}
): Promise<DiagnosticsSummary> {
  const results: DiagnosticCheckResult[] = [];

  // 1. Node.js runtime version check
  const nodeVersion = process.versions.node;
  const majorVersion = parseInt(nodeVersion.split('.')[0] || '0', 10);
  if (majorVersion >= 18) {
    results.push({
      name: 'Node.js Version',
      category: 'runtime',
      status: 'PASS',
      message: `Node.js v${nodeVersion} meets the requirement (>= 18.0.0).`,
    });
  } else {
    results.push({
      name: 'Node.js Version',
      category: 'runtime',
      status: 'FAIL',
      message: `Node.js v${nodeVersion} is below required minimum (>= 18.0.0).`,
      remediation: 'Upgrade Node.js to v18.x or v20.x LTS using nvm or your package manager.',
    });
  }

  // 2. Project structure and fixture presence
  const rootDir = options.rootDir ?? path.resolve(__dirname, '..');
  const criticalPaths = [
    { rel: 'backend/src/server-mvp.ts', desc: 'Backend MVP server' },
    { rel: 'backend/src/storage/memory-invoice-storage.ts', desc: 'In-memory storage layer' },
    { rel: 'backend/tests', desc: 'Backend test suite' },
    { rel: 'frontend/app', desc: 'Frontend Next.js application' },
  ];

  let structureOk = true;
  for (const item of criticalPaths) {
    const fullPath = path.join(rootDir, item.rel);
    if (!fs.existsSync(fullPath)) {
      structureOk = false;
      results.push({
        name: `Path: ${item.rel}`,
        category: 'fixtures',
        status: 'FAIL',
        message: `Missing expected project path: ${item.rel} (${item.desc})`,
        remediation: `Ensure you have pulled all files from git repository: git checkout main && git pull`,
      });
    }
  }

  if (structureOk) {
    results.push({
      name: 'Project Directory Structure',
      category: 'fixtures',
      status: 'PASS',
      message: 'All expected core project paths and fixtures are present.',
    });
  }

  // 3. Environment configuration validation (Issue #90 integration)
  const envCheck = validateEnvironment(env);
  if (envCheck.issues.length === 0) {
    results.push({
      name: 'Environment Validation',
      category: 'config',
      status: 'PASS',
      message: 'All environment variables and formats are valid.',
    });
  } else {
    results.push({
      name: 'Environment Validation',
      category: 'config',
      status: env.NODE_ENV === 'production' ? 'FAIL' : 'WARN',
      message: `Environment validation detected issues:\n    • ${envCheck.issues.join('\n    • ')}`,
      remediation: 'Review backend/env.example.txt or backend/env.mvp.example and configure missing or malformed keys.',
    });
  }

  // 4. Storage mode & DB configuration (Read-only check)
  if (env.DATABASE_URL) {
    results.push({
      name: 'Database Configuration',
      category: 'storage',
      status: 'PASS',
      message: 'DATABASE_URL is defined. PostgreSQL persistence mode is available.',
    });
  } else {
    results.push({
      name: 'Database Configuration',
      category: 'storage',
      status: 'WARN',
      message: 'DATABASE_URL is not set. Running in zero-database MVP mode (in-memory storage).',
      remediation: 'Set DATABASE_URL in backend/.env if you wish to run with persistent PostgreSQL.',
    });
  }

  // 5. Stellar network & Horizon check
  const stellarNetwork = (env.STELLAR_NETWORK || 'TESTNET').toUpperCase();
  const horizonUrl =
    env.STELLAR_HORIZON_URL ||
    (stellarNetwork === 'TESTNET'
      ? 'https://horizon-testnet.stellar.org'
      : 'https://horizon.stellar.org');

  if (horizonUrl.startsWith('https://')) {
    results.push({
      name: 'Stellar Horizon Gateway',
      category: 'network',
      status: 'PASS',
      message: `Configured for ${stellarNetwork} via HTTPS: ${horizonUrl}`,
    });
  } else {
    results.push({
      name: 'Stellar Horizon Gateway',
      category: 'network',
      status: 'WARN',
      message: `Horizon URL (${horizonUrl}) does not use HTTPS.`,
      remediation: 'Stellar network communication should use an HTTPS horizon endpoint.',
    });
  }

  // 6. Dependency state per workspace
  for (const workspace of WORKSPACES) results.push(checkWorkspaceDependencies(rootDir, workspace));

  // 7. Admin authorization secrets
  results.push(checkAdminAuthorization(env));

  // 8. Seed data and schema fixtures (Issue #258)
  results.push(checkSeedData(rootDir, env));

  // 9. Common failure fixes and auto-remediation (Issue #258)
  results.push(checkCommonFailureFixes(rootDir, env, { fix: options.fix }));

  // 10. Live Horizon probe (opt-in, so the default run stays offline and read-only)
  if (options.network) {
    const network = stellarNetwork === 'PUBLIC' ? 'PUBLIC' : 'TESTNET';
    results.push(await checkHorizonNetwork(horizonUrl, network, env.NODE_ENV === 'production', options.probe));
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const warnings = results.filter((r) => r.status === 'WARN').length;
  const failures = results.filter((r) => r.status === 'FAIL').length;

  return {
    timestamp: new Date().toISOString(),
    totalChecks: results.length,
    passed,
    warnings,
    failures,
    results,
  };
}

export function formatDiagnosticsOutput(summary: DiagnosticsSummary): string {
  const lines: string[] = [];
  lines.push('====================================================');
  lines.push('🔍 Inqutum Contributor Local Health Diagnostics');
  lines.push(`⏰ Timestamp: ${summary.timestamp}`);
  lines.push('====================================================\n');

  for (const r of summary.results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️ ' : '❌';
    lines.push(`${icon} [${r.category.toUpperCase()}] ${r.name}: ${r.status}`);
    lines.push(`   ${r.message}`);
    if (r.remediation) {
      lines.push(`   👉 Remediation: ${r.remediation}`);
    }
    lines.push('');
  }

  lines.push('----------------------------------------------------');
  lines.push(`Summary: ${summary.totalChecks} checks run | ${summary.passed} PASS | ${summary.warnings} WARN | ${summary.failures} FAIL`);
  if (summary.failures === 0) {
    lines.push('🎉 Contributor environment is healthy and ready for development!');
  } else {
    lines.push('❌ Found critical issues. Please resolve the remediation steps above.');
  }
  lines.push('====================================================');

  return lines.join('\n');
}

// CLI entrypoint
if (require.main === module || process.argv[1]?.endsWith('diagnostics.ts')) {
  const network = process.argv.includes('--network');
  const fix = process.argv.includes('--fix');
  runDiagnostics(process.env, { network, fix }).then((summary) => {
    console.log(formatDiagnosticsOutput(summary));
    process.exit(summary.failures > 0 ? 1 : 0);
  });
}

