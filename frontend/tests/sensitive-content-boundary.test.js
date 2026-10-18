const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  csvCell,
  safeExternalUrl,
  buildMailtoUrl,
  PRINT_DOCUMENT_CSP,
  EXTERNAL_WINDOW_FEATURES,
} = require('../lib/safe-content');

test('Sensitive Content Boundary: rendering XSS vectors and nested payloads', () => {
  const xssPayloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '"><script>alert(1)</script>',
    "'><script>alert(1)</script>",
    '<iframe src="javascript:alert(1)">',
  ];

  for (const payload of xssPayloads) {
    const escaped = escapeHtml(payload);
    assert.doesNotMatch(escaped, /<[a-zA-Z\/]/, `Must not contain unescaped tag starts: ${escaped}`);
    assert.doesNotMatch(escaped, /<script/i);
    assert.ok(escaped.includes('&lt;') || escaped.includes('&gt;') || escaped.includes('&quot;') || escaped.includes('&#039;'));
  }
});

test('Sensitive Content Boundary: spreadsheet formula injection neutralised on downloads', () => {
  const dangerousCells = [
    '=1+1',
    '=cmd|\' /C calc\'!A0',
    '+100',
    '-50',
    '@SUM(A1)',
    '\tcmd',
    '\rcmd',
  ];

  for (const dangerous of dangerousCells) {
    const safe = csvCell(dangerous);
    assert.ok(
      safe.startsWith(`"'`),
      `Formula cell must be escaped with leading apostrophe: ${dangerous} -> ${safe}`
    );
  }
});

test('Sensitive Content Boundary: safeExternalUrl blocks javascript, data, file, and credential schemes', () => {
  const blockedSchemes = [
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'http://insecure-domain.com',
    'https://user:password@malicious-target.com',
  ];

  for (const url of blockedSchemes) {
    assert.equal(safeExternalUrl(url), null, `Must reject unsafe URL: ${url}`);
  }
});

test('Sensitive Content Boundary: safeExternalUrl permits legitimate HTTPS links', () => {
  assert.equal(safeExternalUrl('https://stellar.org'), 'https://stellar.org/');
  assert.equal(safeExternalUrl('https://stellar.expert/explorer/public'), 'https://stellar.expert/explorer/public');
});

test('Sensitive Content Boundary: print and receipt documents enforce strict scriptless CSP', () => {
  assert.match(PRINT_DOCUMENT_CSP, /default-src 'none'/);
  assert.match(PRINT_DOCUMENT_CSP, /base-uri 'none'/);
  assert.match(PRINT_DOCUMENT_CSP, /form-action 'none'/);
  assert.doesNotMatch(PRINT_DOCUMENT_CSP, /script-src/);
});

test('Sensitive Content Boundary: external links enforce noopener and noreferrer', () => {
  assert.equal(EXTERNAL_WINDOW_FEATURES, 'noopener,noreferrer');
});

test('Sensitive Content Boundary: mailto URLs block header injection and multiple recipients', () => {
  const attacks = [
    'victim@test.com?bcc=evil@test.com',
    'victim@test.com,attacker@test.com',
    'victim@test.com;attacker@test.com',
    'victim%0Abcc:attacker@test.com',
  ];

  for (const attack of attacks) {
    assert.equal(buildMailtoUrl(attack, 'Subject', 'Body'), null, `Must reject injected mailto: ${attack}`);
  }
});
