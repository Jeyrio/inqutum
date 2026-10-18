/**
 * Helpers for rendering untrusted content and external links safely
 * (issue #54). Kept as plain CommonJS so node's test runner can load it, like
 * the other lib/*.js modules.
 *
 * React escapes text automatically; these helpers cover the places that build
 * HTML strings, CSV files, mailto: links and external URLs by hand.
 */

const HTML_ESCAPE_CHARACTERS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
  '`': '&#096;',
};

/** Escapes text for use in HTML element content or a quoted attribute. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, (character) => HTML_ESCAPE_CHARACTERS[character]);
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One CSV cell: always quoted, embedded quotes doubled, and spreadsheet
 * formula prefixes (= + - @ tab CR) neutralised with a leading apostrophe.
 * Numbers are written as-is.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return `"${value}"`;
  let text = String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Returns the URL if it is plain https, otherwise null. No credentials, no javascript:/data: schemes. */
function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\u0000-\u001F\u007F\s\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const STELLAR_TX_HASH = /^[0-9a-fA-F]{64}$/;
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

function explorerBase(network) {
  return `https://stellar.expert/explorer/${network === 'TESTNET' ? 'testnet' : 'public'}`;
}

/** Explorer link for a transaction; falls back to the explorer home for a malformed hash. */
function explorerTransactionUrl(network, txHash) {
  const base = explorerBase(network);
  return STELLAR_TX_HASH.test(String(txHash ?? '')) ? `${base}/tx/${txHash.toLowerCase()}` : base;
}

/** Explorer link for an account; falls back to the explorer home for a malformed key. */
function explorerAccountUrl(network, publicKey) {
  const base = explorerBase(network);
  return STELLAR_PUBLIC_KEY.test(String(publicKey ?? '')) ? `${base}/account/${publicKey}` : base;
}

// Deliberately conservative: no quotes, whitespace, `?`, `&`, `%`, commas or markup.
const MAILTO_ADDRESS = /^[A-Za-z0-9._+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;

/**
 * mailto: link with an encoded subject/body. Returns null unless the address
 * is a plain single address, so `a@b.io?bcc=x@y.io` or `a@b.io,c@d.io` cannot
 * add recipients or headers.
 */
function buildMailtoUrl(address, subject, body) {
  if (typeof address !== 'string' || !MAILTO_ADDRESS.test(address.trim())) return null;
  return `mailto:${address.trim()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Policy for the generated print/receipt document. It runs no script and loads
 * nothing external, so even a missed escape cannot execute code.
 */
const PRINT_DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** Feature string for window.open on untrusted/external destinations. */
const EXTERNAL_WINDOW_FEATURES = 'noopener,noreferrer';

module.exports = {
  EXTERNAL_WINDOW_FEATURES,
  PRINT_DOCUMENT_CSP,
  buildMailtoUrl,
  csvCell,
  escapeHtml,
  explorerAccountUrl,
  explorerTransactionUrl,
  safeExternalUrl,
};
