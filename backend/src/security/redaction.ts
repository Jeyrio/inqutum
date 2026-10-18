/**
 * Unified Redaction and Sensitive Value Sanitization Engine.
 *
 * Provides cryptographic secret scrubbing, credential masking, URL password
 * neutralization, and object sanitization for logs, exports, and error responses.
 *
 * Enforces zero leakage of:
 *  - Stellar secret seeds (S...)
 *  - Bearer / authorization tokens
 *  - PEM private key blocks
 *  - Database connection strings with embedded passwords (postgres://user:pass@host)
 *  - Key-value credentials (password=..., api_key: ..., etc.)
 *
 * Preserves public identifiers:
 *  - Stellar public keys (G...)
 *  - 64-character transaction hashes
 *  - Invoice UUIDs and public memos
 *  - Correlation IDs and error taxonomy codes
 */

export const SECRET_KEY_PATTERN = /\bS[A-Z0-9]{55}\b/g;
export const BEARER_TOKEN_PATTERN = /Bearer\s+([A-Za-z0-9\-._~+/]+=*)/gi;
export const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]+-----END [A-Z ]*PRIVATE KEY-----/g;
export const URL_CREDENTIAL_PATTERN = /(:\/\/[^:/\s]+:)[^@\s]+(@)/g;
export const KEY_VALUE_SECRET_PATTERN = /((?:password|secret|apiKey|api_secret|auth_token|access_token|private_key|privatekey)\s*[=:]\s*)(?!\[REDACTED|S\[REDACTED)[^\s,;&"']+/gi;
export const PASSWORD_FIELD_PATTERN = /"?(password|secret|apiKey|api_secret|auth_token|access_token|private_key|privatekey)"?\s*:\s*"[^"]+"/gi;

export const SENSITIVE_KEY_SUBSTRINGS = [
  'secret',
  'password',
  'authorization',
  'privatekey',
  'private_key',
  'token',
  'credential',
  'apikey',
  'api_key',
] as const;

/**
 * Sanitizes a string by replacing all sensitive patterns with standard placeholders.
 */
export function redactSensitiveText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]$2')
    .replace(SECRET_KEY_PATTERN, 'S[REDACTED_SECRET_KEY]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED_TOKEN]')
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(PASSWORD_FIELD_PATTERN, '"$1":"[REDACTED]"')
    .replace(KEY_VALUE_SECRET_PATTERN, '$1[REDACTED]');
}

/**
 * Recursively sanitizes any value (object, array, primitive, string) for logging,
 * exports, or error responses.
 */
export function sanitizeObject<T = any>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return redactSensitiveText(data) as unknown as T;
  }

  if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') {
    return data;
  }

  if (data instanceof Date) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeObject(item)) as unknown as T;
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      const isSensitiveKey = SENSITIVE_KEY_SUBSTRINGS.some((sub) => lowerKey.includes(sub));
      if (isSensitiveKey) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeObject(value);
      }
    }
    return sanitized as T;
  }

  return data;
}

/**
 * Redacts an error message string and ensures stack traces and credentials never leak.
 */
export function redactErrorMessage(message: unknown): string {
  if (typeof message !== 'string') {
    return '';
  }
  // Strip out any trailing stack trace lines if accidentally embedded in the message
  const firstLine = message.split('\n')[0] ?? '';
  return redactSensitiveText(firstLine);
}
