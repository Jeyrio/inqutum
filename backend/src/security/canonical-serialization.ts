/**
 * Canonical JSON Serialization Layer (Issue #247).
 *
 * Implements strict deterministic serialization compliant with RFC 8785
 * (JSON Canonicalization Scheme - JCS) for cryptographic signing, hashing,
 * tamper-evident audit chains, and replay-protected payloads.
 *
 * Design Guarantees:
 * 1. Stable Field Ordering: Object keys sorted lexicographically by UTF-16 code units.
 * 2. Unicode Normalization: All strings normalized to Unicode NFC (Canonical Composition).
 * 3. Number Normalization:
 *    - Negative zero (-0) normalized to 0.
 *    - Canonical integer and float representations (no trailing .0 or arbitrary exponents).
 *    - Non-finite numbers (NaN, Infinity, -Infinity) throw CanonicalSerializationError.
 * 4. Whitespace: Zero whitespace between tokens (no spaces after ':' or ',').
 * 5. String Escaping: Only required escapes according to RFC 8785 (escapes \", \\, and control chars \u0000-\u001f).
 * 6. Circular Reference Protection: Throws CanonicalSerializationError on circular structures.
 * 7. Type Safety: Dates formatted as ISO-8601 strings, Buffers formatted as hex.
 */

import { createHash, createHmac } from 'crypto';

export class CanonicalSerializationError extends Error {
  constructor(public readonly code: 'CIRCULAR_REFERENCE' | 'INVALID_NUMBER' | 'UNSUPPORTED_TYPE', message: string) {
    super(message);
    this.name = 'CanonicalSerializationError';
  }
}

/**
 * Serialize any JavaScript value into a canonical RFC 8785 JSON string.
 *
 * Time Complexity: O(N log K) where N is the total node count and K is the average keys per object.
 * Space Complexity: O(N) buffer allocation for the serialized string.
 */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();

  function serialize(val: unknown): string {
    if (val === null) {
      return 'null';
    }

    if (val === undefined) {
      // In JSON, undefined values are omitted from objects or serialized as null in arrays
      return 'null';
    }

    const type = typeof val;

    if (type === 'boolean') {
      return val ? 'true' : 'false';
    }

    if (type === 'number') {
      const num = val as number;
      if (!Number.isFinite(num)) {
        throw new CanonicalSerializationError(
          'INVALID_NUMBER',
          `Cannot canonicalize non-finite number: ${num}`
        );
      }
      // Normalize -0 to 0
      if (Object.is(num, -0)) {
        return '0';
      }
      return String(num);
    }

    if (type === 'bigint') {
      return `"${(val as bigint).toString()}"`;
    }

    if (type === 'string') {
      // Normalize to Unicode Normalization Form C (NFC)
      const normalized = (val as string).normalize('NFC');
      return escapeString(normalized);
    }

    if (type === 'symbol') {
      throw new CanonicalSerializationError(
        'UNSUPPORTED_TYPE',
        'Cannot canonicalize symbol values'
      );
    }

    if (type === 'function') {
      throw new CanonicalSerializationError(
        'UNSUPPORTED_TYPE',
        'Cannot canonicalize function values'
      );
    }

    if (type === 'object') {
      const obj = val as object;

      if (seen.has(obj)) {
        throw new CanonicalSerializationError(
          'CIRCULAR_REFERENCE',
          'Circular reference detected during canonical serialization'
        );
      }

      // Handle Date instances
      if (obj instanceof Date) {
        return `"${obj.toISOString()}"`;
      }

      // Handle Buffer / Uint8Array instances
      if (Buffer.isBuffer(obj)) {
        return `"${obj.toString('hex')}"`;
      }

      // Handle Arrays
      if (Array.isArray(obj)) {
        seen.add(obj);
        try {
          const items = obj.map((item) => {
            // In JSON arrays, undefined/functions/symbols serialize as null
            if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
              return 'null';
            }
            return serialize(item);
          });
          return `[${items.join(',')}]`;
        } finally {
          seen.delete(obj);
        }
      }

      // Handle generic Objects
      seen.add(obj);
      try {
        const record = obj as Record<string, unknown>;
        // Filter out undefined and symbol properties
        const keys = Object.keys(record)
          .filter((k) => record[k] !== undefined && typeof record[k] !== 'function' && typeof record[k] !== 'symbol')
          // Sort keys lexicographically by UTF-16 code units as required by RFC 8785
          .sort((a, b) => {
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
          });

        const members = keys.map((key) => {
          const normKey = key.normalize('NFC');
          const serializedKey = escapeString(normKey);
          const serializedVal = serialize(record[key]);
          return `${serializedKey}:${serializedVal}`;
        });

        return `{${members.join(',')}}`;
      } finally {
        seen.delete(obj);
      }
    }

    return 'null';
  }

  return serialize(value);
}

/**
 * Escape strings in compliance with RFC 8785 section 3.2.2.2.
 * Escapes quotes (\"), backslashes (\\), and control characters (\u0000-\u001f).
 */
function escapeString(str: string): string {
  let result = '"';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const code = str.charCodeAt(i);

    switch (char) {
      case '"':
        result += '\\"';
        break;
      case '\\':
        result += '\\\\';
        break;
      case '\b':
        result += '\\b';
        break;
      case '\f':
        result += '\\f';
        break;
      case '\n':
        result += '\\n';
        break;
      case '\r':
        result += '\\r';
        break;
      case '\t':
        result += '\\t';
        break;
      default:
        if (code < 0x20) {
          result += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          result += char;
        }
        break;
    }
  }
  result += '"';
  return result;
}

/**
 * Compute the cryptographic hash of a canonicalized value.
 */
export function canonicalHash(value: unknown, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  const canonical = canonicalize(value);
  return createHash(algorithm).update(canonical, 'utf8').digest('hex');
}

/**
 * Compute the HMAC digest of a canonicalized value.
 */
export function canonicalHmac(
  value: unknown,
  secret: string | Buffer,
  algorithm: 'sha256' | 'sha512' = 'sha256'
): string {
  const canonical = canonicalize(value);
  return createHmac(algorithm, secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Create a canonical signing envelope combining prefix, timestamp, and canonical payload.
 */
export function canonicalSigningPayload(
  prefix: string,
  payload: unknown,
  timestamp?: string | number
): string {
  const canonicalBody = canonicalize(payload);
  const ts = timestamp !== undefined ? String(timestamp) : '';
  return ts ? `${prefix}.${ts}.${canonicalBody}` : `${prefix}.${canonicalBody}`;
}
