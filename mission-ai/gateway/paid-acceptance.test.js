import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runPaidAcceptance } from './paid-acceptance.js';
import { createMemoryUsageLedger } from './usage-ledger.js';

process.env.OPENAI_API_KEY = 'test-paid-acceptance-key';
delete process.env.OPENAI_API_BASE_URL;

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE = 'a'.repeat(40);
const NOW = new Date('2026-09-28T18:00:00Z');
const PRICING = { verifiedOn: '2026-09-27', models: {
  'gpt-6-luna': { provider: 'openai', input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125 },
} };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  async json() { return body; } });

function fixture() {
  const events = new Map();
  const claims = new Map();
  const requests = [];
  const baseLedger = createMemoryUsageLedger();
  const ledger = {
    ...baseLedger,
    async reserve(args) {
      const result = await baseLedger.reserve(args);
      events.set(args.reservationId, { reservationId: args.reservationId, status: 'reserved',
        reservedUsd: args.reserveUsd, metadata: args.metadata });
      return result;
    },
    async settle(args) {
      const result = await baseLedger.settle(args);
      Object.assign(events.get(args.reservationId), { status: 'settled', actualUsd: args.actualUsd,
        usage: args.usage });
      return result;
    },
    async release(args) {
      const result = await baseLedger.release(args);
      Object.assign(events.get(args.reservationId), { status: 'released' });
      return result;
    },
  };
  const store = {
    async claim(record) {
      if (claims.has(record._id)) throw Object.assign(new Error('duplicate'), {
        acceptanceCode: 'acceptance_already_claimed',
      });
      claims.set(record._id, { ...record });
    },
    async markDispatch(id, reservationId) {
      const claim = claims.get(id);
      assert.equal(claim.stage, 'claimed');
      assert.equal(events.get(reservationId).status, 'reserved');
      Object.assign(claim, { stage: 'dispatch_started', reservationId });
    },
    async complete(id, result) { Object.assign(claims.get(id), { stage: 'finished', result }); },
    async readEvent(id) { return events.get(id); },
  };
  const options = {
    approvedRunId: RUN_ID, approvedModel: 'gpt-6-luna',
    approvedPricingDate: PRICING.verifiedOn, approvedSourceSha: SOURCE, now: NOW,
    env: { MISSION_AI_DELEGATION_ENABLED: 'false',
      MISSION_AI_LEDGER_MONGO_URI: 'mongodb://ledger-test-only', MISSION_AI_LEDGER_DB: 'MissionAI',
      MISSION_AI_MONGO_URI: 'mongodb://reader-test-only', OPENAI_API_KEY: 'test-paid-acceptance-key',
      RENDER_GIT_COMMIT: SOURCE,
    },
    dashboardReader: async () => ({ spendUsd: 0, targetUsd: 100, economyUsd: 125,
      hardUsd: 175, timeZone: 'America/Denver' }),
    pricingLoader: async () => PRICING,
    catalogLoader: async () => ({ providers: { openai: { economy: 'gpt-6-luna' } } }),
    usageLedger: ledger, claimStore: store,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(claims.get(RUN_ID).stage, 'dispatch_started');
      return response({ model: 'gpt-6-luna', service_tier: 'default', output_text: 'PRIVATE_OUTPUT_NEVER_LOG',
        usage: { input_tokens: 10, output_tokens: 2 } });
    },
  };
  return { options, events, claims, requests, ledger, store };
}

test('one approved economy request reserves five cents, sends 128 tokens, and proves actual settlement', async () => {
  const f = fixture();
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'PASS_ACTUAL');
  assert.equal(result.requestCount, 1);
  assert.ok(Math.abs(result.actualUsd - 0.000002) < 1e-12);
  assert.equal(result.estimated, false);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(f.requests[0].options.body).max_output_tokens, 128);
  assert.equal(JSON.parse(f.requests[0].options.body).service_tier, 'default');
  assert.equal(result.serviceTier, 'default');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.ok(f.requests[0].options.signal instanceof AbortSignal);
  assert.equal(f.events.get(`paid-acceptance:${RUN_ID}`).reservedUsd, 0.05);
  assert.equal(f.options.env.MISSION_AI_DELEGATION_ENABLED, 'false');
  const logged = JSON.stringify(result) + JSON.stringify([...f.claims.values()]);
  for (const privateText of ['PRIVATE_OUTPUT_NEVER_LOG', 'Reply only with OK.', 'test-paid-acceptance-key', 'mongodb://']) {
    assert.equal(logged.includes(privateText), false);
  }
});

test('the same approval cannot send another request after success or a process restart', async () => {
  const f = fixture();
  assert.equal((await runPaidAcceptance(f.options)).status, 'PASS_ACTUAL');
  const again = await runPaidAcceptance(f.options);
  assert.equal(again.status, 'SKIP_ALREADY_CLAIMED');
  assert.equal(again.requestCount, 0);
  assert.equal(f.requests.length, 1);
});

test('concurrent uses of one approval permit at most one provider request', async () => {
  const f = fixture();
  const results = await Promise.all([runPaidAcceptance(f.options), runPaidAcceptance(f.options)]);
  assert.equal(results.filter((result) => result.status === 'PASS_ACTUAL').length, 1);
  assert.equal(f.requests.length, 1);
});

test('existing unfinished and uncertain durable claims cannot dispatch', async () => {
  for (const stage of ['claimed', 'dispatch_started', 'finished']) {
    const f = fixture();
    f.claims.set(RUN_ID, { stage });
    assert.equal((await runPaidAcceptance(f.options)).status, 'SKIP_ALREADY_CLAIMED');
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  f.store.claim = async () => { throw Object.assign(new Error('private-database-error'), {
    acceptanceCode: 'acceptance_claim_uncertain',
  }); };
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.reason, 'acceptance_claim_uncertain');
  assert.equal(f.requests.length, 0);
  assert.equal(f.events.size, 0);
});

test('global disabled requirement, native budget, invalid telemetry, and approval pins stop before a claim', async () => {
  for (const modify of [
    (f) => { f.options.env.MISSION_AI_DELEGATION_ENABLED = 'true'; },
    (f) => { delete f.options.env.MISSION_AI_LEDGER_MONGO_URI; },
    (f) => { f.options.env.MISSION_AI_LEDGER_DB = 'test'; },
    (f) => { f.options.env.OPENAI_API_BASE_URL = 'https://not-approved.invalid'; },
    (f) => { f.options.approvedSourceSha = 'b'.repeat(40); },
    (f) => { f.options.approvedModel = 'gpt-6-sol'; },
    (f) => { f.options.approvedPricingDate = '2026-09-26'; },
    (f) => { const original = f.options.dashboardReader; f.options.dashboardReader = async () => ({ ...(await original()), spendUsd: 174.96 }); },
    (f) => { const original = f.options.dashboardReader; f.options.dashboardReader = async () => ({ ...(await original()), spendUsd: NaN }); },
    (f) => { f.options.now = new Date('2026-10-01T05:59:30Z'); },
  ]) {
    const f = fixture(); modify(f);
    const result = await runPaidAcceptance(f.options);
    assert.equal(result.status, 'FAIL_PRE_DISPATCH');
    assert.equal(f.requests.length, 0);
    assert.equal(f.claims.size, 0);
  }
});

test('a pricing estimate above the approved five cents cannot reserve or dispatch', async () => {
  const f = fixture();
  f.options.pricingLoader = async () => ({ ...PRICING,
    models: { 'gpt-6-luna': { provider: 'openai', input: 100, output: 100 } } });
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.reason, 'acceptance_estimate_exceeds_cap');
  assert.equal(f.requests.length, 0);
  assert.equal(f.events.size, 0);
});

test('reservation and dispatch-marker failures preserve the consumed claim and never send', async () => {
  for (const phase of ['reserve', 'markDispatch']) {
    const f = fixture();
    if (phase === 'reserve') f.ledger.reserve = async () => { throw new Error('private-mongo-error'); };
    else f.store.markDispatch = async () => { throw new Error('private-mongo-error'); };
    const result = await runPaidAcceptance(f.options);
    assert.equal(result.status, 'FAIL_ACCOUNTING_PENDING');
    assert.equal(f.requests.length, 0);
    assert.equal(f.claims.size, 1);
    assert.equal(JSON.stringify(result).includes('private-mongo-error'), false);
  }
});

test('missing usage is conservatively settled as estimated and never reported as passing', async () => {
  const f = fixture();
  let calls = 0;
  f.options.fetchImpl = async () => { calls += 1; return response({ model: 'gpt-6-luna', output_text: 'OK' }); };
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'FAIL_ESTIMATED');
  assert.equal(result.estimated, true);
  assert.equal(result.accountedUsd, 0.05);
  assert.equal(calls, 1);
  assert.equal(f.events.get(`paid-acceptance:${RUN_ID}`).usage.estimated, true);
  assert.equal((await runPaidAcceptance(f.options)).requestCount, 0);
  assert.equal(calls, 1);
});

test('unverified or premium provider service tiers cannot pass paid accounting acceptance', async () => {
  for (const tier of [undefined, 'priority']) {
    const f = fixture();
    f.options.fetchImpl = async () => response({ model: 'gpt-6-luna', output_text: 'OK',
      usage: { input_tokens: 10, output_tokens: 2 },
      ...(tier === undefined ? {} : { service_tier: tier }),
    });
    const result = await runPaidAcceptance(f.options);
    assert.equal(result.status, 'FAIL_ESTIMATED');
    assert.equal(result.reason, 'provider_service_tier_unverified');
    assert.equal(result.requestCount, 1);
    assert.equal(result.accountedUsd, 0.05);
    assert.equal(result.serviceTier, undefined);
  }
});

test('provider timeout and network uncertainty settle once without fallback', async () => {
  for (const name of ['TimeoutError', 'TypeError']) {
    const f = fixture();
    let calls = 0;
    f.options.fetchImpl = async () => { calls += 1; throw Object.assign(new Error('private'), { name }); };
    const result = await runPaidAcceptance(f.options);
    assert.equal(result.status, 'FAIL_ESTIMATED');
    assert.equal(calls, 1);
    assert.equal(result.accountedUsd, 0.05);
  }
});

test('definitive provider rejection releases the reservation without retry or fallback', async () => {
  const f = fixture();
  let calls = 0;
  f.options.fetchImpl = async () => { calls += 1; return response({ error: { code: 'private' } }, 401); };
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'FAIL_REJECTED');
  assert.equal(calls, 1);
  assert.equal(f.events.get(`paid-acceptance:${RUN_ID}`).status, 'released');
  assert.equal((await f.ledger.summary({ now: NOW })).reservedUsd, 0);
});

test('failed settlement after execution retains the reservation and never releases possibly billed usage', async () => {
  const f = fixture();
  f.ledger.settle = async () => { throw new Error('private-mongo-error'); };
  f.ledger.release = async () => assert.fail('May not release a possibly billed reservation');
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'FAIL_ACCOUNTING_PENDING');
  assert.equal(result.requestCount, 1);
  assert.equal((await f.ledger.summary({ now: NOW })).reservedUsd, 0.05);
  assert.equal(f.claims.get(RUN_ID).stage, 'dispatch_started');
});

test('post-settlement proof mismatch cannot produce PASS_ACTUAL', async () => {
  const f = fixture();
  const original = f.store.readEvent;
  f.store.readEvent = async (id) => ({ ...(await original(id)), actualUsd: 0 });
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'FAIL_ACCOUNTING_PENDING');
  assert.equal(result.reason, 'acceptance_postcheck_failed');
});

test('CLI without explicit approval arguments exits safely without provider or database work', async () => {
  const path = fileURLToPath(new URL('./paid-acceptance.js', import.meta.url));
  await assert.rejects(() => promisify(execFile)(process.execPath, [path], { env: {} }), (error) => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stdout).status, 'FAIL_PRE_DISPATCH');
    assert.equal(error.stderr, '');
    return true;
  });
});

function anthropicFixture() {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-acceptance-key';
  delete process.env.ANTHROPIC_API_BASE_URL;
  const f = fixture();
  Object.assign(f.options, { approvedProvider: 'anthropic', approvedModel: 'claude-sonnet-5-5', approvedPricingDate: '2026-09-28',
    pricingLoader: async () => ({ verifiedOn: '2026-09-27', models: { 'claude-sonnet-5-5': { provider: 'anthropic', input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, verifiedOn: '2026-09-28' } } }),
    catalogLoader: async () => ({ providers: { anthropic: { economy: 'claude-sonnet-5-5' } } }),
    fetchImpl: async (url, options) => {
      f.requests.push({ url, options });
      assert.equal(f.claims.get(RUN_ID).stage, 'dispatch_started');
      return response({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'PRIVATE_ANTHROPIC_OUTPUT' }], usage: { input_tokens: 10, output_tokens: 2, service_tier: 'standard' } });
    },
  });
  Object.assign(f.options.env, { ANTHROPIC_API_KEY: 'test-anthropic-acceptance-key', MISSION_AI_NATIVE_ENABLED: 'false', MISSION_AI_MODEL_ECONOMY: 'claude-sonnet-5-5' });
  return f;
}

test('approved Sonnet 5.5 acceptance is one exact standard-only request with five-cent reservation and both paid gates off', async () => {
  const f = anthropicFixture();
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'PASS_ACTUAL');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.serviceTier, 'standard');
  assert.equal(result.pricingVerifiedOn, '2026-09-28');
  assert.ok(Math.abs(result.actualUsd - 0.00004) < 1e-12);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' }, output_config: { effort: 'low' }, max_tokens: 128, messages: [{ role: 'user', content: 'Reply only with OK.' }], service_tier: 'standard_only' });
  assert.equal(f.events.get(`paid-acceptance:${RUN_ID}`).reservedUsd, 0.05);
  assert.equal(f.options.env.MISSION_AI_NATIVE_ENABLED, 'false');
  assert.equal(f.options.env.MISSION_AI_DELEGATION_ENABLED, 'false');
  assert.equal((await runPaidAcceptance(f.options)).status, 'SKIP_ALREADY_CLAIMED');
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify([...f.claims.values()]), /PRIVATE_ANTHROPIC_OUTPUT|test-anthropic-acceptance-key|mongodb:\/\//);
});

test('Sonnet acceptance refuses native activation, alternate provider URLs, key mismatch and mismatched pricing before dispatch', async () => {
  for (const change of [f => { f.options.env.MISSION_AI_NATIVE_ENABLED = 'true'; }, f => { f.options.env.ANTHROPIC_API_BASE_URL = 'https://other.invalid'; }, f => { f.options.env.ANTHROPIC_API_KEY = 'different-test-key'; }, f => { f.options.approvedPricingDate = '2026-09-27'; }, f => { f.options.approvedProvider = 'google'; }]) {
    const f = anthropicFixture(); change(f);
    assert.equal((await runPaidAcceptance(f.options)).status, 'FAIL_PRE_DISPATCH');
    assert.equal(f.requests.length, 0);
    assert.equal(f.claims.size, 0);
  }
});

test('Sonnet acceptance retains its reservation on unknown or premium tier and never retries', async () => {
  for (const tier of [undefined, 'priority']) {
    const f = anthropicFixture();
    f.options.fetchImpl = async (url, options) => { f.requests.push({ url, options }); return response({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 10, output_tokens: 2, service_tier: tier } }); };
    const result = await runPaidAcceptance(f.options);
    assert.equal(result.status, 'FAIL_ESTIMATED');
    assert.equal(result.reason, 'provider_service_tier_unverified');
    assert.equal(result.accountedUsd, 0.05);
    assert.equal((await runPaidAcceptance(f.options)).status, 'SKIP_ALREADY_CLAIMED');
    assert.equal(f.requests.length, 1);
  }
});
