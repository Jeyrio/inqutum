import { z } from 'zod';

export interface EnvValidationOptions {
  strict?: boolean;
  isProduction?: boolean;
}

export interface SanitizedEnvSummary {
  NODE_ENV: string;
  PORT: number;
  STELLAR_NETWORK: string;
  STELLAR_HORIZON_URL: string;
  FRONTEND_ORIGINS: string[];
  SIMULATION_ENABLED: boolean;
  DATABASE_CONFIGURED: boolean;
  REDIS_CONFIGURED: boolean;
  OPS_HEALTH_TOKEN_CONFIGURED: boolean;
  REDACTED_SECRETS: Record<string, string>;
}

export function maskSecret(secret?: string | null): string {
  if (!secret) return '[NOT CONFIGURED]';
  const trimmed = secret.trim();
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

const SENSITIVE_KEY_PATTERNS = [
  /SECRET/i,
  /KEY/i,
  /TOKEN/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /AUTH/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .union([z.string(), z.number()])
    .default(3001)
    .refine(
      (val) => {
        const parsed = typeof val === 'string' ? parseInt(val, 10) : val;
        return !isNaN(parsed) && parsed >= 1 && parsed <= 65535;
      },
      { message: 'PORT must be an integer between 1 and 65535' }
    )
    .transform((val) => (typeof val === 'string' ? parseInt(val, 10) : val)),
  FRONTEND_URL: z.string().optional(),
  FRONTEND_URLS: z.string().optional(),
  STELLAR_NETWORK: z.enum(['TESTNET', 'PUBLIC']).default('TESTNET'),
  STELLAR_HORIZON_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  ALLOW_SIMULATE: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((val) => val === true || val === 'true'),
  OPS_HEALTH_TOKEN: z.string().optional(),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

export class EnvironmentConfigError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Environment configuration validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvironmentConfigError';
    this.issues = issues;
  }
}

export function validateEnvironment(
  rawEnv: Record<string, string | undefined> = process.env,
  options: EnvValidationOptions = {}
): { validated: ValidatedEnv; issues: string[]; sanitized: SanitizedEnvSummary } {
  const issues: string[] = [];
  const isProd = options.isProduction ?? rawEnv.NODE_ENV === 'production';

  const parseResult = envSchema.safeParse(rawEnv);
  let validated: ValidatedEnv;

  if (!parseResult.success) {
    for (const err of parseResult.error.errors) {
      issues.push(`${err.path.join('.') || 'field'}: ${err.message}`);
    }
    // Fallback shape to construct summary
    validated = {
      NODE_ENV: isProd ? 'production' : (rawEnv.NODE_ENV as any) || 'development',
      PORT: 3001,
      STELLAR_NETWORK: (rawEnv.STELLAR_NETWORK as any) === 'PUBLIC' ? 'PUBLIC' : 'TESTNET',
      ALLOW_SIMULATE: rawEnv.ALLOW_SIMULATE === 'true',
    };
  } else {
    validated = parseResult.data;
  }

  // Production invariants
  if (isProd) {
    if (validated.ALLOW_SIMULATE) {
      issues.push('ALLOW_SIMULATE must be false in production environments');
    }

    if (!rawEnv.FRONTEND_URL && !rawEnv.FRONTEND_URLS) {
      issues.push('Either FRONTEND_URL or FRONTEND_URLS must be defined in production');
    }

    if (validated.STELLAR_NETWORK === 'PUBLIC') {
      if (
        validated.STELLAR_HORIZON_URL &&
        validated.STELLAR_HORIZON_URL.includes('testnet')
      ) {
        issues.push(
          'STELLAR_HORIZON_URL points to testnet while STELLAR_NETWORK is set to PUBLIC'
        );
      }
    }

    if (rawEnv.DATABASE_URL && rawEnv.DATABASE_URL.includes('localhost')) {
      issues.push('DATABASE_URL in production should not point to localhost');
    }

    if (rawEnv.OPS_HEALTH_TOKEN && rawEnv.OPS_HEALTH_TOKEN.trim().length < 16) {
      issues.push('OPS_HEALTH_TOKEN must be at least 16 characters in production for safety');
    }
  }

  // Redacted secrets inventory
  const redactedSecrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawEnv)) {
    if (val && isSensitiveKey(key)) {
      redactedSecrets[key] = maskSecret(val);
    }
  }

  const origins: string[] = [];
  if (rawEnv.FRONTEND_URL) origins.push(rawEnv.FRONTEND_URL);
  if (rawEnv.FRONTEND_URLS) {
    origins.push(...rawEnv.FRONTEND_URLS.split(',').map((s) => s.trim()).filter(Boolean));
  }

  const sanitized: SanitizedEnvSummary = {
    NODE_ENV: validated.NODE_ENV,
    PORT: validated.PORT,
    STELLAR_NETWORK: validated.STELLAR_NETWORK,
    STELLAR_HORIZON_URL:
      validated.STELLAR_HORIZON_URL ||
      (validated.STELLAR_NETWORK === 'PUBLIC'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org'),
    FRONTEND_ORIGINS: origins,
    SIMULATION_ENABLED: validated.ALLOW_SIMULATE,
    DATABASE_CONFIGURED: Boolean(rawEnv.DATABASE_URL),
    REDIS_CONFIGURED: Boolean(rawEnv.REDIS_URL),
    OPS_HEALTH_TOKEN_CONFIGURED: Boolean(rawEnv.OPS_HEALTH_TOKEN),
    REDACTED_SECRETS: redactedSecrets,
  };

  if (options.strict && issues.length > 0) {
    throw new EnvironmentConfigError(issues);
  }

  return { validated, issues, sanitized };
}
