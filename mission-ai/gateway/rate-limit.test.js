import test from 'node:test';
import assert from 'node:assert/strict';
import { FixedWindowLimiter } from './rate-limit.js';

test('window counter resets', () => {
  const value = new FixedWindowLimiter({ windowMs: 1000, max: 2 });
  assert.equal(value.allow('a', 0), true);
  assert.equal(value.allow('a', 1), true);
  assert.equal(value.allow('a', 2), false);
  assert.equal(value.allow('a', 1000), true);
});
