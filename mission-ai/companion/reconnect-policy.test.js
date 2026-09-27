import test from 'node:test';
import assert from 'node:assert/strict';
import { reconnectDelayMs } from './reconnect-policy.js';

test('reconnect backoff is bounded', () => {
  assert.equal(reconnectDelayMs(0), 1000);
  assert.equal(reconnectDelayMs(1), 2000);
  assert.equal(reconnectDelayMs(6), 60000);
  assert.equal(reconnectDelayMs(20), 60000);
});

test('invalid reconnect policy fails closed', () => {
  assert.throws(() => reconnectDelayMs(0, { baseMs: 0, maxMs: 1000 }), /invalid_base_delay/);
  assert.throws(() => reconnectDelayMs(0, { baseMs: 2000, maxMs: 1000 }), /invalid_max_delay/);
});
