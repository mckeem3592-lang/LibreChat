import assert from 'node:assert/strict';
import test from 'node:test';
import {
  drainNativeFrames,
  encodeNativeMessage,
  MAX_NATIVE_MESSAGE_BYTES,
  nativeReconnectDelayMs,
} from '../companion/native-message-framing.js';

test('native framing round-trips one message', () => {
  const frame = encodeNativeMessage({ type: 'ping' });
  const { messages, remainder } = drainNativeFrames(frame);
  assert.deepEqual(messages, [{ type: 'ping' }]);
  assert.equal(remainder.length, 0);
});

test('native framing preserves partial data for the next read', () => {
  const frame = encodeNativeMessage({ type: 'browser_result', id: 'abc', ok: true });
  const first = drainNativeFrames(frame.subarray(0, 7));
  assert.deepEqual(first.messages, []);
  const second = drainNativeFrames(Buffer.concat([first.remainder, frame.subarray(7)]));
  assert.equal(second.messages[0].id, 'abc');
  assert.equal(second.remainder.length, 0);
});

test('native framing supports multiple messages in one chunk', () => {
  const chunk = Buffer.concat([
    encodeNativeMessage({ type: 'ping' }),
    encodeNativeMessage({ type: 'ping', n: 2 }),
  ]);
  const { messages } = drainNativeFrames(chunk);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].n, 2);
});

test('native framing rejects zero, oversized, and invalid JSON frames', () => {
  const zero = Buffer.alloc(4);
  assert.throws(() => drainNativeFrames(zero), /native_message_size_invalid/);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
  assert.throws(() => drainNativeFrames(oversized), /native_message_size_invalid/);

  const invalid = Buffer.alloc(5);
  invalid.writeUInt32LE(1, 0);
  invalid[4] = 0x7b;
  assert.throws(() => drainNativeFrames(invalid), /native_message_json_invalid/);
});

test('native reconnect delay is bounded', () => {
  assert.equal(nativeReconnectDelayMs(0), 500);
  assert.equal(nativeReconnectDelayMs(1), 1000);
  assert.equal(nativeReconnectDelayMs(6), 30000);
  assert.equal(nativeReconnectDelayMs(999), 30000);
});
