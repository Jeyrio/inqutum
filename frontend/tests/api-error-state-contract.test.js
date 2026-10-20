const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'ApiErrorState.tsx'), 'utf8');

test('API error state exposes an alert and retry affordance', () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-live="assertive"/);
  // Busy is aria-disabled so the focused retry button is not dropped to <body>.
  assert.match(source, /aria-disabled=\{retrying\}/);
  assert.match(source, /aria-busy=\{retrying\}/);
  assert.doesNotMatch(source, /\sdisabled=\{retrying\}/);
  assert.match(source, /Retrying\.\.\./);
});
