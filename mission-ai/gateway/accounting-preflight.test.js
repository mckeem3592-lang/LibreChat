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
  assert.equal(report.native.providerTotalsMatch, true);
  assert.deepEqual(report.native.byProvider, [
    { provider: 'openai', transactionCount: 2, spendUsd: 0.065 },
    { provider: 'anthropic', transactionCount: 0, spendUsd: 0 },
    { provider: 'google', transactionCount: 0, spendUsd: 0 },
    { provider: 'unknown', transactionCount: 0, spendUsd: 0 },
  ]);
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
  assert.ok(output.length < 5000);
});

test('fixed provider usage reports exact signed token magnitudes with row completeness and no extra reads', async () => {
  const f = fixture();
  f.options.catalogLoader = async () => ({ providers: {
    openai: { economy: 'private-openai-model' }, anthropic: { economy: 'private-anthropic-model' },
    google: { economy: 'private-google-model' },
  } });
  f.data.transactions = ['openai', 'anthropic', 'google', 'unlisted'].flatMap((provider, i) => [
    { _id: `private-prompt-${i}`, createdAt: NOW, tokenType: 'prompt', tokenValue: -10_000,
      model: `private-${provider}-model`, rawAmount: -(i + 15), inputTokens: i + 10,
      writeTokens: -3, readTokens: 2, cacheDuration: SECRET },
    { _id: `private-output-${i}`, createdAt: NOW, tokenType: 'completion', tokenValue: -20_000,
      model: `private-${provider}-model`, rawAmount: -(i + 4), inputTokens: SECRET },
  ]);
  const before = structuredClone(f.data);
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  assert.deepEqual(report.native.byProviderUsage, ['openai', 'anthropic', 'google', 'unknown'].map((provider, i) => ({
    provider, transactionCount: 2, promptRows: 1, completionRows: 1,
    completeRows: 2, incompleteRows: 0, missingFieldRows: 0, invalidFieldRows: 0,
    promptTotalMismatchRows: 0, unsafeTotal: false, usageComplete: true,
    inputTokens: i + 10, writeTokens: 3, readTokens: 2, outputTokens: i + 4,
  })));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.find((call) => call.name === 'transactions').projection,
    { _id: 1, createdAt: 1, tokenType: 1, tokenValue: 1, model: 1,
      rawAmount: 1, inputTokens: 1, writeTokens: 1, readTokens: 1 });
  assert.deepEqual(f.calls.find((call) => call.name === 'transactions').filter,
    { createdAt: { $gte: new Date(MONTH) }, tokenType: { $in: ['prompt', 'completion'] } });
  assert.deepEqual(f.data, before);
  for (const privateValue of [SECRET, 'private-', 'cacheDuration']) {
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
});

for (const [label, edit, expected] of [
  ['missing category', row => { delete row.writeTokens; }, { missingFieldRows: 1 }],
  ['missing raw total', row => { row.rawAmount = null; }, { missingFieldRows: 1 }],
  ['numeric string', row => { row.inputTokens = '10'; }, { invalidFieldRows: 1 }],
  ['arbitrary data', row => { row.readTokens = { private: SECRET }; }, { invalidFieldRows: 1 }],
  ['fraction', row => { row.inputTokens = 1.5; }, { invalidFieldRows: 1 }],
  ['NaN', row => { row.inputTokens = NaN; }, { invalidFieldRows: 1 }],
  ['infinity', row => { row.inputTokens = Infinity; }, { invalidFieldRows: 1 }],
  ['unsafe integer', row => { row.inputTokens = Number.MAX_SAFE_INTEGER + 1; }, { invalidFieldRows: 1 }],
  ['positive raw total', row => { row.rawAmount = 15; }, { invalidFieldRows: 1 }],
  ['zero charged raw total', row => { Object.assign(row, { rawAmount: 0, inputTokens: 0, writeTokens: 0, readTokens: 0 }); },
    { invalidFieldRows: 1 }],
  ['inconsistent total', row => { row.rawAmount = -16; }, { promptTotalMismatchRows: 1 }],
]) test(`native usage marks ${label} incomplete without invalidating money or guessing missing tokens`, async () => {
  const f = fixture();
  Object.assign(f.data.transactions[0], { rawAmount: -15, inputTokens: 10, writeTokens: 3, readTokens: 2 });
  f.data.transactions[1].rawAmount = -4;
  edit(f.data.transactions[0]);
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  assert.equal(report.native.status, 'observed');
  assert.equal(report.native.nativeUsd, 0.065);
  assert.equal(report.native.providerTotalsMatch, true);
  const usage = report.native.byProviderUsage[0];
  assert.equal(usage.usageComplete, false);
  assert.equal(usage.completeRows, 1);
  assert.equal(usage.incompleteRows, 1);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.writeTokens, null);
  assert.equal(usage.readTokens, null);
  assert.equal(usage.outputTokens, 4);
  for (const [key, value] of Object.entries(expected)) assert.equal(usage[key], value);
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});

test('incomplete completion usage does not erase independently complete prompt totals', async () => {
  const f = fixture();
  Object.assign(f.data.transactions[0], { rawAmount: -15, inputTokens: 10, writeTokens: 3, readTokens: 2 });
  const usage = (await runAccountingPreflight(f.options)).native.byProviderUsage[0];
  assert.equal(usage.usageComplete, false);
  assert.equal(usage.missingFieldRows, 1);
  assert.equal(usage.completeRows, 1);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.writeTokens, 3);
  assert.equal(usage.readTokens, 2);
  assert.equal(usage.outputTokens, null);
});

test('a charged completion with zero raw tokens is incomplete despite its present numeric field', async () => {
  const f = fixture();
  f.data.transactions = [{ ...f.data.transactions[1], rawAmount: -0 }];
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  assert.equal(report.native.nativeUsd, 0.005);
  const usage = report.native.byProviderUsage[0];
  assert.equal(usage.usageComplete, false);
  assert.equal(usage.invalidFieldRows, 1);
  assert.equal(usage.missingFieldRows, 0);
  assert.equal(usage.outputTokens, null);
});

test('prompt row sum overflow is incomplete and never rounded into an apparent match', async () => {
  const f = fixture();
  Object.assign(f.data.transactions[0], { rawAmount: -Number.MAX_SAFE_INTEGER,
    inputTokens: Number.MAX_SAFE_INTEGER, writeTokens: 1, readTokens: 0 });
  f.data.transactions[1].rawAmount = -4;
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  const usage = report.native.byProviderUsage[0];
  assert.equal(usage.usageComplete, false);
  assert.equal(usage.unsafeTotal, true);
  assert.equal(usage.incompleteRows, 1);
  assert.equal(usage.promptTotalMismatchRows, 0);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, 4);
});

for (const tokenType of ['prompt', 'completion']) test(`${tokenType} aggregate overflow is null despite individually complete rows`, async () => {
  const f = fixture();
  f.data.transactions = [Number.MAX_SAFE_INTEGER, 1].map((count, i) => ({
    _id: `private-overflow-${i}`, createdAt: NOW, tokenType, tokenValue: -10_000, model: 'gpt-6-luna',
    rawAmount: -count, ...(tokenType === 'prompt' ? { inputTokens: count, writeTokens: 0, readTokens: 0 } : {}),
  }));
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  const usage = report.native.byProviderUsage[0];
  assert.equal(usage.transactionCount, 2);
  assert.equal(usage.completeRows, 2);
  assert.equal(usage.incompleteRows, 0);
  assert.equal(usage.unsafeTotal, true);
  assert.equal(usage.usageComplete, false);
  assert.equal(usage[tokenType === 'prompt' ? 'inputTokens' : 'outputTokens'], null);
});

test('credits and zero-value rows cannot add usage or make a complete charged aggregate incomplete', async () => {
  const f = fixture();
  Object.assign(f.data.transactions[0], { rawAmount: -15, inputTokens: 10, writeTokens: 3, readTokens: 2 });
  f.data.transactions[1].rawAmount = -4;
  Object.assign(f.data.transactions[2], { rawAmount: SECRET, inputTokens: Number.MAX_SAFE_INTEGER,
    writeTokens: SECRET, readTokens: SECRET, model: 'private-credit-model' });
  f.data.transactions.push({ ...f.data.transactions[2], _id: 'private-zero-id', tokenValue: 0 });
  const report = await runAccountingPreflight(f.options);
  const usage = report.native.byProviderUsage[0];
  assert.equal(usage.transactionCount, 2);
  assert.equal(usage.usageComplete, true);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 4);
  assert.equal(report.native.byProviderUsage[3].transactionCount, 0);
  assert.equal(f.calls.length, 3);
  for (const value of [SECRET, 'private-credit-model', 'private-zero-id']) {
    assert.equal(JSON.stringify(report).includes(value), false);
  }
});

test('provider row counts and spend reconcile across providers without new queries or model disclosure', async () => {
  const f = fixture();
  f.options.catalogLoader = async () => ({ providers: {
    openai: { economy: 'private-openai-model' }, anthropic: { economy: 'private-anthropic-model' },
    google: { economy: 'private-google-model' },
  } });
  f.data.transactions = ['openai', 'anthropic', 'anthropic', 'google', 'unlisted'].map((provider, index) => ({
    _id: `private-row-${index}`, createdAt: NOW, tokenType: index % 2 ? 'completion' : 'prompt',
    tokenValue: -(index + 1) * 10_000, model: `private-${provider}-model`,
  }));
  const result = await runAccountingPreflight(f.options);
  assert.equal(result.native.transactionCount, 5);
  assert.ok(Math.abs(result.native.nativeUsd - 0.15) < 1e-12);
  assert.deepEqual(result.native.byProvider, [
    { provider: 'openai', transactionCount: 1, spendUsd: 0.01 },
    { provider: 'anthropic', transactionCount: 2, spendUsd: 0.05 },
    { provider: 'google', transactionCount: 1, spendUsd: 0.04 },
    { provider: 'unknown', transactionCount: 1, spendUsd: 0.05 },
  ]);
  assert.equal(result.native.byProvider.reduce((sum, row) => sum + row.transactionCount, 0), result.native.transactionCount);
  assert.ok(Math.abs(result.native.byProvider.reduce((sum, row) => sum + row.spendUsd, 0) - result.native.nativeUsd) < 1e-12);
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('unrecognized and unsafe provider labels collapse to unknown without creating unsafe properties', async () => {
  const f = fixture();
  const labels = ['__proto__', 'constructor', 'prototype', `<script>${SECRET}</script>`];
  f.options.catalogLoader = async () => ({ providers: Object.fromEntries(labels.map((label, index) =>
    [label, { economy: `private-model-${index}` }])) });
  f.data.transactions = labels.map((_, index) => ({ _id: `private-id-${index}`, createdAt: NOW,
    tokenType: 'completion', tokenValue: -10_000, model: `private-model-${index}` }));
  const result = await runAccountingPreflight(f.options);
  assert.equal(result.native.providerTotalsMatch, true);
  assert.deepEqual(result.native.byProvider[3], { provider: 'unknown', transactionCount: 4, spendUsd: 0.04 });
  assert.equal(result.native.byProviderUsage[3].transactionCount, 4);
  assert.equal(result.native.byProviderUsage[3].missingFieldRows, 4);
  assert.equal(result.native.byProviderUsage[3].outputTokens, null);
  assert.ok(result.native.byProvider.slice(0, 3).every((row) => row.transactionCount === 0 && row.spendUsd === 0));
  for (const row of result.native.byProvider) assert.deepEqual(Object.keys(row), ['provider', 'transactionCount', 'spendUsd']);
  for (const value of [...labels, 'private-model-', 'private-id-']) assert.equal(JSON.stringify(result).includes(value), false);
});

test('empty charged history has zero provider totals and credits are excluded', async () => {
  const f = fixture();
  f.data.transactions = f.data.transactions.filter((row) => row.tokenValue > 0);
  const result = await runAccountingPreflight(f.options);
  assert.equal(result.native.transactionCount, 0);
  assert.equal(result.native.nativeUsd, 0);
  assert.equal(result.native.providerTotalsMatch, true);
  assert.ok(result.native.byProvider.every((row) => row.transactionCount === 0 && row.spendUsd === 0));
  assert.ok(result.native.byProviderUsage.every((row) => row.transactionCount === 0 && row.usageComplete &&
    row.inputTokens === 0 && row.writeTokens === 0 && row.readTokens === 0 && row.outputTokens === 0));
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
  Object.assign(f.summary, { sharedMode: true, nativeUsd: 0, historyUsd: 0, delegatedUsd: 0.01, reconciliationUsd: 0 });
  assert.equal((await runAccountingPreflight(f.options)).ledger.sharedActivation, 'active');
  f.summary.delegatedUsd = 0;
  assert.equal((await runAccountingPreflight(f.options)).ledger.reason, 'ledger_changed_during_observation');
});

test('settled provider reconciliation is a separate checked partition without reading its private evidence', async () => {
  const f = fixture();
  f.data.delegated_usage.push({ reservationId: 'private-reconciliation-id', monthStart: MONTH,
    status: 'settled', reservedUsd: 0, actualUsd: 0.02, source: 'provider-reconciliation',
    metadata: { source: 'provider-reconciliation' }, reconciliation: { privateEvidence: SECRET } });
  f.data.budget_state[0].settledUsd = f.summary.settledUsd = 0.03;
  const factory = f.options.ledgerFactory;
  f.options.ledgerFactory = () => ({ ...factory(), sharedBudget: async () => ({ mode: 'shared', timeZone: 'America/Denver' }) });
  Object.assign(f.summary, { sharedMode: true, nativeUsd: 0, historyUsd: 0, delegatedUsd: 0.01, reconciliationUsd: 0.02 });
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.status, 'provisional');
  assert.equal(report.ledger.stateEventsMatch, true);
  assert.equal(report.ledger.readSummaryMatches, true);
  assert.deepEqual(report.ledger.partitions, { nativeUsd: 0, delegatedUsd: 0.01, historyUsd: 0, reconciliationUsd: 0.02 });
  assert.equal(report.ledger.settledUsd, 0.03);
  assert.equal(f.calls.length, 3);
  const projection = f.calls.find((call) => call.name === 'delegated_usage').projection;
  assert.equal(Object.keys(projection).some((key) => key.startsWith('reconciliation')), false);
  for (const value of [SECRET, 'private-reconciliation-id', 'privateEvidence']) {
    assert.equal(JSON.stringify(report).includes(value), false);
  }
  f.summary.reconciliationUsd = 0;
  assert.equal((await runAccountingPreflight(f.options)).ledger.reason, 'ledger_changed_during_observation');
});

for (const status of ['reserved', 'released']) test(`provider reconciliation cannot appear as ${status}`, async () => {
  const f = fixture();
  f.data.delegated_usage[0].source = 'provider-reconciliation';
  f.data.delegated_usage[0].metadata.source = 'provider-reconciliation';
  f.data.delegated_usage[0].status = status;
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.ledger.reason, 'ledger_integrity_invalid');
  assert.equal(report.native.status, 'observed');
});

test('provider reconciliation source conflicts remain invalid', async () => {
  const f = fixture();
  f.data.delegated_usage[0].source = 'provider-reconciliation';
  const report = await runAccountingPreflight(f.options);
  assert.equal(report.ledger.reason, 'ledger_integrity_invalid');
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
