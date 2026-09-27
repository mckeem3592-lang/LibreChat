import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask } from './task-routing.js';

test('normalizes common task aliases', () => {
  assert.equal(normalizeTask('chat'), 'primary');
  assert.equal(normalizeTask('deep_reasoning'), 'reasoning');
  assert.equal(normalizeTask('computer_use'), 'computer');
  assert.equal(normalizeTask('code'), 'coding');
});

test('unknown task falls back to primary', () => {
  assert.equal(normalizeTask('unknown'), 'primary');
});
