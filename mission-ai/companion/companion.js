import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import { readSecret, writeSecret } from './keychain.js';
import { normalizeMacControlError } from './permission-errors.js';
import { reconnectDelayMs } from './reconnect-policy.js';
import { requireManualApproval } from './approval-gate.js';
import {
  normalizeCloseTabRequest,
  parseChromeTabRows,
  validateActivateTab,
} from './direct-tabs.js';

const execFileAsync = promisify(execFile);
const GATEWAY_URL = process.env.MISSION_AI_GATEWAY_URL || '';
const DEVICE_TOKEN =
  process.env.MISSION_AI_DEVICE_TOKEN || (await readSecret('mission-ai-device-token'));
let BROWSER_TOKEN =
  process.env.MISSION_AI_BROWSER_TOKEN || (await readSecret('mission-ai-browser-token'));
if (!BROWSER_TOKEN) {
  BROWSER_TOKEN = crypto.randomBytes(32).toString('base64url');
  await writeSecret('mission-ai-browser-token', BROWSER_TOKEN);
}
const DEVICE_ID = process.env.MISSION_AI_DEVICE_ID || 'mac-primary';
const BROWSER_PORT = Number(process.env.MISSION_AI_BROWSER_PORT || 8766);
const MAX_MESSAGE_BYTES = 1_000_000;

if (!GATEWAY_URL || !DEVICE_TOKEN) {
  throw new Error('MISSION_AI_GATEWAY_URL and a paired Mission AI device credential are required');
}

const allowedApps = new Set(
  (process.env.MISSION_AI_ALLOWED_APPS || 'Google Chrome,Finder,Microsoft Excel,Microsoft Word')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

let extensionSocket = null;
let gatewaySocket = null;
let gatewayConnected = false;
let reconnectAttempt = 0;
let reconnectTimer = null;

function currentCapabilities() {
  return [
    'mac.control',
    'browser.direct_tabs',
    ...(extensionSocket?.readyState === WebSocket.OPEN ? ['browser.page_extension'] : []),
  ];
}

function publishCapabilities() {
  if (!gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) return;
  gatewaySocket.send(
    JSON.stringify({
      type: 'device_capabilities',
      capabilities: currentCapabilities(),
    }),
  );
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function runAccessibilityScript(args) {
  try {
    return await execFileAsync('osascript', args);
  } catch (error) {
    throw normalizeMacControlError('accessibility', error);
  }
}

async function activeApp() {
  const { stdout } = await runAccessibilityScript([
    '-e',
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
  return { name: stdout.trim() };
}

async function openApp(args) {
  const name = String(args?.name || '');
  if (!allowedApps.has(name)) throw new Error('app_not_allowed');
  await execFileAsync('open', ['-a', name]);
  return { opened: name };
}

async function clickMac(args) {
  const x = Number(args?.x);
  const y = Number(args?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) {
    throw new Error('invalid_coordinates');
  }
  await runAccessibilityScript([
    '-e',
    'on run argv',
    '-e',
    'tell application "System Events" to click at {(item 1 of argv as integer), (item 2 of argv as integer)}',
    '-e',
    'end run',
    String(Math.round(x)),
    String(Math.round(y)),
  ]);
  return { clicked: { x: Math.round(x), y: Math.round(y) } };
}

async function typeMac(args) {
  const text = String(args?.text ?? '');
  if (text.length > 20_000) throw new Error('text_too_long');
  await runAccessibilityScript([
    '-e',
    'on run argv',
    '-e',
    'tell application "System Events" to keystroke (item 1 of argv)',
    '-e',
    'end run',
    text,
  ]);
  return { typedLength: text.length };
}

async function keyMac(args) {
  const key = String(args?.key || '').toLowerCase();
  const keyCodes = new Map([
    ['return', 36], ['enter', 36], ['tab', 48], ['escape', 53],
    ['left', 123], ['right', 124], ['down', 125], ['up', 126],
    ['pagedown', 121], ['pageup', 116], ['delete', 51],
  ]);
  const code = keyCodes.get(key);
  if (code == null) throw new Error('key_not_allowed');
  await runAccessibilityScript([
    '-e',
    'on run argv',
    '-e',
    'tell application "System Events" to key code (item 1 of argv as integer)',
    '-e',
    'end run',
    String(code),
  ]);
  return { key };
}

async function chromeListTabs() {
  const script = [
    '-e', 'tell application "Google Chrome"',
    '-e', 'set output to ""',
    '-e', 'repeat with w from 1 to count of windows',
    '-e', 'set win to window w',
    '-e', 'set windowId to id of win as text',
    '-e', 'set activeT to active tab index of win',
    '-e', 'set tabCount to count of tabs of win',
    '-e', 'repeat with t from 1 to tabCount',
    '-e', 'set theTab to tab t of win',
    '-e', 'set tabId to id of theTab as text',
    '-e', 'set isActive to "0"',
    '-e', 'if t is activeT then set isActive to "1"',
    '-e', 'set output to output & windowId & "\\t" & tabId & "\\t" & w & "\\t" & t & "\\t" & isActive & "\\t" & (title of theTab) & "\\t" & (URL of theTab) & linefeed',
    '-e', 'end repeat',
    '-e', 'end repeat',
    '-e', 'return output',
    '-e', 'end tell',
  ];
  const { stdout } = await execFileAsync('osascript', script);
  return { tabs: parseChromeTabRows(stdout) };
}

async function chromeActivateTab(args) {
  const { windowId, tabId } = validateActivateTab(args);

  await execFileAsync('osascript', [
    '-e', 'on run argv',
    '-e', 'set targetWindowId to item 1 of argv',
    '-e', 'set targetTabId to item 2 of argv',
    '-e', 'tell application "Google Chrome"',
    '-e', 'set targetWindow to missing value',
    '-e', 'repeat with win in windows',
    '-e', 'if (id of win as text) is targetWindowId then set targetWindow to win',
    '-e', 'end repeat',
    '-e', 'if targetWindow is missing value then error "window_not_found"',
    '-e', 'set foundIndex to 0',
    '-e', 'repeat with t from 1 to count of tabs of targetWindow',
    '-e', 'if (id of tab t of targetWindow as text) is targetTabId then set foundIndex to t',
    '-e', 'end repeat',
    '-e', 'if foundIndex is 0 then error "tab_not_found"',
    '-e', 'set active tab index of targetWindow to foundIndex',
    '-e', 'set index of targetWindow to 1',
    '-e', 'activate',
    '-e', 'end tell',
    '-e', 'end run',
    windowId,
    tabId,
  ]);

  return { windowId, tabId };
}

async function chromeCloseTabs(args) {
  const requested = normalizeCloseTabRequest(args);
  let closed = 0;

  for (const item of requested) {
    const { windowId, tabId, expectedUrl } = item;

    await execFileAsync('osascript', [
      '-e', 'on run argv',
      '-e', 'set targetWindowId to item 1 of argv',
      '-e', 'set targetTabId to item 2 of argv',
      '-e', 'set expectedUrl to item 3 of argv',
      '-e', 'tell application "Google Chrome"',
      '-e', 'set targetWindow to missing value',
      '-e', 'repeat with win in windows',
      '-e', 'if (id of win as text) is targetWindowId then set targetWindow to win',
      '-e', 'end repeat',
      '-e', 'if targetWindow is missing value then error "window_not_found"',
      '-e', 'set targetTab to missing value',
      '-e', 'repeat with candidateTab in tabs of targetWindow',
      '-e', 'if (id of candidateTab as text) is targetTabId then set targetTab to candidateTab',
      '-e', 'end repeat',
      '-e', 'if targetTab is missing value then error "tab_not_found"',
      '-e', 'if (URL of targetTab as text) is not expectedUrl then error "tab_stale"',
      '-e', 'close targetTab',
      '-e', 'end tell',
      '-e', 'end run',
      windowId,
      tabId,
      expectedUrl,
    ]);
    closed += 1;
  }
  return { closed };
}

async function chromeOpenUrl(args) {
  const url = new URL(String(args?.url || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url_not_allowed');
  await execFileAsync('osascript', [
    '-e', 'on run argv',
    '-e', 'set targetUrl to item 1 of argv',
    '-e', 'tell application "Google Chrome"',
    '-e', 'activate',
    '-e', 'if (count of windows) = 0 then make new window',
    '-e', 'tell front window to make new tab at end of tabs with properties {URL:targetUrl}',
    '-e', 'end tell',
    '-e', 'end run',
    url.toString(),
  ]);
  return { url: url.toString() };
}

async function screenshot() {
  const file = `/tmp/mission-ai-${crypto.randomUUID()}.jpg`;
  try {
    await execFileAsync('screencapture', ['-x', '-t', 'jpg', file]);
    await execFileAsync('sips', ['-Z', '1600', file]);
    const bytes = await readFile(file);
    return { mimeType: 'image/jpeg', base64: bytes.toString('base64') };
  } catch (error) {
    throw normalizeMacControlError('screen-recording', error);
  } finally {
    await unlink(file).catch(() => {});
  }
}

function requireBrowser() {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error('browser_extension_offline');
  }
  return extensionSocket;
}

const browserPending = new Map();

function callBrowser(tool, args = {}) {
  const socket = requireBrowser();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browserPending.delete(id);
      reject(new Error('browser_timeout'));
    }, 20_000);
    browserPending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: 'browser_tool', id, tool, args }));
  });
}

async function dispatch(tool, args, deadlineMs) {
  // Execute the same immutable arguments shown in the local preview.
  args = structuredClone(args || {});
  await requireManualApproval(tool, args, {
    deadlineMs,
    isConnected: () => gatewayConnected && gatewaySocket?.readyState === WebSocket.OPEN,
  });
  switch (tool) {
    case 'mac.active_app':
      return await activeApp();
    case 'mac.open_app':
      return await openApp(args);
    case 'mac.screenshot':
      return await screenshot();
    case 'mac.click':
      return await clickMac(args);
    case 'mac.type':
      return await typeMac(args);
    case 'mac.key':
      return await keyMac(args);
    case 'browser.list_tabs':
      return await chromeListTabs();
    case 'browser.activate_tab':
      return await chromeActivateTab(args);
    case 'browser.close_tabs':
      return await chromeCloseTabs(args);
    case 'browser.open_url_direct':
    case 'browser.open_new_tab':
      return await chromeOpenUrl(args);
    case 'browser.get_state':
    case 'browser.click':
    case 'browser.type':
    case 'browser.scroll':
    case 'browser.open_url':
      return await callBrowser(tool, args);
    default:
      throw new Error('tool_not_allowed');
  }
}

const browserServer = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress;
  const loopback = remote === '127.0.0.1' || remote === '::1';
  const origin = String(req.headers.origin || '');
  const extensionOrigin =
    origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
  const auth = String(req.headers.authorization || '');
  const healthToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (
    req.method === 'GET' &&
    req.url === '/health' &&
    loopback &&
    safeEqual(healthToken, BROWSER_TOKEN)
  ) {
    const accessibility = await activeApp()
      .then(() => ({ ok: true }))
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'accessibility_error',
      }));
    const screenRecording = await screenshot()
      .then(() => ({ ok: true }))
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'screen_recording_error',
      }));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        deviceId: DEVICE_ID,
        gatewayConnected,
        extensionConnected:
          Boolean(extensionSocket) && extensionSocket.readyState === WebSocket.OPEN,
        accessibility,
        screenRecording,
      }),
    );
    return;
  }

  if (
    req.method === 'GET' &&
    req.url === '/browser/pair' &&
    loopback &&
    extensionOrigin
  ) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, browserToken: BROWSER_TOKEN }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const browserWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

browserServer.on('upgrade', (req, socket, head) => {
  if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
    socket.destroy();
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/browser' || !safeEqual(url.searchParams.get('token') || '', BROWSER_TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit('connection', ws));
});

browserWss.on('connection', (ws) => {
  if (extensionSocket && extensionSocket !== ws) extensionSocket.close(4001, 'replaced');
  extensionSocket = ws;
  publishCapabilities();
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.type !== 'browser_result' || typeof message.id !== 'string') return;
      const pending = browserPending.get(message.id);
      if (!pending) return;
      browserPending.delete(message.id);
      clearTimeout(pending.timer);
      message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error));
    } catch {
      ws.close(1003, 'invalid_json');
    }
  });
  ws.on('close', () => {
    if (extensionSocket === ws) {
      extensionSocket = null;
      publishCapabilities();
    }
  });
});

browserServer.listen(BROWSER_PORT, '127.0.0.1');

function connectGateway() {
  const base = GATEWAY_URL.replace(/^http/, 'ws').replace(/\/$/, '');
  const url = new URL(`${base}/device`);
  url.searchParams.set('deviceId', DEVICE_ID);
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  });

  ws.on('open', () => {
    gatewaySocket = ws;
    gatewayConnected = true;
    reconnectAttempt = 0;
    publishCapabilities();
    console.log('Mission AI companion connected');
  });
  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type !== 'tool' || typeof message.id !== 'string') return;
    try {
      const result = await dispatch(message.tool, message.args, message.deadlineMs);
      ws.send(JSON.stringify({ type: 'tool_result', id: message.id, ok: true, result }));
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'tool_result',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
    }
  });
  ws.on('close', () => {
    if (gatewaySocket === ws) gatewaySocket = null;
    gatewayConnected = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = reconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectGateway();
    }, delay);
  });
  ws.on('error', () => ws.close());
}

connectGateway();
