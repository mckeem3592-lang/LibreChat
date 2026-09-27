import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { pairDevice } from './pairing.js';
import { providerStatus } from './providers.js';
import { handleRoute } from './route-handler.js';
import { buildReadiness } from './readiness.js';
import { queryMissionDashboard } from './mission-dashboard.js';
import { createMissionMcpNodeHandler } from './mcp.js';
import { fallbackPlan } from './fallbacks.js';
import { delegateRequest } from './delegate.js';
import { buildCostComparison, comparisonCsv } from './cost-comparison.js';
import { generateImage } from './image.js';

const PORT = Number(process.env.PORT || 8787);
const DEVICE_TOKEN = process.env.MISSION_AI_DEVICE_TOKEN || '';
const TOOL_TOKEN = process.env.MISSION_AI_TOOL_TOKEN || '';
const CODE_API_URL = (process.env.MISSION_AI_CODE_API_URL || '').replace(/\/$/, '');
const CODE_BRIDGE_ADMIN_TOKEN = process.env.MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN || '';
const CODE_WORKER_ID = process.env.MISSION_AI_CODE_WORKER_ID || 'mac-primary-code';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

if (!DEVICE_TOKEN || !TOOL_TOKEN) {
  throw new Error('MISSION_AI_DEVICE_TOKEN and MISSION_AI_TOOL_TOKEN are required');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

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
  if (!socket || socket.readyState !== WebSocket.OPEN) {
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

function currentReadiness() {
  const expiresAt = Date.parse(process.env.MISSION_AI_PAIR_EXPIRES_AT || '');
  const pairingConfigured =
    Boolean(process.env.MISSION_AI_PAIR_CODE) &&
    Number.isFinite(expiresAt) &&
    Date.now() <= expiresAt;

  return buildReadiness({
    providers: providerStatus(),
    connectedDevices: [...devices.keys()],
    codeApiConfigured: Boolean(CODE_API_URL && CODE_BRIDGE_ADMIN_TOKEN),
    costDashboardConfigured: Boolean(
      (process.env.MISSION_AI_MONGO_URI || process.env.MONGO_URI) &&
      process.env.MISSION_AI_LEDGER_MONGO_URI,
    ),
    delegationEnabled:
      String(process.env.MISSION_AI_DELEGATION_ENABLED || '').toLowerCase() === 'true' &&
      Boolean(process.env.MISSION_AI_MONGO_URI || process.env.MONGO_URI) &&
      Boolean(process.env.MISSION_AI_LEDGER_MONGO_URI) &&
      providerStatus().some(({ hasApiKey }) => Boolean(hasApiKey)),
    pairingConfigured,
    build: process.env.RENDER_GIT_COMMIT || process.env.BUILD_COMMIT || null,
  });
}

const missionMcp = createMissionMcpNodeHandler({
  invoke,
  getReadiness: currentReadiness,
  getDashboard: queryMissionDashboard,
  route: handleRoute,
  fallback: fallbackPlan,
  delegate: delegateRequest,
  getCostComparison: async () => buildCostComparison(await queryMissionDashboard()),
  generateImage,
});

app.use('/pair', express.json({ limit: '16kb' }));
app.use('/v1', requireToolAuth, express.json({ limit: '12mb' }));
app.use('/mcp', requireToolAuth, express.json({ limit: '12mb' }));

app.get('/health', (_req, res) => {
  const expiresAt = Date.parse(process.env.MISSION_AI_PAIR_EXPIRES_AT || '');
  res.json({
    ok: true,
    connectedDevices: [...devices.keys()],
    pendingCalls: pending.size,
    pairingAvailable:
      Boolean(process.env.MISSION_AI_PAIR_CODE) &&
      Number.isFinite(expiresAt) &&
      Date.now() <= expiresAt,
    build: process.env.RENDER_GIT_COMMIT || process.env.BUILD_COMMIT || null,
  });
});

async function issueCodeWorkerPairing() {
  if (!CODE_API_URL || !CODE_BRIDGE_ADMIN_TOKEN) return null;
  const response = await fetch(`${CODE_API_URL}/bridge/pairings`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CODE_BRIDGE_ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workerId: CODE_WORKER_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('code_worker_pairing_failed');
  const body = await response.json();
  if (!body?.code) throw new Error('code_worker_pairing_invalid');
  return {
    codeApiUrl: CODE_API_URL,
    workerId: CODE_WORKER_ID,
    code: body.code,
    expiresAt: body.expiresAt || null,
  };
}

app.post('/pair', async (req, res) => {
  try {
    const result = pairDevice({
      code: String(req.body?.code || ''),
      remoteAddress: req.ip || req.socket.remoteAddress || '',
    });
    let codeWorker = null;
    try {
      codeWorker = await issueCodeWorkerPairing();
    } catch {
      console.warn('Mission AI code-worker pairing was unavailable during device pairing');
    }
    console.log('Mission AI device paired');
    res.set('cache-control', 'no-store');
    res.json({ ok: true, ...result, codeWorker });
  } catch (error) {
    const status = error?.message === 'pair_rate_limited' ? 429 : 401;
    res.status(status).json({ ok: false, error: error.message });
  }
});

app.get('/v1/providers', (_req, res) => {
  res.json({ ok: true, providers: providerStatus() });
});

app.get('/v1/readiness', (_req, res) => {
  res.json({ ok: true, readiness: currentReadiness() });
});

app.get('/v1/dashboard', async (_req, res) => {
  res.set('cache-control', 'no-store');
  try {
    const dashboard = await queryMissionDashboard();
    res.json({ ok: true, dashboard });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'dashboard_unavailable';
    const status = code === 'mongo_not_configured' ? 503 : 502;
    res.status(status).json({
      ok: false,
      error: code === 'mongo_not_configured' ? code : 'dashboard_unavailable',
    });
  }
});

app.get('/v1/cost-comparison', async (req, res) => {
  res.set('cache-control', 'no-store');
  try {
    const comparison = buildCostComparison(await queryMissionDashboard());
    if (String(req.query?.format || '').toLowerCase() === 'csv') {
      res.type('text/csv').send(comparisonCsv(comparison));
      return;
    }
    res.json({ ok: true, comparison });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'comparison_unavailable';
    res.status(503).json({ ok: false, error: code });
  }
});

app.post('/v1/route', async (req, res) => {
  const result = await handleRoute(req.body || {});
  res.status(result.status).json(result.body);
});

app.get('/v1/fallback/:role', async (req, res) => {
  try {
    res.json({ ok: true, plan: await fallbackPlan(String(req.params.role || '')) });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'fallback_error',
    });
  }
});

app.post('/v1/image', async (req, res) => {
  try {
    res.set('cache-control', 'no-store');
    res.json(await generateImage(req.body || {}));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'image_error';
    const status =
      code === 'delegation_disabled' ? 503 :
      code === 'monthly_hard_limit' ? 402 :
      code === 'image_prompt_required' || code === 'image_config_invalid' ? 400 : 502;
    res.status(status).json({ ok: false, error: code });
  }
});

app.post('/v1/delegate', async (req, res) => {
  try {
    res.json(await delegateRequest(req.body || {}));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'delegation_error';
    const status =
      code === 'delegation_disabled' ? 503 :
      code === 'monthly_hard_limit' ? 402 :
      code === 'delegation_prompt_required' ? 400 : 502;
    res.status(status).json({ ok: false, error: code });
  }
});

app.post('/v1/browser/list-tabs', toolHandler('browser.list_tabs'));
app.post('/v1/browser/activate-tab', toolHandler('browser.activate_tab'));
app.post('/v1/browser/close-tabs', toolHandler('browser.close_tabs'));
app.post('/v1/browser/open-url-direct', toolHandler('browser.open_url_direct'));
app.post('/v1/browser/state', toolHandler('browser.get_state'));
app.post('/v1/browser/click', toolHandler('browser.click'));
app.post('/v1/browser/type', toolHandler('browser.type'));
app.post('/v1/browser/scroll', toolHandler('browser.scroll'));
app.post('/v1/browser/open-url', toolHandler('browser.open_url'));
app.post('/v1/mac/active-app', toolHandler('mac.active_app'));
app.post('/v1/mac/open-app', toolHandler('mac.open_app'));
app.post('/v1/mac/screenshot', toolHandler('mac.screenshot'));
app.post('/v1/mac/click', toolHandler('mac.click'));
app.post('/v1/mac/type', toolHandler('mac.type'));
app.post('/v1/mac/key', toolHandler('mac.key'));

app.all('/mcp', (req, res) => {
  void missionMcp(req, res, req.body);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/device') {
    socket.destroy();
    return;
  }

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
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
  console.log(`Mission AI device connected: ${deviceId}`);

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
    console.log(`Mission AI device disconnected: ${deviceId}`);
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

  if (
    deviceId === 'mac-primary' &&
    String(process.env.MISSION_AI_TAB_INVENTORY_ON_CONNECT || '').toLowerCase() === 'true'
  ) {
    setTimeout(() => {
      invoke(deviceId, 'browser.list_tabs', {}, 20_000)
        .then((result) => {
          console.log(`Mission AI tab inventory: ${JSON.stringify(result)}`);
        })
        .catch((error) => {
          console.warn(
            `Mission AI tab inventory failed: ${error instanceof Error ? error.message : 'unknown_error'}`,
          );
        });
    }, 1000);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const providers = Object.fromEntries(
    providerStatus().map(({ name, hasApiKey }) => [name, Boolean(hasApiKey)]),
  );
  console.log(`Mission AI gateway listening on :${PORT}`);
  console.log(
    `Mission AI readiness: providers=${JSON.stringify(providers)} codeApi=${Boolean(
      CODE_API_URL && CODE_BRIDGE_ADMIN_TOKEN,
    )} costDashboard=${Boolean(
      (process.env.MISSION_AI_MONGO_URI || process.env.MONGO_URI) &&
      process.env.MISSION_AI_LEDGER_MONGO_URI,
    )}`,
  );
});
