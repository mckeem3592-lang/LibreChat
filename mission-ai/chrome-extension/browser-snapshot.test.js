import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshot, pageUrlAllowed, validateSnapshot } from './browser-snapshot.js';

test('browser snapshot validates only the observed tab and URL', () => {
  const snapshot = createSnapshot({
    id: 'snap-1',
    tabId: 7,
    url: 'https://example.com/a',
    now: 1000,
  });
  assert.equal(
    validateSnapshot(snapshot, {
      snapshotId: 'snap-1',
      tabId: 7,
      url: 'https://example.com/a',
      now: 2000,
    }).id,
    'snap-1',
  );
  assert.throws(
    () =>
      validateSnapshot(snapshot, {
        snapshotId: 'snap-1',
        tabId: 7,
        url: 'https://example.com/b',
        now: 2000,
      }),
    /browser_snapshot_stale/,
  );
});

test('browser snapshot expires quickly and unknown snapshots fail closed', () => {
  const snapshot = createSnapshot({
    id: 'snap-1',
    tabId: 7,
    url: 'https://example.com',
    now: 1000,
    ttlMs: 100,
  });
  assert.throws(
    () =>
      validateSnapshot(snapshot, {
        snapshotId: 'snap-1',
        tabId: 7,
        url: 'https://example.com',
        now: 1101,
      }),
    /browser_snapshot_expired/,
  );
  assert.throws(
    () =>
      validateSnapshot(null, {
        snapshotId: 'snap-1',
        tabId: 7,
        url: 'https://example.com',
        now: 1000,
      }),
    /browser_snapshot_required/,
  );
});

test('browser page tools reject privileged and non-web URLs', () => {
  assert.equal(pageUrlAllowed('https://example.com'), true);
  assert.equal(pageUrlAllowed('http://localhost:3000'), true);
  assert.equal(pageUrlAllowed('chrome://settings'), false);
  assert.equal(pageUrlAllowed('file:///tmp/a'), false);
  assert.equal(pageUrlAllowed('javascript:alert(1)'), false);
});
