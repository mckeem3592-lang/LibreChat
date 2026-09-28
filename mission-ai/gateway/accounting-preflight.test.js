import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runAccountingPreflight } from './accounting-preflight.js';

const SECRET = 'synthetic-secret-never-output';
const NOW = new Date('2026-09-28T17:00:00.000Z');
const MONTH = '2026-09-01T06:00:00.000Z';
const env = { MISSION_AI_NATIVE_ENABLED: 'false', MISSION_AI_DELEGATION_ENABLED: 'false',
  MISSION_AI_LEDGER_DB: 'MissionAI',
  MISSION_AI_MONGO_URI: `mongodb+srv://mission_ai_reader:${SECRET}@example.mongodb.net/test`,
  MISSION_AI_LEDGER_MONGO_URI: `mongodb+srv://mission_ai_ledger:${SECRET}@example.mongodb.net/MissionAI` };

function fixture() {
  const data = { transactions: [
    { _id: 'private-transaction-id', createdAt: NOW, tokenType: 'prompt', tokenValue: -60_000, model: 'gpt-6-luna' },
    { _id: 'private-completion-id', createdAt: NOW, tokenType: 'completion', tokenValue: -5000, model: 'gpt-6-luna' },
    { _id: 'credit-id', createdAt: NOW, tokenType: 'prompt', tokenValue: 999_999 },
  ], budget_state: [{ _id: MONTH, settledUsd: 0.01, reservedUsd: 0 }], delegated_usage: [
    { reservationId: 'private-reservation-id', monthStart: MONTH, status: 'settled', reservedUsd: 0.05,
      actualUsd: 0.01, metadata: { source: 'delegated' }, usage: { estimated: false }, createdAt: NOW },
  ] };
  const calls = [], closed = [];
  const summary = { settledUsd: 0.01, reservedUsd: 0 };
  const options = { env, now: () => NOW, catalogLoader: async () => ({ providers: { openai: { economy: 'gpt-6-luna' } } }),
    connect: async ({ database, registerClose }) => {
      registerClose(async () => { closed.push(database); });
      const session = {};
      return { session, db: { databaseName: database,
        command: async (command) => {
          assert.deepEqual(command, { connectionStatus: 1 });
          return { authInfo: { authenticatedUserRoles: [
            { role: database === 'test' ? 'read' : 'readWrite', db: database },
          ] } };
        },
        collection: (name) => ({
          // Deliberately no update/insert/delete/index/transaction APIs in the adapter.
          find: (filter, settings) => {
            assert.equal(settings.session, session);
            assert.equal(settings.maxTimeMS, 7000);
            assert.ok(settings.projection);
            calls.push({ database, name, filter, projection: settings.projection });
            return { limit: (n) => { assert.equal(n, 100_001); return { toArray: async () => structuredClone(data[name]) }; } };
          },
        }),
      } };
    },
    ledgerFactory: () => ({ sharedBudget: async () => null, summary: async () => ({ ...summary }),
      close: async () => { closed.push('ledger-reader'); } }),
  };
  return { data, calls, closed, summary, options };
}

test('provisional plan and all-month ledger comparison use only read methods and reveal no records', async () => {
  const f = fixture();
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  assert.equal(report.activationAuthorized, false);
  assert.equal(report.artifactPersisted, false);
  assert.equal(report.cutoff, NOW.toISOString());
  assert.equal(report.monthStart, MONTH);
  assert.equal(report.native.transactionCount, 2);
  assert.equal(report.native.nativeUsd, 0.065);
  assert.match(report.native.planDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.native.policy, { targetUsd: 100, economyUsd: 125, hardUsd: 175 });
  assert.equal(report.ledger.stateEventsMatch, true);
  assert.equal(report.ledger.sharedActivation, 'inactive');
  assert.equal(report.ledger.unresolvedAccounting, false);
  assert.deepEqual(report.ledger.eventCounts, { reserved: 0, settled: 1, released: 0 });
  assert.deepEqual(f.closed.sort(), ['MissionAI', 'ledger-reader', 'test']);
  assert.deepEqual(f.calls.map((c) => c.name).sort(), ['budget_state', 'delegated_usage', 'transactions']);
  const output = JSON.stringify(report);
  for (const privateValue of [SECRET, 'private-transaction-id', 'private-reservation-id', 'mongodb', 'gpt-6-luna']) {
    assert.equal(output.includes(privateValue), false);
  }
  assert.ok(output.length < 3000);
});

test('receipt includes only a validated source commit, never arbitrary environment text', async () => {
  const f = fixture();
  for (const value of ['a'.repeat(40), SECRET, undefined, 'b'.repeat(41)]) {
    const result = await runAccountingPreflight({ ...f.options, env: { ...env, RENDER_GIT_COMMIT: value } });
    assert.equal(result.sourceCommit, value === 'a'.repeat(40) ? value : null);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

for (const [label, changes] of [
  ['native enabled', { MISSION_AI_NATIVE_ENABLED: 'true' }],
  ['missing native gate', { MISSION_AI_NATIVE_ENABLED: undefined }],
  ['delegation enabled', { MISSION_AI_DELEGATION_ENABLED: 'TRUE' }],
  ['missing ledger DB', { MISSION_AI_LEDGER_DB: undefined }],
  ['wrong reader database', { MISSION_AI_MONGO_URI: env.MISSION_AI_MONGO_URI.replace('/test', '/MissionAIChatTest') }],
  ['wrong reader identity', { MISSION_AI_MONGO_URI: env.MISSION_AI_MONGO_URI.replace('mission_ai_reader', 'production') }],
  ['wrong ledger identity', { MISSION_AI_LEDGER_MONGO_URI: env.MISSION_AI_LEDGER_MONGO_URI.replace('mission_ai_ledger', 'production') }],
  ['different cluster', { MISSION_AI_LEDGER_MONGO_URI: env.MISSION_AI_LEDGER_MONGO_URI.replace('example.', 'other.') }],
  ['unsafe options', { MISSION_AI_MONGO_URI: `${env.MISSION_AI_MONGO_URI}?tls=false` }],
  ['duplicate options', { MISSION_AI_MONGO_URI: `${env.MISSION_AI_MONGO_URI}?tls=true&tls=true` }],
  ['wrong timezone', { MISSION_AI_BUDGET_TIMEZONE: 'UTC' }],
]) test(`configuration rejects ${label} before connection`, async () => {
  const f = fixture();
  const result = await runAccountingPreflight({ ...f.options, env: { ...env, ...changes } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'configuration_invalid');
  assert.equal(f.closed.length, 0);
  assert.equal(f.calls.length, 0);
});

test('late original-service charges invalidate this cutoff without masking independent ledger results', async () => {
  const f = fixture();
  f.data.transactions[0].createdAt = new Date(NOW.getTime() + 1);
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.native.reason, 'native_not_drained');
  assert.equal(report.ledger.status, 'observed');
});

for (const [label, change] of [
  ['missing state', (f) => { f.data.budget_state = []; }],
  ['undercount', (f) => { f.data.budget_state[0].settledUsd = 0; }],
  ['numeric string', (f) => { f.data.delegated_usage[0].actualUsd = '0.01'; }],
  ['unknown source', (f) => { f.data.delegated_usage[0].source = '__proto__'; }],
  ['conflicting source', (f) => { f.data.delegated_usage[0].source = 'native'; }],
  ['null source', (f) => { f.data.delegated_usage[0].source = null; }],
  ['duplicate reservation', (f) => { f.data.delegated_usage.push({ ...f.data.delegated_usage[0] }); }],
  ['unknown status', (f) => { f.data.delegated_usage[0].status = 'secret-status'; }],
]) test(`ledger ${label} fails closed and native plan remains independently available`, async () => {
  const f = fixture(); change(f);
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.ledger.reason, 'ledger_integrity_invalid');
  assert.equal(report.native.status, 'observed');
});

test('reservations and quarantine evidence are reported without reconciling or releasing them', async () => {
  const f = fixture();
  f.data.budget_state[0].accountingBlocked = true;
  f.summary.accountingBlocked = true;
  f.data.delegated_usage[0].underestimated = true;
  f.data.delegated_usage[0].usage.estimated = true;
  f.data.delegated_usage.push({ reservationId: 'held', monthStart: MONTH, status: 'reserved', reservedUsd: 0.02,
    createdAt: new Date(NOW.getTime() - 16 * 60_000) });
  f.data.budget_state[0].reservedUsd = f.summary.reservedUsd = 0.02;
  const before = structuredClone(f.data);
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.ledger.reservedUsd, 0.02);
  assert.equal(report.ledger.eventCounts.reserved, 1);
  assert.equal(report.ledger.staleReservations, 1);
  assert.equal(report.ledger.estimatedSettlements, 1);
  assert.equal(report.ledger.underestimatedEvents, 1);
  assert.equal(report.ledger.accountingBlocked, true);
  assert.equal(report.ledger.unresolvedAccounting, true);
  assert.deepEqual(f.data, before);
});

test('existing shared activation is reported and its partitions must match', async () => {
  const f = fixture();
  const factory = f.options.ledgerFactory;
  f.options.ledgerFactory = () => ({ ...factory(), sharedBudget: async () => ({ mode: 'shared', timeZone: 'America/Denver' }) });
  Object.assign(f.summary, { sharedMode: true, nativeUsd: 0, historyUsd: 0, delegatedUsd: 0.01 });
  assert.equal((await runAccountingPreflight(f.options)).ledger.sharedActivation, 'active');
  f.summary.delegatedUsd = 0;
  assert.equal((await runAccountingPreflight(f.options)).ledger.reason, 'ledger_changed_during_observation');
});

test('role inspection unavailable is explicit; excessive roles are not accepted', async () => {
  for (const unknown of [true, false]) {
    const f = fixture(), original = f.options.connect;
    f.options.connect = async (args) => {
      const resource = await original(args);
      resource.db.command = async () => {
        if (unknown) throw new Error(SECRET);
        return { authInfo: { authenticatedUserRoles: [{ role: 'atlasAdmin', db: 'admin' }] } };
      };
      return resource;
    };
    const report = await runAccountingPreflight(f.options);
    assert.equal(report.native[unknown ? 'roleInspection' : 'reason'], unknown ? 'unknown' : 'database_scope_mismatch');
    assert.equal(JSON.stringify(report).includes(SECRET), false);
  }
});

test('driver failures do not echo raw errors or records', async () => {
  const f = fixture();
  f.options.connect = async () => { throw new Error(`connection failed ${env.MISSION_AI_MONGO_URI}`); };
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.native.reason, 'read_failed');
  assert.equal(report.ledger.reason, 'read_failed');
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});

test('invalid native numbers and excessive rows fail with bounded safe reasons', async () => {
  const f = fixture();
  f.data.transactions[0].tokenValue = SECRET;
  assert.equal((await runAccountingPreflight(f.options)).native.reason, 'invalid_native_transaction');
  f.data.transactions = Array(100_001).fill(f.data.transactions[0]);
  const result = await runAccountingPreflight(f.options);
  assert.equal(result.native.reason, 'row_limit');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('deadline and hung cleanup are bounded and incomplete', async () => {
  const f = fixture();
  const original = f.options.connect;
  f.options.connect = async (args) => {
    const resource = await original(args);
    args.registerClose(() => new Promise(() => {}));
    resource.db.command = () => new Promise(() => {});
    return resource;
  };
  const began = Date.now();
  const report = await runAccountingPreflight({ ...f.options, timeoutMs: 20, cleanupMs: 20 });
  assert.equal(report.reason, 'timeout');
  assert.equal(report.native.status, 'timeout');
  assert.equal(report.ledger.status, 'timeout');
  assert.ok(Date.now() - began < 1000);
  assert.deepEqual(f.closed.sort(), ['MissionAI', 'test']);
});

test('a connection resolving after timeout is closed without starting later reads', async () => {
  const f = fixture();
  let resume;
  const waiting = new Promise((resolve) => { resume = resolve; });
  const original = f.options.connect;
  f.options.connect = async (args) => { await waiting; return original(args); };
  const report = await runAccountingPreflight({ ...f.options, timeoutMs: 10, cleanupMs: 10 });
  const before = JSON.stringify(report);
  resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(report), before);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.closed.sort(), ['MissionAI', 'test']);
});

test('CLI emits exactly one safe JSON and exits zero with invalid private environment', () => {
  const child = spawnSync(process.execPath, ['accounting-preflight.js'], {
    cwd: new URL('.', import.meta.url), env: { PATH: process.env.PATH, ...env, MISSION_AI_NATIVE_ENABLED: 'true' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(child.stdout).reason, 'configuration_invalid');
  assert.equal(child.stdout.includes(SECRET), false);
});
