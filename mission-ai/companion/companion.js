import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
const GATEWAY_URL = process.env.MISSION_AI_GATEWAY_URL || '';
const DEVICE_TOKEN = process.env.MISSION_AI_DEVICE_TOKEN || '';
const BROWSER_TOKEN = process.env.MISSION_AI_BROWSER_TOKEN || '';
const DEVICE_ID = process.env.MISSION_AI_DEVICE_ID || 'mac-primary';
const BROWSER_PORT = Number(process.env.MISSION_AI_BROWSER_PORT || 8765);
const RECONNECT_MS = 3_000;
const MAX_MESSAGE_BYTES = 1_000_000;

if (!GATEWAY_URL || !DEVICE_TOKEN || !BROWSER_TOKEN) {
  throw new Error(
    'MISSION_AI_GATEWAY_URL, MISSION_AI_DEVICE_TOKEN, and MISSION_AI_BROWSER_TOKEN are required',
  );
}

const allowedApps = new Set(
  (process.env.MISSION_AI_ALLOWED_APPS || 'Google Chrome,Finder,Microsoft Excel,Microsoft Word')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

let extensionSocket = null;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function activeApp() {
  const { stdout } = await execFileAsync('osascript', [
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
  await execFileAsync('osascript', [
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
  await execFileAsync('osascript', [
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
  await execFileAsync('osascript', [
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

async function screenshot() {
  const file = `/tmp/mission-ai-${crypto.randomUUID()}.jpg`;
  try {
    await execFileAsync('screencapture', ['-x', '-t', 'jpg', file]);
    await execFileAsync('sips', ['-Z', '1600', file]);
    const bytes = await readFile(file);
    return { mimeType: 'image/jpeg', base64: bytes.toString('base64') };
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

async function dispatch(tool, args) {
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

const browserServer = http.createServer((req, res) => {
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
    if (extensionSocket === ws) extensionSocket = null;
  });
});

browserServer.listen(BROWSER_PORT, '127.0.0.1');

function connectGateway() {
  const base = GATEWAY_URL.replace(/^http/, 'ws').replace(/\/$/, '');
  const url = new URL(`${base}/device`);
  url.searchParams.set('deviceId', DEVICE_ID);
  url.searchParams.set('token', DEVICE_TOKEN);
  const ws = new WebSocket(url);

  ws.on('open', () => console.log('Mission AI companion connected'));
  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type !== 'tool' || typeof message.id !== 'string') return;
    try {
      const result = await dispatch(message.tool, message.args);
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
  ws.on('close', () => setTimeout(connectGateway, RECONNECT_MS));
  ws.on('error', () => ws.close());
}

connectGateway();
