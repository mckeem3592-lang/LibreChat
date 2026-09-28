export function parseChromeTabRows(stdout = '') {
  return String(stdout)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [windowId, tabId, windowIndex, tabIndex, active, title, ...urlParts] = line.split('\t');
      return {
        windowId: String(windowId || ''),
        tabId: String(tabId || ''),
        windowIndex: Number(windowIndex),
        tabIndex: Number(tabIndex),
        active: active === '1',
        title: title || '',
        url: urlParts.join('\t') || '',
      };
    })
    .filter(
      (tab) =>
        tab.windowId &&
        tab.tabId &&
        Number.isInteger(tab.windowIndex) &&
        Number.isInteger(tab.tabIndex),
    );
}

export function validateActivateTab(args = {}) {
  const windowId = String(args?.windowId || '');
  const tabId = String(args?.tabId || '');
  if (!windowId || !tabId) throw new Error('invalid_tab_selection');
  return { windowId, tabId };
}

export function normalizeCloseTabRequest(args = {}) {
  if (args?.confirm !== true) throw new Error('confirmation_required');
  const requested = Array.isArray(args?.tabs) ? args.tabs : [];
  if (!requested.length || requested.length > 100) throw new Error('invalid_tab_selection');

  const seen = new Set();
  const tabs = [];

  for (const item of requested) {
    const windowId = String(item?.windowId || '');
    const tabId = String(item?.tabId || '');
    const expectedUrl = String(item?.expectedUrl || '');
    if (!windowId || !tabId || !expectedUrl) throw new Error('invalid_tab_selection');

    const key = `${windowId}:${tabId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({ windowId, tabId, expectedUrl });
  }

  return tabs;
}
