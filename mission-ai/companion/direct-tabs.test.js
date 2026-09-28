import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCloseTabRequest,
  parseChromeTabRows,
  validateActivateTab,
} from './direct-tabs.js';

test('parses stable Chrome window and tab identifiers', () => {
  const tabs = parseChromeTabRows(
    '101\\t9001\\t1\\t1\\t1\\tMission AI\\thttps://example.com/a\n' +
    '101\\t9002\\t1\\t2\\t0\\tSecond\\thttps://example.com/b\n',
  );
  assert.deepEqual(tabs, [
    {
      windowId: '101',
      tabId: '9001',
      windowIndex: 1,
      tabIndex: 1,
      active: true,
      title: 'Mission AI',
      url: 'https://example.com/a',
    },
    {
      windowId: '101',
      tabId: '9002',
      windowIndex: 1,
      tabIndex: 2,
      active: false,
      title: 'Second',
      url: 'https://example.com/b',
    },
  ]);
});

test('activate requires stable window and tab ids', () => {
  assert.deepEqual(validateActivateTab({ windowId: 101, tabId: 9001 }), {
    windowId: '101',
    tabId: '9001',
  });
  assert.throws(() => validateActivateTab({ windowId: '101' }), /invalid_tab_selection/);
});

test('close requires explicit confirmation', () => {
  assert.throws(
    () => normalizeCloseTabRequest({
      tabs: [{ windowId: '101', tabId: '9001', expectedUrl: 'https://example.com' }],
    }),
    /confirmation_required/,
  );
});

test('close requires expected URL and removes duplicate ids', () => {
  const tabs = normalizeCloseTabRequest({
    confirm: true,
    tabs: [
      { windowId: '101', tabId: '9001', expectedUrl: 'https://example.com/a' },
      { windowId: '101', tabId: '9001', expectedUrl: 'https://example.com/a' },
      { windowId: '101', tabId: '9002', expectedUrl: 'https://example.com/b' },
    ],
  });
  assert.deepEqual(tabs, [
    { windowId: '101', tabId: '9001', expectedUrl: 'https://example.com/a' },
    { windowId: '101', tabId: '9002', expectedUrl: 'https://example.com/b' },
  ]);

  assert.throws(
    () => normalizeCloseTabRequest({
      confirm: true,
      tabs: [{ windowId: '101', tabId: '9001' }],
    }),
    /invalid_tab_selection/,
  );
});
