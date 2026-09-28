export const MAX_NATIVE_MESSAGE_BYTES = 1_000_000;

export function encodeNativeMessage(message, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > maxBytes) {
    throw new Error('native_message_size_invalid');
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function drainNativeFrames(buffer, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  let input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const messages = [];

  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length === 0 || length > maxBytes) {
      throw new Error('native_message_size_invalid');
    }
    if (input.length < 4 + length) break;

    const body = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);

    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error('native_message_json_invalid');
    }
    messages.push(message);
  }

  return { messages, remainder: input };
}

export function nativeReconnectDelayMs(attempt) {
  const count = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  return Math.min(30_000, 500 * (2 ** Math.min(count, 6)));
}
