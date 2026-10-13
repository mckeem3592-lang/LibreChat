const test = require('node:test');
const assert = require('node:assert/strict');
const { createMissionAutoSearch } = require('./missionAutoSearch');

const options = { enabled: true, ownerEmail: 'owner@example.test', tavilyApiKey: '' };
function request(text, changes = {}) {
  return { method: 'POST', originalUrl: '/api/agents/chat/MissionAI',
    user: { email: 'owner@example.test' },
    body: { endpoint: 'MissionAI', spec: 'mission-ai-free',
      model: 'gemini-3.5-flash-lite', text, ...changes } };
}

test('live-data question injects bounded keyless results without changing user text', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.keenable.ai/v1/search/public');
    assert.equal(init.headers['X-Keenable-Title'], 'Mission AI LibreChat');
    assert.deepEqual(JSON.parse(init.body), { query: `Current weather in Colorado Springs? (as of ${new Date().toISOString().slice(0, 10)})`, max_results: 4 });
    return { ok: true, json: async () => ({ results: [
      { title: 'Forecast', url: 'https://weather.gov/forecast', snippet: 'Sunny and 70 F.' },
    ] }) };
  } });
  const req = request('Current weather in Colorado Springs?');
  await handler(req, {}, () => {});
  assert.equal(calls, 1);
  assert.equal(req.body.text, 'Current weather in Colorado Springs?');
  assert.match(req.missionAutoSearchContext, /https:\/\/weather\.gov\/forecast/);
});

test('time-relative sports questions trigger live search', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async (_url, init) => {
    calls++;
    assert.match(JSON.parse(init.body).query, /^who do the oregon ducks play [A-Z][a-z]+ \d{1,2}, \d{4}\? official schedule opponent$/);
    return { ok: true, json: async () => ({ results: [
      { title: 'Oregon schedule', url: 'https://goducks.com/sports/football/schedule/2026', snippet: 'Oct 17: Nebraska at Oregon.' },
    ] }) };
  } });
  const req = request('who do the oregon ducks play this weekend?');
  await handler(req, {}, () => {});
  assert.equal(calls, 1);
  assert.match(req.missionAutoSearchContext, /Nebraska at Oregon/);
});

test('shopping search and product follow-up both receive fresh results', async () => {
  const queries = [];
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async (_url, init) => {
    queries.push(JSON.parse(init.body).query);
    return { ok: true, json: async () => ({ results: [
      { title: 'Official product', url: 'https://bambulab.com/products/p2s', snippet: 'Bambu Lab P2S printer.' },
    ] }) };
  } });
  const first = request('Conduct a search for Bambu Labs X2D + AMS 2 Pro 3D printers. Any good sales going on?');
  const second = request('What about a P2S?');
  await handler(first, {}, () => {});
  await handler(second, {}, () => {});
  assert.equal(queries.length, 2);
  assert.match(queries[0], /X2D.*official store current price/);
  assert.match(queries[1], /^P2S official product current price sale \d{4}-\d{2}-\d{2}$/);
  assert.match(second.missionAutoSearchContext, /https:\/\/bambulab\.com\/products\/p2s/);
});

test('ordinary or paid prompts do not search; failed search is disclosed', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async () => {
    calls++;
    return { ok: false };
  } });
  for (const req of [request('Hello'), request('What about a private report?'), request('Search the web', { model: 'claude-sonnet-5-5' }),
    { ...request('Search the web'), user: { email: 'other@example.test' } }]) {
    await handler(req, {}, () => {});
    assert.equal(req.missionAutoSearchContext, undefined);
  }
  assert.equal(calls, 0);
  const live = request('Search the web for the latest forecast');
  await handler(live, {}, () => {});
  assert.equal(calls, 1);
  assert.match(live.missionAutoSearchContext, /Live web search is unavailable/);
});

test('Tavily basic search injects dated sources with one provider call', async () => {
  const requests = [];
  const handler = createMissionAutoSearch({ ...options, tavilyApiKey: 'tvly-test',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ results: [
        { title: 'Official product', url: 'https://example.com/product',
          content: 'Listed product', published_date: '2026-10-13' },
      ] }) };
    } });
  const req = request('What is the latest product price?');
  await handler(req, {}, () => {});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.tavily.com/search');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer tvly-test');
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.search_depth, 'basic');
  assert.equal(payload.include_answer, false);
  assert.equal(payload.include_raw_content, false);
  assert.match(req.missionAutoSearchContext, /Published: 2026-10-13/);
  assert.match(req.missionAutoSearchContext, /Tavily search excerpts/);
});

test('Tavily cap or outage falls back to keyless search', async () => {
  const urls = [];
  const handler = createMissionAutoSearch({ ...options, tavilyApiKey: 'tvly-test',
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('tavily')) return { ok: false, status: 432 };
      return { ok: true, json: async () => ({ results: [
        { title: 'Forecast', url: 'https://weather.gov/forecast', snippet: 'Sunny' },
      ] }) };
    } });
  const req = request('Current weather in Colorado Springs?');
  await handler(req, {}, () => {});
  assert.deepEqual(urls, ['https://api.tavily.com/search', 'https://api.keenable.ai/v1/search/public']);
  assert.match(req.missionAutoSearchContext, /Keenable search excerpts/);
});

test('manually selected paid model can receive free search context without changing its route', async () => {
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async () => ({
    ok: true, json: async () => ({ results: [
      { title: 'Current news', url: 'https://example.com/news', snippet: 'Today' },
    ] }),
  }) });
  const req = request('Latest news today?', {
    endpoint: 'MissionAIClaudeCached', spec: 'mission-ai-claude-sonnet',
    model: 'claude-sonnet-5-5',
  });
  req.originalUrl = '/api/agents/chat/MissionAIClaudeCached';
  await handler(req, {}, () => {});
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.match(req.missionAutoSearchContext, /Current news/);
});

test('explicit LibreChat web search avoids a duplicate automatic provider call', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, tavilyApiKey: 'tvly-test',
    fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  const req = request('Search the web for current news', { ephemeralAgent: { web_search: true } });
  await handler(req, {}, () => {});
  assert.equal(calls, 0);
  assert.equal(req.missionAutoSearchContext, undefined);
});

test('search context remains inside the agent instruction bound', async () => {
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async () => ({
    ok: true, json: async () => ({ results: Array.from({ length: 4 }, (_, i) => ({
      title: 'T'.repeat(120), url: 'https://example.com/' + 'x'.repeat(270) + i,
      snippet: 'S'.repeat(320), published_date: '2026-10-13',
    })) }),
  }) });
  const req = request('Current product prices?');
  await handler(req, {}, () => {});
  assert.ok(req.missionAutoSearchContext.length <= 3500);
});


test('AFC North standings and regenerated live questions search without a manual toggle', async () => {
  const queries = [];
  const handler = createMissionAutoSearch({ ...options, tavilyApiKey: 'tvly-test',
    fetchImpl: async (_url, init) => {
      queries.push(JSON.parse(init.body).query);
      return { ok: true, json: async () => ({ results: [
        { title: 'NFL standings', url: 'https://www.nfl.com/standings/',
          content: 'AFC North standings for the current season.' },
      ] }) };
    } });
  const first = request('Who is in the lead in the AFC North?');
  const retry = request('Who is in the lead in the AFC North?', { isRegenerate: true });
  await handler(first, {}, () => {});
  await handler(retry, {}, () => {});
  assert.equal(queries.length, 2);
  assert.match(queries[0], /official league standings schedule results/);
  assert.match(first.missionAutoSearchContext, /https:\/\/www\.nfl\.com\/standings\//);
  assert.match(first.missionAutoSearchContext, /Do not say you lack live access/);
});
