export function requireBrowserTabIdentity(result, requestedTabId) {
  if (requestedTabId != null && String(result?.tab?.id ?? '') !== String(requestedTabId)) {
    throw new Error('browser_tab_mismatch');
  }
  return result;
}
