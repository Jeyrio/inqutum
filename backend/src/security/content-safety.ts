/**
 * Untrusted-content hardening (issue #54).
 *
 * Policy, applied consistently:
 *  - Plain-text fields (descriptions, names) are STRIPPED of HTML tags, control
 *    characters and bidirectional-override characters at the API boundary. They
 *    are still escaped again wherever they are rendered (defence in depth).
 *  - External URLs are REJECTED unless they are plain http(s) without embedded
 *    credentials. `javascript:`, `data:`, `vbscript:`, `file:` and
 *    `user:pass@host` (misleading-link) forms never pass.
 *  - API responses carry restrictive security headers.
 */

import type { NextFunction, Request, Response } from 'express';

// C0/C1 controls (keeping \t \n \r for multiline), zero-width chars and BOM.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‍⁠﻿]/g;
// Bidi embeddings/overrides/isolates can visually reorder text to mislead.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
// A tag start is `<` immediately followed by a letter, `/`, `!` or `?`.
// Bare comparisons such as "a < b" are left alone.
const HTML_TAG = /<[a-zA-Z\/!?][^>]*>?/g;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

export interface SanitizeOptions {
  /** Keep line breaks (descriptions). Otherwise all whitespace runs collapse to one space. */
  multiline?: boolean;
}

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
  '`': '&#096;',
  '/': '&#x2F;',
};

/**
 * Escapes characters with special meaning in HTML body context.
 * Time Complexity: O(N) linear single-pass replacement.
 * Space Complexity: O(N) memory buffer for escaped string.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`/]/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Escapes characters for safe inclusion within quoted HTML attributes.
 * Enforces strict attribute safety: neutralizes quotes, ampersands, and control characters.
 * Time Complexity: O(N) linear single-pass.
 */
export function escapeHtmlAttribute(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(CONTROL_CHARS, '')
    .replace(/[&<>"'`/]/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Sanitizes email header values (such as Subject lines or recipient names)
 * to prevent CRLF injection and SMTP header splitting / confused deputy attacks.
 * Time Complexity: O(N).
 */
export function sanitizeEmailHeader(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\r\n\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HAS_TEMPLATE_DELIMITERS = /\{\{|\}\}|\$\{|\<%|\%\}|#\{/;
const HAS_HTML_TAG = /<[a-zA-Z\/!?][^>]*>?/;
const HAS_HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/;
const HAS_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‍⁠﻿]/;
const HAS_BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/;

/**
 * Validates that client/seller names adhere to safe length (1-100) and character set,
 * free of template injection tokens, control characters, or HTML tags.
 */
export function validateClientName(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return false;
  if (HAS_TEMPLATE_DELIMITERS.test(trimmed)) return false;
  if (HAS_HTML_TAG.test(trimmed) || HAS_HTML_COMMENT.test(trimmed)) return false;
  if (HAS_CONTROL_CHARS.test(trimmed) || HAS_BIDI_CONTROLS.test(trimmed)) return false;
  return true;
}

/**
 * Validates that notes/description fields adhere to safe length (1-1000) and safe character set,
 * free of template injection delimiters or active markup.
 */
export function validateNotesOrDescription(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.length > 1000) return false;
  if (HAS_TEMPLATE_DELIMITERS.test(trimmed)) return false;
  if (HAS_HTML_TAG.test(trimmed) || HAS_HTML_COMMENT.test(trimmed)) return false;
  return true;
}

/** Removes markup, control and bidi characters. Returns '' for non-strings. */
export function sanitizePlainText(input: unknown, options: SanitizeOptions = {}): string {
  if (typeof input !== 'string') return '';

  let text = input.normalize('NFC').replace(CONTROL_CHARS, '').replace(BIDI_CONTROLS, '');

  // Repeat until stable so nested payloads like "<<b>script>" cannot re-form a tag.
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(HTML_COMMENT, '').replace(HTML_TAG, '');
  }

  text = options.multiline
    ? text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ');
  return text.trim();
}

export interface SafeUrlOptions {
  /** Permit plain http (local development). Defaults to https only. */
  allowHttp?: boolean;
}

/**
 * Returns the normalised URL if it is a safe external link, otherwise null.
 * Rejects non-http(s) schemes, embedded credentials, control characters and
 * empty hosts.
 */
export function safeHttpUrl(value: unknown, options: SafeUrlOptions = {}): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\u0000-\u001F\u007F\s\\]/.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const allowed = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.toString();
}

/**
 * Payment links are built from FRONTEND_URL. Only its validated origin is used,
 * so a malformed or hostile value can never inject a scheme, credentials or path.
 */
export function safeFrontendOrigin(value: unknown, fallback = 'http://localhost:3000'): string {
  const safe = safeHttpUrl(value, { allowHttp: true });
  return safe ? new URL(safe).origin : fallback;
}

/** Restrictive headers for a JSON API that never serves HTML. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-site',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) res.setHeader(name, value);
    res.removeHeader('X-Powered-By');
    next();
  };
}

/**
 * Validates outbound webhook destination URLs to prevent SSRF and unencrypted transmission.
 * Blocks private IP ranges (RFC 1918), link-local/cloud metadata (169.254.169.254),
 * loopback addresses, embedded credentials, and non-HTTPS schemes (unless allowHttp is explicit).
 */
export function validateWebhookDestinationUrl(
  input: unknown,
  options: { allowHttp?: boolean; allowPrivateIp?: boolean } = {}
): boolean {
  if (typeof input !== 'string') return false;
  const raw = input.trim();
  if (!raw || /[\u0000-\u001F\u007F\s\\]/.test(raw)) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // Scheme enforcement
  if (options.allowHttp) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  } else {
    if (url.protocol !== 'https:') return false;
  }

  // No credentials
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return false;

  if (!options.allowPrivateIp) {
    // Loopback & local
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }

    // Cloud metadata services
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === 'instance-data') {
      return false;
    }

    // IPv4 private ranges (RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (ipv4Match) {
      const a = parseInt(ipv4Match[1], 10);
      const b = parseInt(ipv4Match[2], 10);
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 127) return false;
      if (a === 0) return false;
      if (a === 169 && b === 254) return false;
    }
  }

  return true;
}

/**
 * Standard allowlisted public fields for webhook payloads.
 * Prevents accidental leakage of private keys, database internals, and sensitive tokens.
 */
export const DEFAULT_WEBHOOK_ALLOWLIST = [
  'id',
  'type',
  'invoiceId',
  'memo',
  'status',
  'amount',
  'assetCode',
  'assetIssuer',
  'sellerPublicKey',
  'createdAt',
  'paidAt',
  'paymentTxHash',
] as const;

/**
 * Strips private and internal fields from webhook payloads, ensuring only allowlisted
 * schema properties are emitted.
 */
export function sanitizeWebhookPayload<T extends Record<string, any>>(
  payload: T,
  allowlist: readonly string[] = DEFAULT_WEBHOOK_ALLOWLIST
): Partial<T> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const sanitized: Record<string, any> = {};
  const allowSet = new Set(allowlist);

  for (const key of Object.keys(payload)) {
    // Drop prototype pollution / non-own keys
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;

    // Filter against allowlist
    if (allowSet.has(key)) {
      sanitized[key] = payload[key];
    }
  }

  return sanitized as Partial<T>;
}

