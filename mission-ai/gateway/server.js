import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const DEVICE_TOKEN = process.env.MISSION_AI_DEVICE_TOKEN || '';
const TOOL_TOKEN = process.env.MISSION_AI_TOOL_TOKEN || '';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

if (!DEVICE_TOKEN || !TOOL_TOKEN) {
  throw new Error('MISSION_AI_DEVICE_TOKEN and MISSION_AI_TOOL_TOKEN are required');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const devices = new Map();
const pending = new Map();

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireToolAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(token, TOOL_TOKEN)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function getDevice(deviceId) {
  const socket = devices.get(deviceId);
  if (!socket || socket.readyState !== socket.OPEN) {
    const error = new Error('device_offline');
    error.statusCode = 503;
    throw error;
  }
  return socket;
}

function invoke(deviceId, tool, args = {}, requestedTimeoutMs) {
  const socket = getDevice(deviceId);
  const id = crypto.randomUUID();
  const timeoutMs = Math.min(
    Math.max(Number(requestedTimeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error('device_timeout');
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer, deviceId });
    socket.send(JSON.stringify({ type: 'tool', id, tool, args }));
  });
}

function finishPending(message, deviceId) {
  const item = pending.get(message.id);
  if (!item || item.deviceId !== deviceId) return;
  pending.delete(message.id);
  clearTimeout(item.timer);

  if (message.ok) {
    item.resolve(message.result);
  } else {
    const error = new Error(message.error || 'device_error');
    error.statusCode = 502;
    item.reject(error);
  }
}

function toolHandler(tool) {
  return async (req, res) => {
    try {
      const { deviceId = 'mac-primary', args = {}, timeoutMs } = req.body || {};
      const result = await invoke(deviceId, tool, args, timeoutMs);
      res.json({ ok: true, result });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: error.message });
    }
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    connectedDevices: [...devices.keys()],
    pendingCalls: pending.size,
  });
});

app.use('/v1', requireToolAuth);
app.post('/v1/browser/state', toolHandler('browser.get_state'));
app.post('/v1/browser/click', toolHandler('browser.click'));
app.post('/v1/browser/type', toolHandler('browser.type'));
app.post('/v1/browser/scroll', toolHandler('browser.scroll'));
app.post('/v1/browser/open-url', toolHandler('browser.open_url'));
app.post('/v1/mac/active-app', toolHandler('mac.active_app'));
app.post('/v1/mac/open-app', toolHandler('mac.open_app'));
app.post('/v1/mac/screenshot', toolHandler('mac.screenshot'));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/device') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token') || '';
  const deviceId = url.searchParams.get('deviceId') || '';
  if (!deviceId || !safeEqual(token, DEVICE_TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, deviceId);
  });
});

wss.on('connection', (ws, deviceId) => {
  const old = devices.get(deviceId);
  if (old && old !== ws) old.close(4001, 'replaced');
  devices.set(deviceId, ws);

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.type === 'tool_result' && typeof message.id === 'string') {
        finishPending(message, deviceId);
      }
    } catch {
      ws.close(1003, 'invalid_json');
    }
  });

  ws.on('close', () => {
    if (devices.get(deviceId) === ws) devices.delete(deviceId);
    for (const [id, item] of pending.entries()) {
      if (item.deviceId !== deviceId) continue;
      pending.delete(id);
      clearTimeout(item.timer);
      const error = new Error('device_disconnected');
      error.statusCode = 503;
      item.reject(error);
    }
  });

  ws.send(JSON.stringify({ type: 'hello', deviceId }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission AI gateway listening on :${PORT}`);
});
