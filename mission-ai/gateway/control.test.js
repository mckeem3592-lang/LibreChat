import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissionControlProxy, createMissionControlHttp } from './generated/control.js';

const token = 'synthetic-control-token-not-a-real-secret';
function response() {
  return { code: 200, headers: {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return body; }, setHeader(key, value) { this.headers[key] = value; } };
}
function request(path = '/api/mission-ai/status', method = 'GET') {
  return { originalUrl: path, method, user: { email: 'owner@example.test' },
    body: { query: 'local fixture', maxResults: 5 }, get: () => 'https://chat.example.test' };
}
function proxy(overrides = {}) {
  const calls = [];
  const handler = createMissionControlProxy({ enabled: true, ownerEmail: 'owner@example.test',
    chatOrigin: 'https://chat.example.test', gatewayURL: 'https://gateway.example.test', token,
    fetchImpl: async (...args) => { calls.push(args); return { status: 200, json: async () => ({ enabled: true }) }; },
    ...overrides });
  return { calls, handler };
}
test('owner-only capabilities do not contact a provider or gateway', async () => {
  const { calls, handler } = proxy(); const res = response();
  await handler(request('/api/mission-ai/capabilities'), res);
  assert.deepEqual(res.body, { enabled: true }); assert.equal(calls.length, 0);
  for (const user of [undefined, { email: 'other@example.test' }]) {
    const denied = response(); await handler({ ...request(), user }, denied);
    assert.equal(denied.code, 403); assert.equal(calls.length, 0);
  }
});
test('disabled original deployment and unknown routes cannot reach the gateway', async () => {
  const off = proxy({ enabled: false }); const res = response();
  await off.handler(request(), res); assert.equal(res.code, 404); assert.equal(off.calls.length, 0);
  const { calls, handler } = proxy();
  for (const [path, method] of [['/api/mission-ai/status?token=x', 'GET'], ['/api/mission-ai/image', 'POST'],
    ['/api/mission-ai/search', 'GET'], ['/api/mission-ai/status', 'DELETE']]) {
    const denied = response(); await handler(request(path, method), denied); assert.equal(denied.code, 404);
  }
  assert.equal(calls.length, 0);
});
test('search requires the exact chat origin and rejects caller-selected routes/options', async () => {
  const { calls, handler } = proxy();
  for (const req of [{ ...request('/api/mission-ai/search', 'POST'), get: () => 'https://evil.example.test' },
    { ...request('/api/mission-ai/search', 'POST'), body: { query: 'q', searchDepth: 'advanced' } }]) {
    const res = response(); await handler(req, res); assert.ok([400, 403].includes(res.code));
  }
  assert.equal(calls.length, 0);
  const res = response(); await handler(request('/api/mission-ai/search', 'POST'), res);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'https://gateway.example.test/native/control/search');
  assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0][1].body), { query: 'local fixture', maxResults: 5 });
  assert.ok(!JSON.stringify(res.body).includes(token));
});
test('an unavailable gateway is called once, with private errors replaced', async () => {
  let calls = 0;
  const { handler } = proxy({ fetchImpl: async () => { calls++; throw new Error(token); } });
  const res = response(); await handler(request(), res);
  assert.equal(calls, 1); assert.equal(res.code, 503);
  assert.deepEqual(res.body, { error: { code: 'control_unavailable' } });
});
test('gateway control authentication works while paid chat stays off', async () => {
  let reads = 0;
  const http = createMissionControlHttp({ token, safeEqual: (a, b) => a === b,
    dashboard: async () => { reads++; return { spendUsd: .069006775, reservedUsd: 0, projectedSpendUsd: .069006775,
      targetUsd: 100, economyUsd: 125, hardUsd: 175, privateDetail: token }; },
    flags: () => ({ paidText: false, delegation: false, images: false, freeSearch: false }), search: async () => { throw new Error(); } });
  for (const header of ['', 'Bearer wrong']) {
    const res = response(); let next = 0;
    http.authorize({ get: () => header }, res, () => next++);
    assert.equal(res.code, 401); assert.equal(next, 0); assert.equal(reads, 0);
  }
  const res = response(); let next = 0;
  http.authorize({ get: () => `Bearer ${token}` }, res, () => next++);
  assert.equal(next, 1); await http.status({}, res);
  assert.equal(res.body.flags.paidText, false); assert.equal(res.body.automaticFallbacks, false);
  assert.equal(res.body.legacyIncluded, false); assert.ok(!JSON.stringify(res.body).includes(token));
});
test('free search exhaustion remains a 429 with no paid operation or fallback', async () => {
  let calls = 0;
  const http = createMissionControlHttp({ token, safeEqual: (a, b) => a === b,
    dashboard: async () => ({}), flags: () => ({}),
    search: async () => { calls++; throw Object.assign(new Error('private detail'), { code: 'search_free_credits_exhausted', status: 429 }); } });
  const res = response(); await http.search({ body: { query: 'fixture' } }, res);
  assert.equal(calls, 1); assert.equal(res.code, 429);
  assert.deepEqual(res.body, { error: { code: 'search_free_credits_exhausted' } });
});

test('cost-report response retains only bounded reporting fields, including estimates and unallocated corrections', async () => {
  const periods = { asOf: '2026-10-01T18:00:00Z', dayStart: '2026-10-01T06:00:00Z',
    weekStart: '2026-09-28T06:00:00Z', monthStart: '2026-10-01T06:00:00Z',
    timeZone: 'America/Denver', weekStartsOn: 'Monday', todayUsd: .1, weekUsd: .3,
    todayEstimatedUsd: .1, weekEstimatedUsd: .1, monthUnallocatedUsd: .04, privateDetail: token };
  const base = { spendUsd: .1, reservedUsd: 0, projectedSpendUsd: .1, targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  let report = { ...base, periods, byProvider: [{ provider: 'anthropic', spendUsd: .1, privateDetail: token }] };
  const http = createMissionControlHttp({ token, safeEqual: (a, b) => a === b,
    dashboard: async () => report, flags: () => ({}), search: async () => assert.fail() });
  const res = response(); await http.status({}, res);
  assert.equal(res.code, 200); assert.equal(res.body.periods.weekUsd, .3);
  assert.deepEqual(res.body.byProvider, [{ provider: 'anthropic', spendUsd: .1 }]);
  assert.ok(!JSON.stringify(res.body).includes(token));
  for (const change of [{ todayUsd: NaN }, { weekEstimatedUsd: .4 }, { timeZone: 'invalid' }]) {
    report = { ...base, periods: { ...periods, ...change } };
    const denied = response(); await http.status({}, denied); assert.equal(denied.code, 503);
  }
  report = { ...base, byProvider: [{ provider: 'bad', spendUsd: -1 }] };
  const denied = response(); await http.status({}, denied); assert.equal(denied.code, 503);
});
