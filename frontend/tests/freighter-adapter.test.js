const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FreighterAdapter,
  FreighterNotInstalledError,
  FreighterUserDeclinedError,
  FreighterLockedError,
  FreighterDisconnectedError,
  FreighterApiIncompatibleError,
  MIN_SUPPORTED_FREIGHTER_API_VERSION,
} = require('../lib/freighter-adapter');

test('MIN_SUPPORTED_FREIGHTER_API_VERSION is documented as 1.5.0', () => {
  assert.equal(MIN_SUPPORTED_FREIGHTER_API_VERSION, '1.5.0');
});

test('FreighterAdapter singleton instance exists', () => {
  const instance = FreighterAdapter.getInstance();
  assert.ok(instance);
});

test('detectExtension returns false when window is undefined', async () => {
  const instance = FreighterAdapter.getInstance();
  const installed = await instance.detectExtension(50);
  assert.equal(installed, false);
});

test('assertInstalled throws FreighterNotInstalledError when extension is missing', async () => {
  const instance = FreighterAdapter.getInstance();
  await assert.rejects(
    async () => {
      await instance.assertInstalled(50);
    },
    (err) => err instanceof FreighterNotInstalledError && err.code === 'FREIGHTER_NOT_INSTALLED'
  );
});

test('custom error hierarchy instantiates with correct names and codes', () => {
  const notInstalled = new FreighterNotInstalledError();
  assert.equal(notInstalled.name, 'FreighterNotInstalledError');
  assert.equal(notInstalled.code, 'FREIGHTER_NOT_INSTALLED');

  const userDeclined = new FreighterUserDeclinedError();
  assert.equal(userDeclined.name, 'FreighterUserDeclinedError');
  assert.equal(userDeclined.code, 'FREIGHTER_USER_DECLINED');

  const locked = new FreighterLockedError();
  assert.equal(locked.name, 'FreighterLockedError');
  assert.equal(locked.code, 'FREIGHTER_LOCKED');

  const disconnected = new FreighterDisconnectedError();
  assert.equal(disconnected.name, 'FreighterDisconnectedError');
  assert.equal(disconnected.code, 'FREIGHTER_DISCONNECTED');

  const incompatible = new FreighterApiIncompatibleError();
  assert.equal(incompatible.name, 'FreighterApiIncompatibleError');
  assert.equal(incompatible.code, 'FREIGHTER_API_INCOMPATIBLE');
});
