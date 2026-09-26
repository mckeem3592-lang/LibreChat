const LOOPBACK = 'ws://127.0.0.1:8765/browser';
let socket;
let reconnectTimer;

async function getToken() {
  const stored = await chrome.storage.local.get('browserToken');
  return stored.browserToken || '';
}

async function connect() {
  clearTimeout(reconnectTimer);
  const token = await getToken();
  if (!token) return;
  socket = new WebSocket(`${LOOPBACK}?token=${encodeURIComponent(token)}`);
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message?.type !== 'browser_tool') return;
    try {
      const result = await execute(message.tool, message.args || {});
      socket.send(JSON.stringify({ type: 'browser_result', id: message.id, ok: true, result }));
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: 'browser_result',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : 'browser_error',
        }),
      );
    }
  };
  socket.onclose = () => {
    reconnectTimer = setTimeout(connect, 3000);
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no_active_tab');
  return tab;
}

async function execInTab(func, args = []) {
  const tab = await activeTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args,
  });
  return result?.result;
}

async function execute(tool, args) {
  if (tool === 'browser.open_url') {
    const url = new URL(String(args.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url_not_allowed');
    const tab = await activeTab();
    await chrome.tabs.update(tab.id, { url: url.toString() });
    return { url: url.toString() };
  }

  if (tool === 'browser.get_state') {
    const tab = await activeTab();
    const page = await execInTab(() => {
      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
        .slice(0, 300)
        .map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
            .trim()
            .slice(0, 200),
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
    return { tab: { id: tab.id, title: tab.title, url: tab.url }, page };
  }

  if (tool === 'browser.click') {
    return await execInTab((index) => {
      const all = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].slice(
        0,
        300,
      );
      const el = all[index];
      if (!el) throw new Error('element_not_found');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { clicked: index };
    }, [Number(args.index)]);
  }

  if (tool === 'browser.type') {
    const value = String(args.text || '');
    return await execInTab((index, text) => {
      const all = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].slice(
        0,
        300,
      );
      const el = all[index];
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        throw new Error('element_not_text_input');
      }
      if (el instanceof HTMLInputElement && el.type === 'password') {
        throw new Error('password_field_denied');
      }
      el.focus();
      const setter =
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: index, length: text.length };
    }, [Number(args.index), value]);
  }

  if (tool === 'browser.scroll') {
    return await execInTab((x, y) => {
      window.scrollBy({ left: x, top: y, behavior: 'auto' });
      return { x: window.scrollX, y: window.scrollY };
    }, [Number(args.x || 0), Number(args.y || 600)]);
  }

  throw new Error('tool_not_allowed');
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
