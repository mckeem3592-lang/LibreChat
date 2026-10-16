import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBrowserTypeRetention } from './browser-type-integrity.js';

test('browser type success requires the extension to confirm exact DOM retention', () => {
  const result = { typed: 216, length: 9, domRetained: true };
  assert.equal(requireBrowserTypeRetention(result, 9), result);
  for (const oldOrInvalid of [
    { typed: 216, length: 9 },
    { typed: 216, length: 8, domRetained: true },
    { typed: 216, length: 9, domRetained: false },
    null,
  ]) {
    assert.throws(
      () => requireBrowserTypeRetention(oldOrInvalid, 9),
      /browser_text_unverified_after_action/,
    );
  }
});
