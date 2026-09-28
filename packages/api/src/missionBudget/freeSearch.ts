import type { FreeCreditStore } from './freeCredits.js';

type Json = Record<string, unknown>;
type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'json'>>;
interface Dependencies {
  enabled: () => boolean;
  /** Host must bind a fresh PAYG-off verification to this key; usage null alone is not proof. */
  freePlanVerified: () => boolean;
  apiKey: string;
  fetchImpl: Fetch;
  creditStore: FreeCreditStore;
}
export class FreeSearchError extends Error {
  constructor(public readonly code: string, public readonly status = 503) { super(code); }
}
function fail(code: string, status = 503): never { throw new FreeSearchError(code, status); }
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('search_usage_unverified');
  return value as Json;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('search_usage_unverified');
  return value;
}
function normalize(value: unknown): { query: string; maxResults: number } {
  const input = object(value);
  if (Object.keys(input).some((key) => !['query', 'maxResults'].includes(key)) ||
      typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000) {
    fail('search_input_invalid', 400);
  }
  const maxResults = input.maxResults ?? 5;
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 5) {
    fail('search_input_invalid', 400);
  }
  return { query: input.query.trim(), maxResults };
}

/** Tavily basic search only. No model synthesis, scraping, auto-upgrades, redirects or retries. */
export function createFreeSearch(deps: Dependencies) {
  let busy = false;
  let uncertain = false;
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof FreeSearchError) throw error;
      return fail('search_store_unready');
    }
  }
  async function json(path: 'usage' | 'search', body?: Json): Promise<Json> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await deps.fetchImpl(`https://api.tavily.com/${path}`, {
            method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${deps.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (response.status !== 200) fail('search_provider_unavailable');
          return object(await response.json());
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new FreeSearchError('search_provider_timeout')); }, 15_000);
        }),
      ]);
    } catch (error) {
      if (error instanceof FreeSearchError) throw error;
      return fail('search_provider_unavailable');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function status() {
    if (!deps.enabled()) fail('search_disabled');
    if (!deps.apiKey || !deps.freePlanVerified()) fail('search_free_plan_unverified');
    if (uncertain) fail('search_usage_uncertain');
    if (!deps.creditStore) fail('search_store_unready');
    const durable = await storage(() => deps.creditStore.read());
    const report = await json('usage');
    const account = object(report.account);
    const key = object(report.key);
    // A paid subscription is outside this feature even if its current usage is zero.
    if (account.current_plan !== 'Researcher' || count(account.plan_limit) !== 1000 ||
        count(account.paygo_usage) !== 0 ||
        (account.paygo_limit !== null && count(account.paygo_limit) !== 0)) fail('search_free_plan_unverified');
    const keyLimit = count(key.limit);
    if (keyLimit < 1 || keyLimit > 1000) fail('search_free_plan_unverified');
    const accountFloor = Math.max(count(durable.accountUsed), count(account.plan_usage));
    const keyFloor = Math.max(count(durable.keyUsed), count(key.usage));
    return { provider: 'tavily', freeOnly: true, aiCalls: 0, freeAllowance: 1000,
      accountUsed: accountFloor, keyUsed: keyFloor,
      keyLimit, remainingCredits: Math.max(0, Math.min(1000 - accountFloor, keyLimit - keyFloor)) };
  }
  return {
    status,
    async search(value: unknown) {
      const { query, maxResults } = normalize(value);
      if (busy) fail('search_busy', 409);
      busy = true;
      try {
        const quota = await status();
        if (quota.remainingCredits < 1) fail('search_free_credits_exhausted', 429);
        const lease = await storage(() => deps.creditStore.claim({ accountUsed: quota.accountUsed,
          keyUsed: quota.keyUsed, keyLimit: quota.keyLimit }));
        let result: Json;
        try {
          result = await json('search', { query, max_results: maxResults, search_depth: 'basic',
            topic: 'general', auto_parameters: false, include_answer: false, include_images: false,
            include_raw_content: false, include_usage: true });
          if (count(object(result.usage).credits) !== 1) fail('search_usage_unverified');
          await storage(() => deps.creditStore.settle(lease));
        } catch (error) {
          uncertain = true;
          try { await deps.creditStore.lock(lease); } catch { /* The durable pending hold already blocks admission. */ }
          throw error;
        }
        if (!Array.isArray(result.results) || result.results.length > maxResults) fail('search_response_invalid');
        const results = result.results.map((entry) => {
          const row = object(entry);
          if (typeof row.url !== 'string' || typeof row.title !== 'string' || typeof row.content !== 'string' ||
              row.title.length > 1000 || row.content.length > 20_000) fail('search_response_invalid');
          let url;
          try { url = new URL(row.url); } catch { fail('search_response_invalid'); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('search_response_invalid');
          return { title: row.title, url: url.href, content: row.content };
        });
        return { provider: 'tavily', freeOnly: true, credits: 1, aiCalls: 0,
          untrustedContent: true, results, remainingCredits: quota.remainingCredits - 1 };
      } finally { busy = false; }
    },
  };
}
