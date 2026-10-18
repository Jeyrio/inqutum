const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'ApiErrorState.tsx'), 'utf8');

test('API error state exposes an alert and retry affordance', () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-live="assertive"/);
  assert.match(source, /disabled=\{retrying\}/);
  assert.match(source, /Retrying\.\.\./);
});
