const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXTERNAL_WINDOW_FEATURES,
  PRINT_DOCUMENT_CSP,
  buildMailtoUrl,
  csvCell,
  escapeHtml,
  explorerAccountUrl,
  explorerTransactionUrl,
  safeExternalUrl,
} = require('../lib/safe-content');

const HASH = 'ab'.repeat(32);
const KEY = 'G' + 'A'.repeat(55);

test('escapeHtml neutralises every HTML-significant character', () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml(`&'\``), '&amp;&#039;&#096;');
});

test('escapeHtml output cannot break out of a double- or single-quoted attribute', () => {
  const html = `<a title="${escapeHtml('" onmouseover="alert(1)')}" data-x='${escapeHtml("' onclick='x()")}'>`;
  // The payload stays inert text inside each value; only the two delimiting quotes of each attribute remain raw.
  assert.equal(
    html,
    `<a title="&quot; onmouseover=&quot;alert(1)" data-x='&#039; onclick=&#039;x()'>`
  );
  assert.equal((html.match(/"/g) || []).length, 2);
  assert.equal((html.match(/'/g) || []).length, 2);
});

test('escapeHtml coerces non-strings and nullish values instead of throwing', () => {
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml is not applied twice destructively for plain text', () => {
  assert.equal(escapeHtml('plain text 123'), 'plain text 123');
});

test('csvCell quotes cells and doubles embedded quotes', () => {
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('csvCell neutralises spreadsheet formula injection', () => {
  for (const payload of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) {
    assert.ok(csvCell(payload).startsWith(`"'`), payload);
  }
  assert.equal(csvCell('=1+1'), `"'=1+1"`);
});

test('csvCell leaves ordinary values, numbers and empties alone', () => {
  assert.equal(csvCell('Design work'), '"Design work"');
  assert.equal(csvCell(12.5), '"12.5"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(''), '""');
  assert.equal(csvCell('a-b'), '"a-b"');
});

test('safeExternalUrl accepts only plain https URLs', () => {
  assert.equal(safeExternalUrl('https://www.stellar.org'), 'https://www.stellar.org/');
  assert.equal(safeExternalUrl('  https://stellar.expert/x?y=1 '), 'https://stellar.expert/x?y=1');
});

test('safeExternalUrl rejects script schemes, plain http, credentials and malformed input', () => {
  for (const bad of [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x',
    'file:///etc/passwd', 'http://example.com', '//evil.example', 'https://user:pw@evil.example',
    'https://trusted.example@evil.example', 'https://ex ample.com', 'https://a.example/\nx', 'https://a.example\\@b',
    '', '   ', 'not a url', 'https://',
  ]) {
    assert.equal(safeExternalUrl(bad), null, JSON.stringify(bad));
  }
  for (const nonString of [undefined, null, 1, {}, ['https://a.example']]) {
    assert.equal(safeExternalUrl(nonString), null);
  }
});

test('explorerTransactionUrl builds a tx link only for a valid hash', () => {
  assert.equal(explorerTransactionUrl('TESTNET', HASH), `https://stellar.expert/explorer/testnet/tx/${HASH}`);
  assert.equal(explorerTransactionUrl('PUBLIC', HASH.toUpperCase()), `https://stellar.expert/explorer/public/tx/${HASH}`);
  assert.equal(explorerTransactionUrl(undefined, HASH), `https://stellar.expert/explorer/public/tx/${HASH}`);
});

test('explorerTransactionUrl never builds a link from hostile or malformed hashes', () => {
  for (const bad of ['../../evil', 'javascript:alert(1)', `${HASH}/../x`, `${HASH}?x=1`, 'abc', '', undefined, null, `${HASH}0`]) {
    assert.equal(explorerTransactionUrl('TESTNET', bad), 'https://stellar.expert/explorer/testnet', String(bad));
  }
});

test('explorerAccountUrl builds an account link only for a valid public key', () => {
  assert.equal(explorerAccountUrl('TESTNET', KEY), `https://stellar.expert/explorer/testnet/account/${KEY}`);
  assert.equal(explorerAccountUrl('', KEY), `https://stellar.expert/explorer/public/account/${KEY}`);
  for (const bad of ['G123', `${KEY}/x`, 'javascript:1', undefined, `S${'A'.repeat(55)}`]) {
    assert.equal(explorerAccountUrl('PUBLIC', bad), 'https://stellar.expert/explorer/public');
  }
});

test('buildMailtoUrl encodes subject and body and trims the address', () => {
  const url = buildMailtoUrl(' pay@client.example ', 'Invoice #1 & more', 'Line1\nLine2 "q"');
  assert.equal(url, 'mailto:pay@client.example?subject=Invoice%20%231%20%26%20more&body=Line1%0ALine2%20%22q%22');
});

test('buildMailtoUrl rejects addresses that could add recipients, headers or markup', () => {
  for (const bad of [
    'a@b.io?bcc=evil@x.io', 'a@b.io,c@d.io', 'a@b.io;c@d.io', 'a@b.io&cc=e@x.io', 'a%0Abcc:e@x.io',
    '<script>@b.io', '"a b"@b.io', 'a@b', 'a b@b.io', '', undefined, null, 5,
  ]) {
    assert.equal(buildMailtoUrl(bad, 's', 'b'), null, String(bad));
  }
});

test('the print document CSP blocks scripts, external loads, base and form hijacking', () => {
  assert.match(PRINT_DOCUMENT_CSP, /default-src 'none'/);
  assert.doesNotMatch(PRINT_DOCUMENT_CSP, /script-src/);
  assert.match(PRINT_DOCUMENT_CSP, /base-uri 'none'/);
  assert.match(PRINT_DOCUMENT_CSP, /form-action 'none'/);
  assert.doesNotMatch(PRINT_DOCUMENT_CSP, /unsafe-eval|https?:/);
});

test('external windows open with noopener and noreferrer', () => {
  assert.deepEqual(EXTERNAL_WINDOW_FEATURES.split(','), ['noopener', 'noreferrer']);
});
