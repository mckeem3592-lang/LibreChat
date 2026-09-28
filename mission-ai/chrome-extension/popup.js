const status = document.getElementById('status');

function refresh() {
  chrome.runtime.sendMessage({ type: 'mission-ai-status' }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Extension service worker unavailable';
      return;
    }
    status.textContent = response?.connected
      ? 'Connected to Mission AI on this Mac'
      : response?.error
        ? `Not connected: ${response.error}`
        : 'Not connected';
  });
}

document.getElementById('pair').addEventListener('click', () => {
  status.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ type: 'mission-ai-reconnect' }, () => {
    setTimeout(refresh, 750);
  });
});

refresh();
