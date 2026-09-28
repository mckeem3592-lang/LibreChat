import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { bootstrapMissionAiOwner } from './generated/bootstrap.js';

const PASSWORD = 'Synthetic-owner-test-123';
const HASH = '$2b$10$' + 'A'.repeat(53);
const ID = '0123456789abcdef01234567';
const NOW = new Date('2026-09-28T12:00:00Z');
const ENV = {
  MISSION_AI_BOOTSTRAP_OWNER: 'true', ALLOW_REGISTRATION: 'false', ALLOW_SOCIAL_REGISTRATION: 'false',
  MONGO_URI: 'mongodb+srv://mission_ai_chat_test:synthetic@fixture.mongodb.net/MissionAIChatTest?retryWrites=true&w=majority&authSource=admin',
  MISSION_AI_OWNER_EMAIL: ' Owner@Example.Test ', MISSION_AI_OWNER_PASSWORD: PASSWORD,
};
const clone = (value) => structuredClone(value);

function fixture() {
  let state = { claim: null, users: [] };
  let queue = Promise.resolve();
  let transactions = 0;
  const calls = [];
  const faults = {};
  const deps = {
    env: { ...ENV }, randomId: () => ID, now: () => NOW,
    hashPassword: async (password) => { assert.equal(password, PASSWORD); calls.push('hash'); return HASH; },
    comparePassword: async (password, hash) => password === PASSWORD && hash === HASH,
    async transaction(work) {
      transactions++;
      const previous = queue;
      let unlock;
      queue = new Promise((resolve) => { unlock = resolve; });
      await previous;
      const next = clone(state);
      try {
        const result = await work({
          lockSingleton: async () => { calls.push('lock'); return next.claim ??= { version: 1 }; },
          countUsers: async () => { calls.push('count'); return faults.count ?? next.users.length; },
          findOwner: async (id) => next.users.find((user) => user.id === id) ?? null,
          createOwner: async (owner) => { calls.push('create'); next.users.push(clone(owner)); },
          finishClaim: async (claim) => {
            calls.push('claim');
            if (faults.finish) throw new Error('synthetic_database_failure');
            next.claim = clone(claim);
          },
        });
        state = next;
        return result;
      } finally { unlock(); }
    },
  };
  return { deps, calls, faults, get state() { return state; },
    set state(value) { state = value; }, get transactions() { return transactions; },
    run: () => bootstrapMissionAiOwner(deps) };
}

test('private bootstrap stores one verified local ADMIN hash, with no expiry or balance', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { status: 'created' });
  assert.deepEqual(f.calls, ['hash', 'lock', 'count', 'create', 'claim']);
  assert.deepEqual(f.state.users, [{ id: ID, email: 'owner@example.test', password: HASH,
    provider: 'local', role: 'ADMIN', emailVerified: true,
    name: 'Mission AI Owner', username: 'mission-ai-owner', avatar: null }]);
  assert.deepEqual(f.state.claim, { version: 1, ownerId: ID, email: 'owner@example.test', createdAt: NOW });
  assert.equal(JSON.stringify(f.state).includes(PASSWORD), false);
});

test('same-owner restart proves the password and preserves the full existing user', async () => {
  const f = fixture();
  await f.run();
  f.state.users[0].name = 'Owner edited this name';
  f.state.users[0].preferences = { synthetic: true };
  const before = clone(f.state);
  f.deps.randomId = () => 'aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.deepEqual(await f.run(), { status: 'already_initialized' });
  assert.deepEqual(f.state, before);
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
});

const invalidConfig = [
  ['missing explicit opt-in', { MISSION_AI_BOOTSTRAP_OWNER: undefined }, 'disabled'],
  ['public registration', { ALLOW_REGISTRATION: 'true' }, 'registration_enabled'],
  ['social registration', { ALLOW_SOCIAL_REGISTRATION: 'true' }, 'registration_enabled'],
  ['missing registration guard', { ALLOW_REGISTRATION: undefined }, 'registration_enabled'],
  ['empty email', { MISSION_AI_OWNER_EMAIL: '' }, 'invalid_email'],
  ['malformed email', { MISSION_AI_OWNER_EMAIL: 'not an email' }, 'invalid_email'],
  ['short password', { MISSION_AI_OWNER_PASSWORD: 'short' }, 'invalid_password'],
  ['blank password', { MISSION_AI_OWNER_PASSWORD: ' '.repeat(15) }, 'invalid_password'],
  ['control character password', { MISSION_AI_OWNER_PASSWORD: PASSWORD + '\n' }, 'invalid_password'],
  ['bcrypt byte truncation', { MISSION_AI_OWNER_PASSWORD: '🧪'.repeat(19) }, 'invalid_password'],
  ['original database', { MONGO_URI: ENV.MONGO_URI.replace('/MissionAIChatTest', '/test') }, 'wrong_database'],
  ['original user', { MONGO_URI: ENV.MONGO_URI.replace('mission_ai_chat_test:', 'original_user:') }, 'wrong_database'],
  ['missing database', { MONGO_URI: ENV.MONGO_URI.replace('/MissionAIChatTest', '/') }, 'wrong_database'],
  ['untrusted host', { MONGO_URI: ENV.MONGO_URI.replace('fixture.mongodb.net', 'mongodb.net.example.test') }, 'wrong_database'],
  ['non-SRV connection', { MONGO_URI: ENV.MONGO_URI.replace('mongodb+srv:', 'mongodb:') }, 'wrong_database'],
  ['weakened TLS', { MONGO_URI: ENV.MONGO_URI + '&tls=false' }, 'wrong_database'],
  ['duplicate query options', { MONGO_URI: ENV.MONGO_URI + '&w=1' }, 'wrong_database'],
  ['wrong auth database', { MONGO_URI: ENV.MONGO_URI.replace('authSource=admin', 'authSource=test') }, 'wrong_database'],
  ['unsupported URI option', { MONGO_URI: ENV.MONGO_URI + '&directConnection=true' }, 'wrong_database'],
];
for (const [name, override, error] of invalidConfig) {
  test(`bootstrap rejects ${name} before hashing or opening the database`, async () => {
    const f = fixture(); Object.assign(f.deps.env, override);
    await assert.rejects(f.run, new RegExp(`^Error: owner_bootstrap_${error}$`));
    assert.equal(f.transactions, 0); assert.deepEqual(f.calls, []);
  });
}

test('bcrypt receives the exact bounded UTF-8 password without silent truncation', async () => {
  const f = fixture();
  const password = '🧪'.repeat(18);
  f.deps.env.MISSION_AI_OWNER_PASSWORD = password;
  f.deps.hashPassword = async (input) => { assert.equal(input, password); return HASH; };
  assert.deepEqual(await f.run(), { status: 'created' });
});

for (const [name, change] of [
  ['different email', (f) => { f.deps.env.MISSION_AI_OWNER_EMAIL = 'other@example.test'; }],
  ['different password', (f) => { f.deps.comparePassword = () => false; }],
  ['non-admin role', (f) => { f.state.users[0].role = 'USER'; }],
  ['nonlocal provider', (f) => { f.state.users[0].provider = 'google'; }],
  ['unverified owner', (f) => { f.state.users[0].emailVerified = false; }],
  ['temporary owner', (f) => { f.state.users[0].expiresAt = NOW; }],
  ['tenant-scoped owner', (f) => { f.state.users[0].tenantId = 'some-tenant'; }],
  ['missing owner', (f) => { f.state.users = []; }],
  ['additional user', (f) => { f.state.users.push({ id: 'other' }); }],
  ['missing persisted claim', (f) => { f.state.claim = null; }],
  ['altered claim identity', (f) => { f.state.claim.ownerId = 'aaaaaaaaaaaaaaaaaaaaaaaa'; }],
  ['unsupported claim version', (f) => { f.state.claim.version = 2; }],
  ['malformed stored password', (f) => { f.state.users[0].password = 'not-a-hash'; }],
]) {
  test(`restart rejects ${name} without overwriting any state`, async () => {
    const f = fixture(); await f.run(); change(f); const before = clone(f.state);
    await assert.rejects(f.run, /owner_bootstrap_(identity_conflict|not_empty)/);
    assert.deepEqual(f.state, before);
  });
}

test('a database failure after user insertion rolls back the user and singleton claim', async () => {
  const f = fixture(); f.faults.finish = true;
  await assert.rejects(f.run, /synthetic_database_failure/);
  assert.deepEqual(f.state, { claim: null, users: [] });
  f.faults.finish = false;
  assert.deepEqual(await f.run(), { status: 'created' });
});

test('malformed hash and invalid count both fail closed', async () => {
  const badHash = fixture(); badHash.deps.hashPassword = () => PASSWORD;
  await assert.rejects(badHash.run, /owner_bootstrap_invalid_hash/);
  assert.equal(badHash.transactions, 0);
  const badCount = fixture(); badCount.faults.count = NaN;
  await assert.rejects(badCount.run, /owner_bootstrap_invalid_state/);
  assert.deepEqual(badCount.state, { claim: null, users: [] });
});

test('serialized bootstrap attempts cannot create a second admin or replace the winner', async () => {
  const f = fixture();
  const results = await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(results.filter((r) => r.status === 'created').length, 1);
  assert.equal(results.filter((r) => r.status === 'already_initialized').length, 2);
  const before = clone(f.state);
  await assert.rejects(() => bootstrapMissionAiOwner({ ...f.deps,
    env: { ...ENV, MISSION_AI_OWNER_EMAIL: 'second@example.test' } }), /identity_conflict/);
  assert.deepEqual(f.state, before);
});

const wiringPath = fileURLToPath(new URL('../chat-test/bootstrap.cjs', import.meta.url));
const wiring = readFileSync(wiringPath, 'utf8');
async function executeWiring(modules, env = ENV) {
  const logs = []; const process = { env: { ...env }, exitCode: undefined };
  const require = (name) => {
    if (name === 'node:path') return { resolve: (...paths) => join(...paths) };
    if (name === 'node:module') return { createRequire: () => (id) => {
      if (!(id in modules)) throw new Error('unexpected_module');
      return modules[id];
    } };
    throw new Error('unexpected_require');
  };
  await runInNewContext(wiring, { require, __dirname: dirname(wiringPath), process,
    console: { log: (line) => logs.push(line), error: (line) => logs.push(line) }, Date });
  return { logs, exitCode: process.exitCode };
}

test('deployment wiring suppresses raw module/driver errors and private credentials', async () => {
  const result = await executeWiring({ mongoose: { disconnect: async () => {} },
    bcryptjs: {}, '@librechat/api': { bootstrapMissionAiOwner: async () => { throw new Error(ENV.MONGO_URI + PASSWORD); } },
    '@librechat/data-schemas': { createModels: () => ({}) } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.logs, ['{"status":"failed","code":"owner_bootstrap_failed"}']);
});

test('deployment wiring never connects when bootstrap credentials are invalid', async () => {
  let connected = false;
  const result = await executeWiring({ mongoose: {
    disconnect: async () => {}, connect: async () => { connected = true; },
  }, bcryptjs: {}, '@librechat/api': { bootstrapMissionAiOwner },
  '@librechat/data-schemas': { createModels: () => ({}) } }, { ...ENV, MISSION_AI_BOOTSTRAP_OWNER: 'false' });
  assert.equal(connected, false); assert.equal(result.exitCode, 1);
});

// Opt in to actual Mongo transaction checks without downloading/running a database during unit tests.
// Uses only a fresh local replica set; URI validation still sees the isolated deployment identity.
if (process.env.MISSION_AI_BOOTSTRAP_MONGO_TESTS === 'true') {
  test('real Mongo deployment wiring is atomic, race-safe, idempotent and leaves no balance or TTL', { timeout: 120000 }, async (t) => {
    const [{ default: mongoose }, { MongoMemoryReplSet }, { default: ts }] = await Promise.all([
      import('mongoose'), import('mongodb-memory-server-core'), import('typescript'),
    ]);
    const repl = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17', downloadDir: process.env.MONGOMS_DOWNLOAD_DIR },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25'] }],
    });
    t.after(() => repl.stop());
    const uri = repl.getUri('MissionAIChatTest');
    const client = await new mongoose.mongo.MongoClient(uri).connect();
    t.after(() => client.close());
    const db = client.db('MissionAIChatTest');
    const userSource = readFileSync(new URL('../../packages/data-schemas/src/schema/user.ts', import.meta.url), 'utf8');
    function modules() {
      const m = new mongoose.Mongoose();
      const connect = m.connect.bind(m);
      m.connect = async (_deploymentUri, options) => connect(uri, options);
      const exports = {};
      runInNewContext(ts.transpileModule(userSource, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      } }).outputText, { exports, require: (name) => {
        if (name === 'mongoose') return m;
        if (name === 'librechat-data-provider') return { SystemRoles: { USER: 'USER' }, STATEFUL_CODE_ENVIRONMENTS: ['user'] };
        throw new Error('unexpected_schema_import');
      } });
      return { mongoose: m,
        bcryptjs: { hash: async (password, rounds) => { assert.equal(password, PASSWORD); assert.equal(rounds, 10); return HASH; },
          compare: async (password, hash) => password === PASSWORD && hash === HASH },
        '@librechat/api': { bootstrapMissionAiOwner },
        '@librechat/data-schemas': { createModels: () => ({ User: m.model('User', exports.default) }) } };
    }
    const runs = await Promise.all(Array.from({ length: 4 }, () => executeWiring(modules())));
    assert.equal(runs.filter((r) => r.logs.includes('{"status":"created"}')).length, 1);
    assert.equal(await db.collection('users').countDocuments(), 1);
    const owner = await db.collection('users').findOne({});
    assert.equal(owner.password, HASH); assert.equal(owner.role, 'ADMIN'); assert.equal(owner.emailVerified, true);
    assert.equal(owner.provider, 'local'); assert.equal(owner.expiresAt, undefined); assert.equal(owner.tenantId, undefined);
    assert.equal(await db.collection('balances').countDocuments(), 0);
    const claim = await db.collection('mission_ai_bootstrap').findOne({ _id: 'owner-v1' });
    assert.equal(claim.ownerId, owner._id.toHexString());
    assert.deepEqual((await executeWiring(modules())).logs, ['{"status":"already_initialized"}']);
    assert.deepEqual(await db.collection('users').findOne({}), owner);
    assert.equal((await executeWiring(modules(), { ...ENV, MISSION_AI_OWNER_EMAIL: 'different@example.test' })).exitCode, 1);
    assert.deepEqual(await db.collection('users').findOne({}), owner);
    // A collection validator forces the final claim write to fail after user insertion.
    await db.dropDatabase();
    await db.createCollection('mission_ai_bootstrap', { validator: { ownerId: { $exists: false } } });
    assert.equal((await executeWiring(modules())).exitCode, 1);
    assert.equal(await db.collection('users').countDocuments(), 0);
    assert.equal(await db.collection('mission_ai_bootstrap').countDocuments(), 0);
  });
}
