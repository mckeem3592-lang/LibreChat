import { createSnapshot, pageUrlAllowed, validateSnapshot } from './browser-snapshot.js';

const LOOPBACK = 'ws://127.0.0.1:8766/browser';
let socket = null;
let browserToken = '';
let latestSnapshot = null;
let keepAliveTimer = null;
let lastConnectionError = 'pairing_required';

function stopSocket(reason = 'reconnect') {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (socket) {
    try {
      socket.onclose = null;
      socket.onerror = null;
      socket.close(4000, reason);
    } catch {}
  }
  socket = null;
}

function connectWithToken(token) {
  browserToken = String(token || '');
  if (!browserToken) {
    lastConnectionError = 'empty_token';
    return Promise.resolve({ ok: false, error: lastConnectionError });
  }

  stopSocket('credential_updated');
  lastConnectionError = 'connecting';

  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(`${LOOPBACK}?token=${encodeURIComponent(browserToken)}`);
    } catch (error) {
      lastConnectionError = error instanceof Error ? error.message : 'websocket_constructor_failed';
      resolve({ ok: false, error: lastConnectionError });
      return;
    }

    socket = ws;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.onopen = () => {
      lastConnectionError = null;
      keepAliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'keepalive' }));
          } catch {}
        }
      }, 20_000);
      finish({ ok: true });
    };

    ws.onerror = () => {
      lastConnectionError = 'websocket_connection_failed';
      finish({ ok: false, error: lastConnectionError });
    };

    ws.onclose = (event) => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (socket === ws) socket = null;
      if (!lastConnectionError || lastConnectionError === 'connecting') {
        lastConnectionError = `websocket_closed_${event.code}`;
      }
      finish({ ok: false, error: lastConnectionError });
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
      try {
        const result = await execute(message.tool, message.args || {});
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'browser_result', id: message.id, ok: true, result }));
        }
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'browser_result',
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : 'browser_error',
            }),
          );
        }
      }
    };
  });
}

async function activeTab({ requireWeb = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no_active_tab');
  if (requireWeb && !pageUrlAllowed(tab.url)) throw new Error('tab_url_not_allowed');
  return tab;
}

async function execInTab(tab, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args,
  });
  return result?.result;
}

function requireCurrentSnapshot(args, tab) {
  return validateSnapshot(latestSnapshot, {
    snapshotId: String(args?.snapshotId || ''),
    tabId: tab.id,
    url: tab.url,
  });
}

async function execute(tool, args) {
  if (tool === 'browser.open_url') {
    const url = new URL(String(args.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url_not_allowed');
    const tab = await activeTab();
    latestSnapshot = null;
    await chrome.tabs.update(tab.id, { url: url.toString() });
    return { url: url.toString() };
  }

  if (tool === 'browser.get_state') {
    const tab = await activeTab({ requireWeb: true });
    const page = await execInTab(tab, () => {
      const keyFor = (el) => {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        const name = el.getAttribute('name') || '';
        const aria = el.getAttribute('aria-label') || '';
        const text = (
          el.innerText ||
          el.getAttribute('placeholder') ||
          ''
        ).trim().slice(0, 120);
        return [tag, type, name, aria, text].join('|').slice(0, 400);
      };

      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
        .slice(0, 300)
        .map((el, index) => ({
          index,
          key: keyFor(el),
          tag: el.tagName.toLowerCase(),
          text: (
            el.innerText ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            ''
          ).trim().slice(0, 200),
          type: el.getAttribute('type') || null,
          disabled: 'disabled' in el ? Boolean(el.disabled) : false,
        }));

      return {
        title: document.title,
        url: location.href,
        text: document.body?.innerText?.slice(0, 40_000) || '',
        elements,
      };
    });

    const snapshot = createSnapshot({
      id: crypto.randomUUID(),
      tabId: tab.id,
      url: page?.url || tab.url,
    });
    latestSnapshot = snapshot;

    return {
      trust: 'untrusted_web_content',
      snapshotId: snapshot.id,
      snapshotExpiresAt: new Date(snapshot.expiresAt).toISOString(),
      tab: { id: tab.id, title: tab.title, url: tab.url },
      page,
    };
  }

  if (tool === 'browser.click') {
    const tab = await activeTab({ requireWeb: true });
    const snapshot = requireCurrentSnapshot(args, tab);
    const index = Number(args.index);
    const expectedKey = String(args.elementKey || '');
    if (!Number.isInteger(index) || index < 0 || !expectedKey) {
      throw new Error('browser_element_reference_required');
    }

    const result = await execInTab(tab, (elementIndex, elementKey, expectedUrl) => {
      if (location.href !== expectedUrl) throw new Error('browser_snapshot_stale');
      const all = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
        .slice(0, 300);
      const el = all[elementIndex];
      if (!el) throw new Error('element_not_found');
      const keyFor = (node) => {
        const tag = node.tagName.toLowerCase();
        const type = node.getAttribute('type') || '';
        const name = node.getAttribute('name') || '';
        const aria = node.getAttribute('aria-label') || '';
        const text = (
          node.innerText ||
          node.getAttribute('placeholder') ||
          ''
        ).trim().slice(0, 120);
        return [tag, type, name, aria, text].join('|').slice(0, 400);
      };
      if (keyFor(el) !== elementKey) throw new Error('browser_element_stale');
      if ('disabled' in el && el.disabled) throw new Error('element_disabled');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { clicked: elementIndex };
    }, [index, expectedKey, snapshot.url]);

    latestSnapshot = null;
    return result;
  }

  if (tool === 'browser.type') {
    const tab = await activeTab({ requireWeb: true });
    const snapshot = requireCurrentSnapshot(args, tab);
    const index = Number(args.index);
    const expectedKey = String(args.elementKey || '');
    const value = String(args.text || '');
    if (!Number.isInteger(index) || index < 0 || !expectedKey) {
      throw new Error('browser_element_reference_required');
    }
    if (value.length > 20_000) throw new Error('text_too_long');

    const result = await execInTab(tab, (elementIndex, elementKey, text, expectedUrl) => {
      if (location.href !== expectedUrl) throw new Error('browser_snapshot_stale');
      const all = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
        .slice(0, 300);
      const el = all[elementIndex];
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        throw new Error('element_not_text_input');
      }
      const keyFor = (node) => {
        const tag = node.tagName.toLowerCase();
        const type = node.getAttribute('type') || '';
        const name = node.getAttribute('name') || '';
        const aria = node.getAttribute('aria-label') || '';
        const visible = (
          node.innerText ||
          node.getAttribute('placeholder') ||
          ''
        ).trim().slice(0, 120);
        return [tag, type, name, aria, visible].join('|').slice(0, 400);
      };
      if (keyFor(el) !== elementKey) throw new Error('browser_element_stale');
      if (el instanceof HTMLInputElement && el.type === 'password') {
        throw new Error('password_field_denied');
      }
      if (el.disabled || el.readOnly) throw new Error('element_not_editable');
      el.focus();
      const setter =
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: elementIndex, length: text.length };
    }, [index, expectedKey, value, snapshot.url]);

    latestSnapshot = null;
    return result;
  }

  if (tool === 'browser.scroll') {
    const tab = await activeTab({ requireWeb: true });
    latestSnapshot = null;
    return await execInTab(tab, (x, y) => {
      window.scrollBy({ left: x, top: y, behavior: 'auto' });
      return { x: window.scrollX, y: window.scrollY };
    }, [Number(args.x || 0), Number(args.y || 600)]);
  }

  throw new Error('tool_not_allowed');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mission-ai-status') {
    sendResponse({
      connected: socket?.readyState === WebSocket.OPEN,
      error: lastConnectionError,
      readyState: socket?.readyState ?? WebSocket.CLOSED,
    });
    return;
  }

  if (message?.type === 'mission-ai-set-token') {
    connectWithToken(message.token)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'connection_failed',
        }),
      );
    return true;
  }

  if (message?.type === 'mission-ai-reconnect') {
    connectWithToken(browserToken).then(sendResponse);
    return true;
  }
});
