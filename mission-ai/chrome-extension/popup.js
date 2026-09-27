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

document.getElementById('pair').addEventListener('click', () => {
  status.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ type: 'mission-ai-reconnect' }, () => {
    setTimeout(refresh, 500);
  });
});

refresh();
