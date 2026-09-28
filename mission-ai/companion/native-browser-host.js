import { readSecret } from './keychain.js';
import WebSocket from 'ws';
import {
  drainNativeFrames,
  encodeNativeMessage,
  MAX_NATIVE_MESSAGE_BYTES,
  nativeReconnectDelayMs,
} from './native-message-framing.js';

const BROWSER_PORT = Number(process.env.MISSION_AI_BROWSER_PORT || 8766);
const LOOPBACK = `ws://127.0.0.1:${BROWSER_PORT}/browser`;
const MAX_MESSAGE_BYTES = MAX_NATIVE_MESSAGE_BYTES;

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopped = false;

function writeNative(message) {
  try {
    process.stdout.write(encodeNativeMessage(message, MAX_MESSAGE_BYTES));
  } catch {
    stopped = true;
    process.exitCode = 2;
  }
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
    const delay = nativeReconnectDelayMs(reconnectAttempt);
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
  let parsed;
  try {
    parsed = drainNativeFrames(stdinBuffer, MAX_MESSAGE_BYTES);
  } catch {
    stopped = true;
    process.exitCode = 2;
    try { socket?.close(); } catch {}
    return;
  }

  stdinBuffer = parsed.remainder;
  for (const message of parsed.messages) {
    if (message?.type === 'browser_result' && typeof message.id === 'string') {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    } else if (message?.type === 'ping') {
      writeNative({ type: 'status', connected: socket?.readyState === WebSocket.OPEN });
    }
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
