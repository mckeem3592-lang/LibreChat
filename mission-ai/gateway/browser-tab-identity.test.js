import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBrowserTabIdentity } from './browser-tab-identity.js';

test('selected browser tab must match the requested tab when one is specified', () => {
  const result = { tab: { id: 101 }, page: { title: 'Gmail' } };
  assert.equal(requireBrowserTabIdentity(result, '101'), result);
  assert.equal(requireBrowserTabIdentity(result, undefined), result);
  assert.throws(() => requireBrowserTabIdentity(result, '102'), /browser_tab_mismatch/);
  assert.throws(() => requireBrowserTabIdentity({}, '101'), /browser_tab_mismatch/);
});
