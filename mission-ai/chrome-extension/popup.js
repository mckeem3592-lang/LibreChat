const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

async function refresh() {
  const { browserToken = '' } = await chrome.storage.local.get('browserToken');
  tokenInput.value = browserToken;
  chrome.runtime.sendMessage({ type: 'mission-ai-status' }, (response) => {
    status.textContent = response?.connected
      ? 'Connected to Mac companion'
      : 'Companion not connected';
  });
}

document.getElementById('pair').addEventListener('click', async () => {
  status.textContent = 'Pairing…';
  try {
    const response = await fetch('http://127.0.0.1:8765/browser/pair', {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('pairing_unavailable');
    const body = await response.json();
    if (!body?.ok || !body.browserToken) throw new Error('pairing_failed');
    await chrome.storage.local.set({ browserToken: body.browserToken });
    chrome.runtime.sendMessage({ type: 'mission-ai-token-updated' }, () => refresh());
  } catch {
    status.textContent =
      'Automatic pairing unavailable. Restart the companion and try again, or use Manual token.';
  }
});

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    status.textContent = 'Enter a token first';
    return;
  }
  await chrome.storage.local.set({ browserToken: token });
  chrome.runtime.sendMessage({ type: 'mission-ai-token-updated' }, () => refresh());
});

refresh();
