const LOOPBACK = 'ws://127.0.0.1:8766/browser';
let socket = null;
let keepAliveTimer = null;
let reconnectTimer = null;

function publish(connected, error = null) {
  chrome.runtime.sendMessage({
    type: 'mission-ai-offscreen-status',
    connected,
    error,
  }).catch(() => {});
}

function cleanup() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close(4000, 'reconnect');
    } catch {}
  }
  socket = null;
}

function connect(token) {
  const value = String(token || '');
  if (!value) return Promise.resolve({ ok: false, error: 'empty_token' });

  localStorage.setItem('mission-ai-browser-token', value);
  cleanup();

  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(`${LOOPBACK}?token=${encodeURIComponent(value)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'websocket_constructor_failed';
      publish(false, message);
      resolve({ ok: false, error: message });
      return;
    }

    socket = ws;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.onopen = () => {
      publish(true, null);
      keepAliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'keepalive' })); } catch {}
        }
      }, 20000);
      finish({ ok: true });
    };

    ws.onerror = () => {
      publish(false, 'websocket_connection_failed');
      finish({ ok: false, error: 'websocket_connection_failed' });
    };

    ws.onclose = (event) => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (socket === ws) socket = null;
      const error = `websocket_closed_${event.code}`;
      publish(false, error);
      finish({ ok: false, error });
      reconnectTimer = setTimeout(() => connect(value), 1500);
    };

    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        ws.close(1003, 'invalid_json');
        return;
      }
      if (message?.type !== 'browser_tool' || typeof message.id !== 'string') return;

      const response = await chrome.runtime.sendMessage({
        type: 'mission-ai-browser-tool',
        tool: message.tool,
        args: message.args || {},
      }).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'browser_worker_unavailable',
      }));

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_result',
          id: message.id,
          ok: Boolean(response?.ok),
          result: response?.result,
          error: response?.error || null,
        }));
      }
    };
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message?.type === 'mission-ai-offscreen-connect') {
    connect(message.token).then(sendResponse);
    return true;
  }
});

const savedToken = localStorage.getItem('mission-ai-browser-token');
if (savedToken) connect(savedToken);
