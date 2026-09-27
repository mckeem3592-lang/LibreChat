import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMacControlError } from './permission-errors.js';

test('maps accessibility denial to actionable error', () => {
  const result = normalizeMacControlError('accessibility', {
    stderr: 'System Events got an error: osascript is not allowed assistive access.',
  });
  assert.equal(result.message, 'accessibility_permission_required');
});

test('maps screenshot denial to actionable error', () => {
  const result = normalizeMacControlError('screen-recording', {
    stderr: 'screencapture: could not create image from display',
  });
  assert.equal(result.message, 'screen_recording_permission_required');
});

test('preserves unrelated failures', () => {
  const original = new Error('other_failure');
  assert.equal(normalizeMacControlError('accessibility', original), original);
});
