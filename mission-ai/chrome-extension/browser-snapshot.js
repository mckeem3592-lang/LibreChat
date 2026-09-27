export const SNAPSHOT_TTL_MS = 60_000;

export function createSnapshot({ id, tabId, url, now = Date.now(), ttlMs = SNAPSHOT_TTL_MS }) {
  if (!id || !Number.isInteger(tabId) || !url) throw new Error('invalid_browser_snapshot');
  return {
    id: String(id),
    tabId,
    url: String(url),
    expiresAt: Number(now) + Number(ttlMs),
  };
}

export function validateSnapshot(snapshot, { snapshotId, tabId, url, now = Date.now() }) {
  if (!snapshot || !snapshotId || snapshot.id !== snapshotId) {
    throw new Error('browser_snapshot_required');
  }
  if (Number(now) > snapshot.expiresAt) throw new Error('browser_snapshot_expired');
  if (snapshot.tabId !== tabId || snapshot.url !== String(url || '')) {
    throw new Error('browser_snapshot_stale');
  }
  return snapshot;
}

export function pageUrlAllowed(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
