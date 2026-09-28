import { readSecret } from './keychain.js';
import WebSocket from 'ws';

const BROWSER_PORT = Number(process.env.MISSION_AI_BROWSER_PORT || 8766);
const LOOPBACK = `ws://127.0.0.1:${BROWSER_PORT}/browser`;
const MAX_MESSAGE_BYTES = 1_000_000;

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopped = false;

function writeNative(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_MESSAGE_BYTES) return;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

function reconnectDelay(attempt) {
  return Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
}

async function connect() {
  if (stopped) return;
  const token = await readSecret('mission-ai-browser-token');
  if (!token) {
    writeNative({ type: 'status', connected: false, error: 'browser_credential_missing' });
    return;
  }

  const ws = new WebSocket(`${LOOPBACK}?token=${encodeURIComponent(token)}`, {
    maxPayload: MAX_MESSAGE_BYTES,
  });
  socket = ws;

  ws.on('open', () => {
    reconnectAttempt = 0;
    writeNative({ type: 'status', connected: true });
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type === 'browser_tool' && typeof message.id === 'string') {
      writeNative(message);
    }
  });

  ws.on('close', () => {
    if (socket === ws) socket = null;
    writeNative({ type: 'status', connected: false, error: 'companion_disconnected' });
    if (stopped) return;
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  });

  ws.on('error', () => {
    try { ws.close(); } catch {}
  });
}

let stdinBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (length < 0 || length > MAX_MESSAGE_BYTES) {
      stopped = true;
      process.exit(2);
      return;
    }
    if (stdinBuffer.length < 4 + length) return;
    const body = stdinBuffer.subarray(4, 4 + length);
    stdinBuffer = stdinBuffer.subarray(4 + length);
    try {
      const message = JSON.parse(body.toString('utf8'));
      if (message?.type === 'browser_result' && typeof message.id === 'string') {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      } else if (message?.type === 'ping') {
        writeNative({ type: 'status', connected: socket?.readyState === WebSocket.OPEN });
      }
    } catch {}
  }
});

process.stdin.on('end', () => {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { socket?.close(); } catch {}
  process.exit(0);
});

process.stdout.on('error', () => {
  stopped = true;
  process.exit(0);
});

await connect();
