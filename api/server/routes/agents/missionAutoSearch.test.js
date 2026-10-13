const test = require('node:test');
const assert = require('node:assert/strict');
const { createMissionAutoSearch } = require('./missionAutoSearch');

const options = {
  enabled: true,
  ownerEmail: 'owner@example.test',
  gatewayURL: 'https://gateway.example/',
  token: 'test-token-abcdefghijklmnopqrstuvwxyz',
};
function request(text, changes = {}) {
  return { method: 'POST', originalUrl: '/api/agents/chat/MissionAI',
    user: { email: 'owner@example.test' },
    body: { endpoint: 'MissionAI', spec: 'mission-ai-free',
      model: 'gemini-3.5-flash-lite', text, ...changes } };
}
test('an explicit weather request gets one guarded basic search and cited context', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.method, 'POST');
    assert.equal(JSON.parse(init.body).maxResults, 3);
    assert.equal(JSON.parse(init.body).query, 'What is the weather today in Colorado Springs?');
    return { ok: true, json: async () => ({ provider: 'tavily', freeOnly: true,
      credits: 1, aiCalls: 0, results: [{ title: 'Forecast',
        url: 'https://weather.gov/forecast', content: 'Sunny and 70 F.' }] }) };
  } });
  const req = request('What is the weather today in Colorado Springs?');
  let next = 0;
  await handler(req, {}, () => { next++; });
  assert.equal(calls, 1);
  assert.equal(next, 1);
  assert.equal(req.body.text, 'What is the weather today in Colorado Springs?');
  assert.match(req.missionAutoSearchContext, /https:\/\/weather\.gov\/forecast/);
  assert.match(req.missionAutoSearchContext, /untrusted source excerpts/);
});

test('ordinary prompts, other users, paid models, and regenerations do not search', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async () => { calls++; } });
  for (const req of [request('Hello'), request('Search the web', { model: 'claude-sonnet-5-5' }),
    request('Search the web', { isRegenerate: true }),
    { ...request('Search the web'), user: { email: 'other@example.test' } }]) {
    const original = req.body.text;
    await handler(req, {}, () => {});
    assert.equal(req.body.text, original);
    assert.equal(req.missionAutoSearchContext, undefined);
  }
  assert.equal(calls, 0);
});

test('manual free Gemini 2.5 Flash uses the same guarded search', async () => {
  let calls = 0;
  const handler = createMissionAutoSearch({ ...options, fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ provider: 'tavily', freeOnly: true,
      credits: 1, aiCalls: 0, results: [{ title: 'Forecast',
        url: 'https://weather.gov/forecast', content: 'Sunny.' }] }) };
  } });
  const req = request('Search the web for the forecast',
    { spec: 'mission-ai-gemini25', model: 'gemini-2.5-flash' });
  await handler(req, {}, () => {});
  assert.equal(calls, 1);
  assert.equal(req.body.text, 'Search the web for the forecast');
  assert.match(req.missionAutoSearchContext, /weather\.gov/);
});

test('search failure is disclosed and never passed off as live evidence', async () => {
  const handler = createMissionAutoSearch({ ...options,
    fetchImpl: async () => ({ ok: false }) });
  const req = request('Search the web for the current forecast');
  await handler(req, {}, () => {});
  assert.equal(req.body.text, 'Search the web for the current forecast');
  assert.match(req.missionAutoSearchContext, /Live web search is unavailable/);
  assert.doesNotMatch(req.missionAutoSearchContext, /Live web results/);
});
