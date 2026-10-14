import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDevice, resetPairingForTests, deviceCredential, authorizeDeviceCredential } from './pairing.js';

test('pairDevice accepts one valid code then consumes it', () => {
  process.env.MISSION_AI_PAIR_CODE = 'test-code';
  process.env.MISSION_AI_DEVICE_TOKEN = 'device-token-that-is-long-enough-for-tests';
  process.env.MISSION_AI_PAIR_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
  resetPairingForTests();

  assert.deepEqual(pairDevice({ code: 'test-code', deviceId: 'windows-work', remoteAddress: '127.0.0.1' }), {
    deviceToken: deviceCredential(process.env.MISSION_AI_DEVICE_TOKEN, 'windows-work'),
  });
  assert.equal(authorizeDeviceCredential(deviceCredential(process.env.MISSION_AI_DEVICE_TOKEN, 'windows-work'), process.env.MISSION_AI_DEVICE_TOKEN, 'windows-work'), true);
  assert.equal(authorizeDeviceCredential(deviceCredential(process.env.MISSION_AI_DEVICE_TOKEN, 'windows-work'), process.env.MISSION_AI_DEVICE_TOKEN, 'mac-primary'), false);
  assert.throws(
    () => pairDevice({ code: 'test-code', deviceId: 'mac-primary', remoteAddress: '127.0.0.2' }),
    /pairing_consumed/,
  );
});

test('pairDevice rejects invalid and expired codes', () => {
  process.env.MISSION_AI_PAIR_CODE = 'test-code';
  process.env.MISSION_AI_DEVICE_TOKEN = 'device-token-that-is-long-enough-for-tests';
  process.env.MISSION_AI_PAIR_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
  resetPairingForTests();
  assert.throws(() => pairDevice({ code: 'wrong', deviceId: 'windows-work', remoteAddress: '10.0.0.1' }), /pairing_invalid/);

  process.env.MISSION_AI_PAIR_EXPIRES_AT = new Date(Date.now() - 60_000).toISOString();
  resetPairingForTests();
  assert.throws(() => pairDevice({ code: 'test-code', deviceId: 'windows-work', remoteAddress: '10.0.0.2' }), /pairing_expired/);
});
