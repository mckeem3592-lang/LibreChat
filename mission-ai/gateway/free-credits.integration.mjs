import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createMongoUsageLedger } from './usage-ledger.js';
import { createFreeCreditStore } from './generated/freeCredits.js';
import { createFreeSearch } from './generated/freeSearch.js';

test('free-credit holds are atomic, durable, key-scoped, and retain ambiguous usage across reconnects', async (t) => {
  const repl = await MongoMemoryReplSet.create({
    binary: { version: '8.0.17', downloadDir: process.env.MONGOMS_DOWNLOAD_DIR || join(tmpdir(), 'mission-ai-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25'] }],
  });
  t.after(() => repl.stop());
  const uri = repl.getUri('MissionAIFreeCreditFixture');
  const hosts = [createMongoUsageLedger({ uri, dbName: 'MissionAIFreeCreditFixture' }),
    createMongoUsageLedger({ uri, dbName: 'MissionAIFreeCreditFixture' })];
  t.after(() => Promise.all(hosts.map(host => host.close())));
  const now = new Date('2026-09-28T12:00:00Z');
  const store = (i, keyId = 'a'.repeat(64)) => createFreeCreditStore({ repository: hosts[i].freeSearchRepository,
    keyId, now: () => now, randomId: randomUUID });
  const a = store(0); const b = store(1);
  assert.deepEqual(await a.read(), { accountUsed: 0, keyUsed: 0 });
  const claims = await Promise.allSettled([a.claim({ accountUsed: 998, keyUsed: 0, keyLimit: 1000 }),
    b.claim({ accountUsed: 998, keyUsed: 0, keyLimit: 1000 })]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  const lease = claims.find(result => result.status === 'fulfilled').value;
  await assert.rejects(store(1).read(), /search_usage_uncertain/);
  await assert.rejects(store(0, 'b'.repeat(64)).read(), /search_usage_uncertain/);
  await a.settle(lease);
  assert.deepEqual(await b.read(), { accountUsed: 999, keyUsed: 1 });
  const last = await b.claim({ accountUsed: 998, keyUsed: 0, keyLimit: 1000 });
  await b.settle(last);
  await assert.rejects(a.claim({ accountUsed: 998, keyUsed: 0, keyLimit: 1000 }), /search_free_credits_exhausted/);

  // A new free period still requires the host's new PAYG-off proof. Old holds remain retained.
  now.setUTCMonth(9);
  const next = await a.claim({ accountUsed: 0, keyUsed: 0, keyLimit: 1000 });
  await a.lock(next);
  await assert.rejects(store(1).read(), /search_usage_uncertain/);
  await assert.rejects(a.settle(next), /search_store_unready/);

  now.setUTCMonth(10);
  let attempts = 0;
  const deps = { enabled: () => true, freePlanVerified: () => true, apiKey: 'synthetic-key', creditStore: store(0),
    fetchImpl: async url => {
      if (url.endsWith('/usage')) return { status: 200, json: async () => ({
        account: { current_plan: 'Researcher', plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: null },
        key: { usage: 0, limit: 1000 },
      }) };
      attempts++; return { status: 500 };
    } };
  await assert.rejects(createFreeSearch(deps).search({ query: 'Synthetic request' }), /search_provider_unavailable/);
  await assert.rejects(createFreeSearch({ ...deps, creditStore: store(1) }).search({ query: 'Synthetic retry' }), /search_usage_uncertain/);
  assert.equal(attempts, 1);
});
