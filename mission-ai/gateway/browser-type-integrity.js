export function requireBrowserTypeRetention(result, requestedLength) {
  if (result?.domRetained !== true || result?.length !== requestedLength) {
    throw new Error('browser_text_unverified_after_action');
  }
  return result;
}
