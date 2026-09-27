import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDevice, resetPairingForTests } from './pairing.js';

test('pairDevice accepts one valid code then consumes it', () => {
  process.env.MISSION_AI_PAIR_CODE = 'test-code';
  process.env.MISSION_AI_DEVICE_TOKEN = 'device-token';
  process.env.MISSION_AI_PAIR_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
  resetPairingForTests();

  assert.deepEqual(pairDevice({ code: 'test-code', remoteAddress: '127.0.0.1' }), {
    deviceToken: 'device-token',
  });
  assert.throws(
    () => pairDevice({ code: 'test-code', remoteAddress: '127.0.0.2' }),
    /pairing_consumed/,
  );
});

test('pairDevice rejects invalid and expired codes', () => {
  process.env.MISSION_AI_PAIR_CODE = 'test-code';
  process.env.MISSION_AI_DEVICE_TOKEN = 'device-token';
  process.env.MISSION_AI_PAIR_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
  resetPairingForTests();
  assert.throws(() => pairDevice({ code: 'wrong', remoteAddress: '10.0.0.1' }), /pairing_invalid/);

  process.env.MISSION_AI_PAIR_EXPIRES_AT = new Date(Date.now() - 60_000).toISOString();
  resetPairingForTests();
  assert.throws(() => pairDevice({ code: 'test-code', remoteAddress: '10.0.0.2' }), /pairing_expired/);
});
