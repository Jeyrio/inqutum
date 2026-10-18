import type { CorsOptions } from 'cors';

type RuntimeEnvironment = Record<string, string | undefined>;

export interface ReadinessCheck {
  ready: boolean;
  checks: {
    frontendOrigins: boolean;
    simulationDisabled: boolean;
    stellarNetwork: boolean;
    horizonUrl: boolean;
  };
  reasons: string[];
}

function normalizeOrigin(value: string): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredFrontendOrigins(
  env: RuntimeEnvironment = process.env || {}
): string[] {
  const safeEnv = env || {};
  const candidates = [safeEnv.FRONTEND_URL, ...(safeEnv.FRONTEND_URLS || '').split(',')]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));

  const origins = candidates
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value));

  if (origins.length === 0 && safeEnv.NODE_ENV !== 'production') {
    origins.push('http://localhost:3000');
  }

  return [...new Set(origins)];
}

export function simulationAllowed(env: RuntimeEnvironment = process.env || {}): boolean {
  const safeEnv = env || {};
  return safeEnv.NODE_ENV !== 'production' && safeEnv.ALLOW_SIMULATE === 'true';
}

export function deploymentReadiness(
  env: RuntimeEnvironment = process.env || {}
): ReadinessCheck {
  const safeEnv = env || {};
  const network = (safeEnv.STELLAR_NETWORK || 'TESTNET').toUpperCase();
  const horizonUrl = safeEnv.STELLAR_HORIZON_URL ||
    (network === 'TESTNET'
      ? 'https://horizon-testnet.stellar.org'
      : 'https://horizon.stellar.org');
  const checks = {
    frontendOrigins: configuredFrontendOrigins(safeEnv).length > 0,
    simulationDisabled: safeEnv.ALLOW_SIMULATE !== 'true',
    stellarNetwork: network === 'TESTNET' || network === 'PUBLIC',
    horizonUrl: /^https:\/\//i.test(horizonUrl),
  };
  const reasons: string[] = [];

  if (!checks.frontendOrigins) reasons.push('FRONTEND_URL or FRONTEND_URLS is required');
  if (!checks.simulationDisabled) reasons.push('ALLOW_SIMULATE must be false in deploy environments');
  if (!checks.stellarNetwork) reasons.push('STELLAR_NETWORK must be TESTNET or PUBLIC');
  if (!checks.horizonUrl) reasons.push('STELLAR_HORIZON_URL must use HTTPS');

  return { ready: Object.values(checks).every(Boolean), checks, reasons };
}

export function corsOptions(env: RuntimeEnvironment = process.env || {}): CorsOptions {
  const safeEnv = env || {};
  return {
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    // Idempotency-Key lets a browser retry POST /invoices/:id/send-email safely (#289).
    allowedHeaders: ['Content-Type', 'Accept', 'X-Correlation-ID', 'X-Request-ID', 'Idempotency-Key'],
    exposedHeaders: ['X-Correlation-ID', 'X-Request-ID'],
    maxAge: 86400,
    origin(origin, callback) {
      // Health checks, curl and server-to-server calls do not carry Origin.
      if (!origin) return callback(null, true);

      const normalized = normalizeOrigin(origin);
      if (normalized && configuredFrontendOrigins(safeEnv).includes(normalized)) {
        return callback(null, true);
      }

      const error = Object.assign(new Error('Origin is not allowed by Quittance CORS policy'), {
        code: 'CORS_ORIGIN_DENIED',
      });
      return callback(error);
    },
  };
}

export function cutoverDrainMode(env: RuntimeEnvironment = process.env): boolean {
  return env.CUTOVER_DRAIN_MODE === 'true' || env.DRAIN_MODE === 'true';
}

export function configuredStorageMode(
  env: RuntimeEnvironment = process.env
): 'memory' | 'postgres' {
  if (env.INVOICE_STORAGE === 'memory' || env.INVOICE_STORAGE === 'postgres') {
    return env.INVOICE_STORAGE;
  }
  return env.DATABASE_URL ? 'postgres' : 'memory';
}
