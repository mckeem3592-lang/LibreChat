const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

async function refresh() {
  const { browserToken = '' } = await chrome.storage.local.get('browserToken');
  tokenInput.value = browserToken;
  chrome.runtime.sendMessage({ type: 'mission-ai-status' }, (response) => {
    status.textContent = response?.connected ? 'Connected to Mac companion' : 'Companion not connected';
  });
}

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
