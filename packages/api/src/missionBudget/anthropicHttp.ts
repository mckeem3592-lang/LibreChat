import { NativeBridgeError } from './native.js';

type Json = Record<string, unknown>;
interface Request { body?: unknown; query?: Record<string, unknown>; get(name: string): string | undefined }
interface Response {
  destroyed?: boolean; writableEnded?: boolean;
  status(code: number): Response; json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown; write(data: string): unknown; end(): unknown;
}
interface Dependencies {
  enabled: () => boolean; token: string; safeEqual: (left: string, right: string) => boolean;
  bridge: { handle(body: unknown, context?: { projectId?: unknown }): Promise<Json> };
}
function error(res: Response, status: number, code: string): unknown {
  return res.status(status).json({ type: 'error', error: { type: 'mission_budget_error', message: code } });
}

/** Buffered native SSE preserves signed blocks. Nothing is delivered before durable settlement. */
export function createAnthropicHttp(deps: Dependencies): {
  authorize(req: Request, res: Response, next: () => void): unknown;
  complete(req: Request, res: Response): Promise<unknown>;
  unsupported(req: Request, res: Response): unknown;
} {
  return {
    authorize(req, res, next) {
      if (!deps.enabled()) return error(res, 404, 'native_bridge_disabled');
      const token = req.get('x-api-key') ?? '';
      if (deps.token.length < 32 || !deps.safeEqual(token, deps.token)) return error(res, 401, 'unauthorized');
      if (Object.keys(req.query ?? {}).length) return error(res, 400, 'native_query_unsupported');
      next();
    },
    async complete(req, res) {
      try {
        const message = await deps.bridge.handle(req.body, { projectId: req.get('x-mission-ai-project') ?? undefined });
        if (res.destroyed || res.writableEnded) return;
        if ((req.body as Json).stream !== true) return res.json(message);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        const frame = (event: string, fields: Json): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...fields })}\n\n`);
        };
        const usage = message.usage as Json;
        frame('message_start', { message: { ...message, content: [], stop_reason: null,
          stop_sequence: null, stop_details: null, usage: { ...usage, output_tokens: 0 } } });
        for (const [index, value] of (message.content as Json[]).entries()) {
          const block = value;
          const start = block.type === 'text' ? { ...block, text: '' } : block.type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : block.type === 'tool_use' ? { ...block, input: {} } : block;
          frame('content_block_start', { index, content_block: start });
          if (block.type === 'text') frame('content_block_delta', { index,
            delta: { type: 'text_delta', text: block.text } });
          if (block.type === 'thinking') {
            frame('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
            frame('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
          }
          if (block.type === 'tool_use') frame('content_block_delta', { index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
          frame('content_block_stop', { index });
        }
        frame('message_delta', { delta: { stop_reason: message.stop_reason,
          stop_sequence: message.stop_sequence ?? null,
          ...(message.stop_details !== undefined ? { stop_details: message.stop_details } : {}) }, usage });
        frame('message_stop', {});
        return res.end();
      } catch (cause) {
        if (res.destroyed || res.writableEnded) return;
        return cause instanceof NativeBridgeError ? error(res, cause.status, cause.code)
          : error(res, 503, 'native_accounting_unready');
      }
    },
    unsupported(_req, res) { return error(res, 404, 'native_route_unsupported'); },
  };
}
