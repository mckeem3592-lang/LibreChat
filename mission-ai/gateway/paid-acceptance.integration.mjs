import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { runPaidAcceptance } from './paid-acceptance.js';

process.env.OPENAI_API_KEY = 'test-paid-acceptance-key';
delete process.env.OPENAI_API_BASE_URL;

let replSet;
let client;
let db;
const now = new Date('2026-09-28T18:00:00Z');
const source = 'a'.repeat(40);

before(async () => {
  replSet = await MongoMemoryReplSet.create({
    binary: { version: process.env.MONGOMS_VERSION || '8.0.17',
      downloadDir: process.env.MONGOMS_DOWNLOAD_DIR || join(tmpdir(), 'mission-ai-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25'] }],
  });
  client = await new mongoose.mongo.MongoClient(replSet.getUri('MissionAI')).connect();
  db = client.db('MissionAI');
}, { timeout: 120000 });

after(async () => {
  await client?.close();
  await mongoose.disconnect();
  await replSet?.stop();
});

async function fixture() {
  await db.dropDatabase();
  const requests = [];
  const runId = randomUUID();
  const options = {
    approvedRunId: runId, approvedModel: 'gpt-6-luna',
    approvedPricingDate: '2026-09-27', approvedSourceSha: source, now,
    env: { MISSION_AI_DELEGATION_ENABLED: 'false',
      MISSION_AI_LEDGER_MONGO_URI: replSet.getUri('MissionAI'), MISSION_AI_LEDGER_DB: 'MissionAI',
      MISSION_AI_MONGO_URI: replSet.getUri('test'), OPENAI_API_KEY: 'test-paid-acceptance-key',
      RENDER_GIT_COMMIT: source,
    },
    catalogLoader: async () => ({ providers: { openai: { economy: 'gpt-6-luna' } } }),
    pricingLoader: async () => ({ verifiedOn: '2026-09-27', models: {
      'gpt-6-luna': { provider: 'openai', input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125 },
    } }),
    dashboardReader: async () => ({ spendUsd: 0, targetUsd: 100, economyUsd: 125,
      hardUsd: 175, timeZone: 'America/Denver' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const claim = await db.collection('paid_acceptance_claims').findOne({ _id: runId });
      const event = await db.collection('delegated_usage').findOne({ reservationId: `paid-acceptance:${runId}` });
      assert.equal(claim.stage, 'dispatch_started');
      assert.equal(event.status, 'reserved');
      assert.equal(event.reservedUsd, 0.05);
      return { ok: true, status: 200, async json() {
        return { model: 'gpt-6-luna', service_tier: 'default', output_text: 'PRIVATE_OUTPUT_NEVER_STORE',
          usage: { input_tokens: 10, output_tokens: 2 } };
      } };
    },
  };
  return { options, runId, requests };
}

test('real Mongo unique claim allows one concurrent dispatch and persists verified settlement across restart', async () => {
  const f = await fixture();
  const outcomes = await Promise.all([runPaidAcceptance(f.options), runPaidAcceptance(f.options)]);
  assert.equal(outcomes.filter((result) => result.status === 'PASS_ACTUAL').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'SKIP_ALREADY_CLAIMED').length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(f.requests[0].options.body).max_output_tokens, 128);
  assert.equal(JSON.parse(f.requests[0].options.body).service_tier, 'default');
  assert.equal((await runPaidAcceptance(f.options)).status, 'SKIP_ALREADY_CLAIMED');
  assert.equal(f.requests.length, 1);
  assert.equal(await db.collection('paid_acceptance_claims').countDocuments({}), 1);
  assert.equal(await db.collection('delegated_usage').countDocuments({}), 1);
  const event = await db.collection('delegated_usage').findOne({});
  const state = await db.collection('budget_state').findOne({});
  assert.equal(event.status, 'settled');
  assert.equal(event.usage.estimated, false);
  assert.equal(event.usage.outputTokens, 2);
  assert.equal(event.usage.serviceTier, 'default');
  assert.equal(state.settledUsd, event.actualUsd);
  assert.equal(state.reservedUsd, 0);
  const claim = await db.collection('paid_acceptance_claims').findOne({});
  assert.equal(claim.result.status, 'PASS_ACTUAL');
  assert.equal(JSON.stringify({ claim, event }).includes('PRIVATE_OUTPUT_NEVER_STORE'), false);
  assert.equal(f.options.env.MISSION_AI_DELEGATION_ENABLED, 'false');
});

test('real Mongo failed settlement keeps the reservation and cannot repeat its approved provider request', async () => {
  const f = await fixture();
  await db.createCollection('budget_state', { validator: { settledUsd: { $lte: 0 } } });
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'FAIL_ACCOUNTING_PENDING');
  assert.equal(f.requests.length, 1);
  assert.equal((await db.collection('delegated_usage').findOne({})).status, 'reserved');
  assert.equal((await db.collection('budget_state').findOne({})).reservedUsd, 0.05);
  assert.equal((await db.collection('paid_acceptance_claims').findOne({})).stage, 'dispatch_started');
  const repeated = await runPaidAcceptance(f.options);
  assert.equal(repeated.requestCount, 0);
  assert.equal(f.requests.length, 1);
});

test('real Mongo missing provider usage creates an estimated event and never a passing acceptance', async () => {
  const f = await fixture();
  let calls = 0;
  f.options.fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, async json() { return { output_text: 'OK' }; } };
  };
  const result = await runPaidAcceptance(f.options);
  assert.equal(result.status, 'FAIL_ESTIMATED');
  assert.equal(calls, 1);
  const event = await db.collection('delegated_usage').findOne({});
  assert.equal(event.actualUsd, 0.05);
  assert.equal(event.usage.estimated, true);
  assert.equal((await db.collection('budget_state').findOne({})).reservedUsd, 0);
  assert.equal((await runPaidAcceptance(f.options)).status, 'SKIP_ALREADY_CLAIMED');
  assert.equal(calls, 1);
});
