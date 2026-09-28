import { NativeBridgeError } from './native.js';

type Json = Record<string, unknown>;
interface Request {
  body?: unknown;
  query?: Record<string, unknown>;
  get(name: string): string | undefined;
}
interface Response {
  destroyed?: boolean;
  writableEnded?: boolean;
  status(code: number): Response;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  write(data: string): unknown;
  end(): unknown;
}
interface Dependencies {
  enabled: () => boolean;
  token: string;
  safeEqual: (left: string, right: string) => boolean;
  models: () => Promise<string[]>;
  bridge: { handle(body: unknown): Promise<Json> };
}

function error(res: Response, status: number, code: string): unknown {
  return res.status(status).json({ error: { message: code, type: 'mission_budget_error', code } });
}

/** Only chat completions and model discovery are exposed. Accounting completes before delivery. */
export function createNativeHttp(deps: Dependencies) {
  return {
    authorize(req: Request, res: Response, next: () => void): unknown {
      if (!deps.enabled()) return error(res, 404, 'native_bridge_disabled');
      const auth = req.get('authorization') ?? '';
      if (deps.token.length < 32 || !auth.startsWith('Bearer ') ||
          !deps.safeEqual(auth.slice(7), deps.token)) return error(res, 401, 'unauthorized');
      if (Object.keys(req.query ?? {}).length) return error(res, 400, 'native_query_unsupported');
      next();
    },
    async models(_req: Request, res: Response): Promise<unknown> {
      try {
        return res.json({ object: 'list', data: (await deps.models()).map((id) => ({
          id, object: 'model', created: 0, owned_by: 'mission-ai',
        })) });
      } catch {
        return error(res, 503, 'native_models_unready');
      }
    },
    async complete(req: Request, res: Response): Promise<unknown> {
      try {
        const result = await deps.bridge.handle(req.body);
        // Client disconnects cannot cancel or release an already dispatched charge.
        if (res.destroyed || res.writableEnded) return;
        const body = req.body as Json;
        if (body.stream !== true) return res.json(result);
        const choices = result.choices as { message: Json; finish_reason: string }[];
        const message = choices[0].message;
        const toolCalls = message.tool_calls as Json[] | undefined;
        const base = {
          id: result.id, object: 'chat.completion.chunk', created: result.created,
          model: result.model, service_tier: result.service_tier,
        };
        const delta = { ...message, ...(toolCalls ? {
          tool_calls: toolCalls.map((call, index) => ({ ...call, index })),
        } : {}) };
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }], usage: null })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choices[0].finish_reason }], usage: null })}\n\n`);
        if ((body.stream_options as Json | undefined)?.include_usage === true) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: result.usage })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      } catch (cause) {
        if (res.destroyed || res.writableEnded) return;
        return cause instanceof NativeBridgeError
          ? error(res, cause.status, cause.code)
          : error(res, 503, 'native_accounting_unready');
      }
    },
    unsupported(_req: Request, res: Response): unknown {
      return error(res, 404, 'native_route_unsupported');
    },
  };
}
