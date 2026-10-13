const test = require('node:test');
const assert = require('node:assert/strict');
const { createMissionAutoSearch } = require('./missionAutoSearch');

const options = { enabled: true, ownerEmail: 'owner@example.test' };
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
