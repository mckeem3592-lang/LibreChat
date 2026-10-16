import { createSnapshot, pageUrlAllowed, validateSnapshot } from './browser-snapshot.js';
import { collectPageState, PAGE_ELEMENT_SELECTOR } from './browser-page-state.js';
import { typeIntoPageElement } from './browser-type.js';

const NATIVE_HOST = 'com.missionai.browser_bridge';
let latestSnapshot = null;
let nativePort = null;
let directSocket = null;
let directConnecting = false;
let directKeepalive = null;
let transportConnected = false;
let lastConnectionError = 'native_host_not_connected';
let reconnectTimer = null;
let reconnectAttempt = 0;

function reconnectDelay(attempt) {
  return Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = reconnectDelay(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, delay);
}

async function handleBrowserTool(message, send) {
  if (message?.type !== 'browser_tool' || typeof message.id !== 'string') return;
  try {
    send({ type: 'browser_result', id: message.id, ok: true,
      result: await execute(message.tool, message.args || {}) });
  } catch (error) {
    send({ type: 'browser_result', id: message.id, ok: false,
      error: error instanceof Error ? error.message : 'browser_error' });
  }
}

async function connectDirect() {
  if (directConnecting || directSocket) return;
  directConnecting = true;
  try {
    const response = await fetch('http://127.0.0.1:8766/browser/pair', {
      cache: 'no-store', signal: AbortSignal.timeout(5000),
      headers: { 'X-Mission-AI-Extension': chrome.runtime.id },
    });
    if (!response.ok) throw new Error('local_bridge_pair_failed');
    const { browserToken } = await response.json();
    if (typeof browserToken !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(browserToken)) {
      throw new Error('local_bridge_token_invalid');
    }
    const socket = new WebSocket(`ws://127.0.0.1:8766/browser?token=${encodeURIComponent(browserToken)}`);
    directSocket = socket;
    socket.onopen = () => {
      transportConnected = true;
      lastConnectionError = null;
      reconnectAttempt = 0;
      directKeepalive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    };
    socket.onmessage = (event) => {
      try {
        handleBrowserTool(JSON.parse(event.data), result => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
        });
      } catch { /* Ignore malformed local transport messages. */ }
    };
    socket.onerror = () => { lastConnectionError = 'local_bridge_websocket_failed'; };
    socket.onclose = () => {
      if (directKeepalive) clearInterval(directKeepalive);
      directKeepalive = null;
      if (directSocket !== socket) return;
      directSocket = null;
      transportConnected = false;
      lastConnectionError ||= 'local_bridge_disconnected';
      scheduleReconnect();
    };
  } catch (error) {
    transportConnected = false;
    lastConnectionError = error instanceof Error ? error.message : 'local_bridge_unavailable';
    scheduleReconnect();
  } finally {
    directConnecting = false;
  }
}

function connectNative() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    lastConnectionError = 'connecting_native_host';

    port.onMessage.addListener((message) => {
      if (message?.type === 'status') {
        transportConnected = message.connected === true;
        lastConnectionError = transportConnected ? null : (message.error || 'native_host_disconnected');
        if (transportConnected) reconnectAttempt = 0;
        return;
      }

      handleBrowserTool(message, result => port.postMessage(result));
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'native_host_disconnected';
      if (nativePort === port) nativePort = null;
      transportConnected = false;
      lastConnectionError = error;
      connectDirect();
    });

    port.postMessage({ type: 'ping' });
  } catch (error) {
    nativePort = null;
    transportConnected = false;
    lastConnectionError = error instanceof Error ? error.message : 'native_host_connect_failed';
    connectDirect();
  }
}

async function activeTab({ requireWeb = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no_active_tab');
  if (requireWeb && !pageUrlAllowed(tab.url)) throw new Error('tab_url_not_allowed');
  return tab;
}

function requestedTabId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid_tab_id');
  return id;
}

async function selectedTab(args, { requireWeb = false, useSnapshot = false } = {}) {
  const id = useSnapshot ? latestSnapshot?.tabId : args?.tabId;
  const tab = id == null ? await activeTab({ requireWeb }) :
    await chrome.tabs.get(requestedTabId(id));
  if (!tab?.id) throw new Error('tab_not_found');
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
  if (tool === 'browser.list_tabs') {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.filter((tab) => pageUrlAllowed(tab.url)).slice(0, 200)
      .map((tab) => ({ windowId: String(tab.windowId), tabId: String(tab.id),
        title: tab.title || '', url: tab.url, active: tab.active === true })) };
  }

  if (tool === 'browser.open_new_tab') {
    const url = new URL(String(args.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url_not_allowed');
    const tab = await chrome.tabs.create({ url: url.toString(), active: false });
    return { windowId: String(tab.windowId), tabId: String(tab.id), url: tab.url,
      openedByMissionAI: true };
  }

  if (tool === 'browser.close_tabs') {
    if (args.confirm !== true || !Array.isArray(args.tabs) ||
        args.tabs.length < 1 || args.tabs.length > 100) throw new Error('confirmation_required');
    for (const item of args.tabs) {
      const tab = await chrome.tabs.get(requestedTabId(item.tabId));
      if (String(tab.windowId) !== String(item.windowId) ||
          tab.url !== item.expectedUrl) throw new Error('tab_stale');
      await chrome.tabs.remove(tab.id);
    }
    latestSnapshot = null;
    return { closed: args.tabs.length };
  }

  if (tool === 'browser.open_url') {
    const url = new URL(String(args.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url_not_allowed');
    const tab = args.tabId == null ? null : await selectedTab(args);
    latestSnapshot = null;
    const result = tab ? await chrome.tabs.update(tab.id, { url: url.toString() }) :
      await chrome.tabs.create({ url: url.toString(), active: false });
    return { windowId: String(result.windowId), tabId: String(result.id),
      url: url.toString(), openedByMissionAI: tab == null };
  }

  if (tool === 'browser.get_state') {
    const tab = await selectedTab(args, { requireWeb: true });
    const page = await execInTab(tab, collectPageState, [PAGE_ELEMENT_SELECTOR]);

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
    const tab = await selectedTab(args, { requireWeb: true, useSnapshot: true });
    const snapshot = requireCurrentSnapshot(args, tab);
    const index = Number(args.index);
    const expectedKey = String(args.elementKey || '');
    if (!Number.isInteger(index) || index < 0 || !expectedKey) {
      throw new Error('browser_element_reference_required');
    }

    const result = await execInTab(tab, (elementIndex, elementKey, expectedUrl, selector) => {
      if (location.href !== expectedUrl) throw new Error('browser_snapshot_stale');
      const all = [...document.querySelectorAll(selector)]
        .slice(0, 300);
      const el = all[elementIndex];
      if (!el) throw new Error('element_not_found');
      if (el.closest('[hidden],[aria-hidden="true"]') || el.getClientRects().length === 0 ||
          getComputedStyle(el).display === 'none' ||
          getComputedStyle(el).visibility === 'hidden' ||
          getComputedStyle(el).opacity === '0') throw new Error('element_not_visible');
      const keyFor = (node) => {
        const tag = node.tagName.toLowerCase();
        const type = node.getAttribute('type') || '';
        const name = node.getAttribute('name') || '';
        const aria = node.getAttribute('aria-label') || '';
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const chunks = [];
        let inspected = 0;
        while (walker.nextNode() && inspected++ < 10000 && chunks.join(' ').length < 120) {
          const parent = walker.currentNode.parentElement;
          if (!parent || parent.closest('script,style,noscript,template,[type="password"],[hidden],[aria-hidden="true"]') ||
              parent.getClientRects().length === 0) continue;
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          const chunk = (walker.currentNode.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (chunk) chunks.push(chunk);
        }
        const text = (chunks.join(' ').slice(0, 120) || node.getAttribute('placeholder') || '').trim().slice(0, 120);
        return [tag, type, name, aria, text].join('|').slice(0, 400);
      };
      if (keyFor(el) !== elementKey) throw new Error('browser_element_stale');
      if ('disabled' in el && el.disabled) throw new Error('element_disabled');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { clicked: elementIndex };
    }, [index, expectedKey, snapshot.url, PAGE_ELEMENT_SELECTOR]);

    latestSnapshot = null;
    return result;
  }

  if (tool === 'browser.type') {
    const tab = await selectedTab(args, { requireWeb: true, useSnapshot: true });
    const snapshot = requireCurrentSnapshot(args, tab);
    const index = Number(args.index);
    const expectedKey = String(args.elementKey || '');
    const value = String(args.text || '');
    if (!Number.isInteger(index) || index < 0 || !expectedKey) {
      throw new Error('browser_element_reference_required');
    }
    if (value.length > 20_000) throw new Error('text_too_long');

    latestSnapshot = null;
    const result = await execInTab(tab, typeIntoPageElement,
      [index, expectedKey, value, snapshot.url, PAGE_ELEMENT_SELECTOR]);
    return result;
  }

  if (tool === 'browser.scroll') {
    const tab = await selectedTab(args, { requireWeb: true, useSnapshot: true });
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
      connected: transportConnected,
      error: lastConnectionError,
    });
    return;
  }

  if (message?.type === 'mission-ai-reconnect') {
    if (nativePort) {
      try { nativePort.disconnect(); } catch {}
      nativePort = null;
    }
    if (directSocket) {
      const socket = directSocket;
      directSocket = null;
      socket.close();
    }
    connectNative();
    sendResponse({ ok: true });
    return;
  }
});

chrome.runtime.onInstalled.addListener(connectNative);
chrome.runtime.onStartup.addListener(connectNative);
connectNative();
