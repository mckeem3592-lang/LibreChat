import assert from 'node:assert/strict';
import test from 'node:test';
import { createFreeSearch } from './generated/freeSearch.js';

const quota = (overrides = {}) => ({ key: { usage: 0, limit: 1000 },
  account: { current_plan: 'Researcher', plan_limit: 1000, plan_usage: 0, paygo_usage: 0, paygo_limit: null }, ...overrides });
function fixture(overrides = {}) {
  const calls = [];
  let accountUsed = 0; let keyUsed = 0; let uncertain = false;
  const deps = { enabled: () => true, freePlanVerified: () => true, apiKey: 'synthetic-key',
    creditStore: {
      async read() { if (uncertain) throw new Error('search_usage_uncertain'); return { accountUsed, keyUsed }; },
      async claim(input) { accountUsed = Math.max(accountUsed, input.accountUsed) + 1;
        keyUsed = Math.max(keyUsed, input.keyUsed) + 1; return 'synthetic-lease'; },
      async settle() {}, async lock() { uncertain = true; },
    },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () =>
      url.endsWith('/usage') ? quota() : { usage: { credits: 1 }, results: [
        { title: 'Synthetic source', url: 'https://example.test/source', content: 'Untrusted snippet' },
      ] } }; }, ...overrides };
  return { deps, calls, search: createFreeSearch(deps) };
}

test('only one-credit basic Tavily search follows verified free account/key usage; no AI, upgrade or scrape', async () => {
  const f = fixture();
  const result = await f.search.search({ query: 'Synthetic search' });
  assert.deepEqual(f.calls.map((call) => call.url), ['https://api.tavily.com/usage', 'https://api.tavily.com/search']);
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[1].init.redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { query: 'Synthetic search', max_results: 5, search_depth: 'basic',
    topic: 'general', auto_parameters: false, include_answer: false, include_images: false,
    include_raw_content: false, include_usage: true });
  assert.equal(result.freeOnly, true);
  assert.equal(result.aiCalls, 0);
  assert.equal(result.credits, 1);
  assert.equal(result.untrustedContent, true);
  assert.equal(result.remainingCredits, 999);
});

test('disabled search, absent credentials and absent PAYG-off proof do not contact any provider', async () => {
  for (const overrides of [{ enabled: () => false }, { freePlanVerified: () => false }, { apiKey: '' }]) {
    const f = fixture(overrides);
    await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_disabled|search_free_plan_unverified/);
    assert.deepEqual(f.calls, []);
  }
});

test('database errors remain private and block dispatch', async () => {
  const f = fixture({ creditStore: { async read() { throw new Error('SECRET connection details'); } } });
  await assert.rejects(f.search.search({ query: 'Synthetic search' }), error =>
    error.code === 'search_store_unready' && !error.message.includes('SECRET'));
  assert.deepEqual(f.calls, []);
});

test('paid/unknown plans, enabled PAYG, missing limits and exhausted accounts or keys never dispatch search', async () => {
  const variants = [
    quota({ account: { ...quota().account, current_plan: 'Bootstrap' } }),
    quota({ account: { ...quota().account, plan_limit: 15000 } }),
    quota({ account: { ...quota().account, paygo_usage: 1 } }),
    quota({ account: { ...quota().account, paygo_limit: 1 } }),
    quota({ account: { ...quota().account, paygo_limit: undefined } }),
    quota({ account: { ...quota().account, plan_usage: 1002 } }),
    quota({ account: { ...quota().account, plan_usage: '0' } }),
    quota({ key: { usage: 0, limit: null } }),
    quota({ key: { usage: 0, limit: 1001 } }),
    quota({ key: { usage: 1000, limit: 1000 } }),
  ];
  for (const report of variants) {
    let searches = 0;
    const f = fixture({ fetchImpl: async (url) => {
      if (url.endsWith('/search')) searches++;
      return { status: 200, json: async () => report };
    } });
    await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_/);
    assert.equal(searches, 0);
  }
});

test('callers cannot select advanced depth, provider, auto parameters, answer synthesis or override costs', async () => {
  for (const extra of [{ search_depth: 'advanced' }, { auto_parameters: true }, { include_answer: true },
    { provider: 'other' }, { credits: 0 }, { apiKey: 'override' }, { maxResults: 6 }, { maxResults: '1' }]) {
    const f = fixture();
    await assert.rejects(f.search.search({ query: 'Synthetic search', ...extra }), /search_input_invalid/);
    assert.deepEqual(f.calls, []);
  }
});

test('high-water credits refuse reuse of the last credit even when provider usage is delayed', async () => {
  let searches = 0;
  const f = fixture({ fetchImpl: async (url) => ({ status: 200, json: async () => {
    if (url.endsWith('/usage')) return quota({ account: { ...quota().account, plan_usage: 999 } });
    searches++; return { usage: { credits: 1 }, results: [] };
  } }) });
  await f.search.search({ query: 'Synthetic search' });
  await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_free_credits_exhausted/);
  assert.equal(searches, 1);
});

test('concurrent search cannot pass the same allowance check', async () => {
  let finish;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const f = fixture({ fetchImpl: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
  const first = f.search.search({ query: 'Synthetic search' });
  await waiting;
  await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_busy/);
  finish({ status: 200, json: async () => quota({ account: { ...quota().account, plan_usage: 1000 } }) });
  await assert.rejects(first, /search_free_credits_exhausted/);
});

test('unknown billing, upgraded credits or missing usage lock subsequent search without retries', async () => {
  for (const outcome of [{ status: 500 }, { status: 200, json: async () => ({ usage: { credits: 2 }, results: [] }) },
    { status: 200, json: async () => ({ results: [] }) }]) {
    let searches = 0;
    const f = fixture({ fetchImpl: async (url) => {
      if (url.endsWith('/usage')) return { status: 200, json: async () => quota() };
      searches++; return outcome;
    } });
    await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_/);
    await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_usage_uncertain/);
    assert.equal(searches, 1);
  }
});

test('unsafe result URLs never reach the caller', async () => {
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test/source', 'file:///private']) {
    const f = fixture({ fetchImpl: async (target) => ({ status: 200, json: async () => target.endsWith('/usage') ? quota() :
      { usage: { credits: 1 }, results: [{ title: 'Synthetic', content: 'Snippet', url }] } }) });
    await assert.rejects(f.search.search({ query: 'Synthetic search' }), /search_response_invalid/);
  }
});

test('a hanging usage body times out without ever spending a search credit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const f = fixture({ fetchImpl: async (_url, init) => { signal = init.signal; started(); return { status: 200, json: () => new Promise(() => {}) }; } });
  const pending = f.search.search({ query: 'Synthetic search' });
  await dispatched;
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, /search_provider_timeout/);
  assert.equal(signal.aborted, true);
});
