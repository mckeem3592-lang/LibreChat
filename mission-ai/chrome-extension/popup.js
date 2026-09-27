const status = document.getElementById('status');

function refresh() {
  chrome.runtime.sendMessage({ type: 'mission-ai-status' }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Extension service worker unavailable';
      return;
    }
    status.textContent = response?.connected
      ? 'Connected to Mac companion'
      : response?.error
        ? `Companion not connected: ${response.error}`
        : 'Companion not connected';
  });
}

document.getElementById('pair').addEventListener('click', async () => {
  status.textContent = 'Pairing…';
  try {
    const response = await fetch('http://127.0.0.1:8766/browser/pair', {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`pair_http_${response.status}`);
    const body = await response.json();
    if (!body?.ok || !body.browserToken) throw new Error('pair_invalid_response');

    chrome.runtime.sendMessage(
      { type: 'mission-ai-set-token', token: body.browserToken },
      (result) => {
        if (chrome.runtime.lastError || !result?.ok) {
          status.textContent = 'Pairing failed: background worker rejected token';
          return;
        }
        setTimeout(refresh, 500);
      },
    );
  } catch (error) {
    status.textContent = `Pairing failed: ${error instanceof Error ? error.message : 'unknown_error'}`;
  }
});

refresh();
