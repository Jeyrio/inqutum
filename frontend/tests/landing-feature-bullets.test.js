const test = require('node:test');
const assert = require('node:assert/strict');
const { LANDING_BULLETS, renderLandingBullets } = require('../lib/landing-feature-bullets');

test('landing feature bullets keeps the canonical bullet order and copy', () => {
  assert.deepEqual(renderLandingBullets(), LANDING_BULLETS);
  assert.deepEqual(
    renderLandingBullets().map(({ n, title }) => ({ n, title })),
    [
      { n: '01', title: 'Create' },
      { n: '02', title: 'Get paid' },
      { n: '03', title: 'Keep proof' },
    ]
  );
});
