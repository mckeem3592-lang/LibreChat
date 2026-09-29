import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createMongoUsageLedger } from './usage-ledger.js';

let replSet;
const now = new Date('2026-09-27T18:00:00Z');
const timeZone = 'America/Denver';
const options = { now, timeZone };
const activation = () => ({
  policy: { targetUsd: 5, economyUsd: 8, hardUsd: 10 }, timeZone, cutoverAt: now,
  history: [{ id: 'test/transactions/one', at: '2026-09-02T18:00:00Z', usd: 2 }],
});

before(async () => {
  replSet = await MongoMemoryReplSet.create({
    binary: { version: process.env.MONGOMS_VERSION || '8.0.17',
      downloadDir: process.env.MONGOMS_DOWNLOAD_DIR || join(tmpdir(), 'mission-ai-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'enableTestCommands=1'] }],
  });
}, { timeout: 120000 });
after(async () => { await mongoose.disconnect(); await replSet?.stop(); });

async function fixture(t) {
  const dbName = `SharedLedgerTest_${randomUUID().replaceAll('-', '')}`;
  const uri = replSet.getUri(dbName);
  const ledgers = [];
  const open = () => {
    const ledger = createMongoUsageLedger({ uri, dbName });
    ledgers.push(ledger);
    return ledger;
  };
  const client = await new mongoose.mongo.MongoClient(uri).connect();
  t.after(async () => { await Promise.all(ledgers.map((ledger) => ledger.close())); await client.close(); });
  return { db: client.db(dbName), ledger: open(), open };
}
const reserve = (ledger, extra = {}) => ledger.reserve({ ...options, reserveUsd: 1, ...extra });

function reconciledActivation() {
  const base = activation();
  base.history[0].provider = 'anthropic';
  return { ...base, policy: { targetUsd: 2, economyUsd: 3, hardUsd: 4 }, reconciliations: [{
    provider: 'anthropic', reason: 'provider_usage_reconciliation', basis: 'provider_usage_and_published_rates',
    database: 'test', periodStart: '2026-09-01T06:00:00.000Z', periodEnd: now.toISOString(),
    coveredHistoryIds: [base.history[0].id], recordedNanoUsd: 2_000_000_000,
    providerNanoUsd: 2_500_000_000, adjustmentNanoUsd: 500_000_000,
    evidence: { usageSha256: 'a'.repeat(64), pricingSha256: 'b'.repeat(64), scopeSha256: 'c'.repeat(64) },
  }] };
}

test('reconciliation activation is atomic, restart-idempotent and preserves a distinct immutable source', async (t) => {
  const f = await fixture(t), input = reconciledActivation();
  const hold = await reserve(f.ledger, { reserveUsd: 0.1, directCapUsd: 10 });
  await f.ledger.settle({ reservationId: hold.reservationId, actualUsd: 0.1 });
  const delegatedBefore = await f.db.collection('delegated_usage').findOne({ reservationId: hold.reservationId });
  await Promise.all([f.ledger.activateSharedBudget(input), f.open().activateSharedBudget(input)]);
  await f.open().activateSharedBudget(input);
  const correction = await f.db.collection('delegated_usage').findOne({ source: 'provider-reconciliation' });
  assert.equal(correction.actualUsd, 0.5);
  assert.equal(correction.reservedUsd, 0);
  assert.equal(correction.nativeTransactionId, undefined);
  assert.equal(correction.reconciliation.basis, 'provider_usage_and_published_rates');
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'provider-reconciliation' }), 1);
  assert.deepEqual(await f.db.collection('delegated_usage').findOne({ reservationId: hold.reservationId }), delegatedBefore);
  const summary = await f.open().summary(options);
  assert.equal(summary.historyUsd, 2);
  assert.equal(summary.reconciliationUsd, 0.5);
  assert.equal(summary.delegatedUsd, 0.1);
  assert.equal(summary.settledUsd, 2.6);
  await assert.rejects(() => f.ledger.reserve({ ...options, source: 'provider-reconciliation', reserveUsd: 0.1 }), /invalid_reservation_source/);
  await assert.rejects(() => f.ledger.settle({ reservationId: correction.reservationId, actualUsd: 0.5 }), /invalid_reservation_source/);
  assert.equal(await f.ledger.release({ reservationId: correction.reservationId }), false);
  assert.deepEqual(await f.db.collection('delegated_usage').findOne({ _id: correction._id }), correction);
  await assert.rejects(() => reserve(f.open(), { reserveUsd: 1.400001 }), /monthly_hard_limit/);
  await reserve(f.open(), { reserveUsd: 1.4 });
});

test('failure inserting a correction rolls back history, counters and activation without disturbing old spend', async (t) => {
  const f = await fixture(t);
  const hold = await reserve(f.ledger, { directCapUsd: 10 });
  await f.ledger.settle({ reservationId: hold.reservationId, actualUsd: 0.1 });
  const before = await f.db.collection('budget_state').find({}).toArray();
  await f.db.command({ collMod: 'delegated_usage', validator: { source: { $ne: 'provider-reconciliation' } } });
  await assert.rejects(() => f.ledger.activateSharedBudget(reconciledActivation()), (error) => error.code === 121);
  assert.equal(await f.ledger.sharedBudget(), null);
  assert.deepEqual(await f.db.collection('budget_state').find({}).toArray(), before);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'native-history' }), 0);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'provider-reconciliation' }), 0);
  await f.db.command({ collMod: 'delegated_usage', validator: {} });
  await f.open().activateSharedBudget(reconciledActivation());
  assert.equal((await f.ledger.summary(options)).settledUsd, 2.6);
});

test('differing correction manifests cannot both commit, and activation/reservation races retain the corrected cap', async (t) => {
  const f = await fixture(t), changed = reconciledActivation();
  changed.reconciliations[0].providerNanoUsd += 100_000_000;
  changed.reconciliations[0].adjustmentNanoUsd += 100_000_000;
  const conflicts = await Promise.allSettled([f.ledger.activateSharedBudget(reconciledActivation()),
    f.open().activateSharedBudget(changed)]);
  assert.equal(conflicts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'provider-reconciliation' }), 1);
  const g = await fixture(t);
  const race = await Promise.allSettled([g.ledger.activateSharedBudget(reconciledActivation()),
    reserve(g.open(), { reserveUsd: 2, directCapUsd: 100 })]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  if (await g.ledger.sharedBudget()) {
    const summary = await g.ledger.summary(options);
    assert.equal(summary.settledUsd, 2.5);
    assert.equal(summary.reservedUsd, 0);
  } else {
    assert.equal((await g.ledger.summary(options)).reservedUsd, 2);
    assert.equal(await g.db.collection('delegated_usage').countDocuments({ source: 'provider-reconciliation' }), 0);
  }
});

test('correction counters and settled-only source restrictions survive reopening and billing month changes', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget(reconciledActivation());
  const nextMonth = await f.open().summary({ now: new Date('2026-10-02T18:00:00Z'), timeZone });
  assert.equal(nextMonth.reconciliationUsd, 0);
  await f.db.collection('budget_state').updateOne({}, { $inc: { settledUsd: -0.5 } });
  await assert.rejects(() => reserve(f.open()), /ledger_integrity_invalid/);
  await f.db.collection('budget_state').updateOne({}, { $inc: { settledUsd: 0.5 } });
  await f.db.collection('delegated_usage').updateOne({ source: 'provider-reconciliation' }, { $set: { status: 'released' } });
  await assert.rejects(() => reserve(f.open()), /ledger_integrity_invalid/);
});

test('v1 ledger activation retains its pre-reconciliation manifest hash', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget(activation());
  const control = await f.db.collection('budget_control').findOne({ _id: 'global' });
  assert.equal(control.manifestHash, '0922857a717dd911d872956299ad6f6a069cd772dda96ef7303da72598ee0834');
  assert.equal(control.manifestVersion, undefined);
  assert.equal(control.reconciliationCount, undefined);
});

test('shared cutover imports history once and preserves prior delegated settlements', async (t) => {
  const f = await fixture(t);
  const old = await reserve(f.ledger, { directCapUsd: 10 });
  await f.ledger.settle({ reservationId: old.reservationId, actualUsd: 0.5 });
  const before = await f.db.collection('delegated_usage').findOne({ reservationId: old.reservationId });
  const input = activation();
  input.history.push({ id: 'test/transactions/two', at: now, usd: 1 });
  const first = await f.ledger.activateSharedBudget(input);
  assert.deepEqual(await f.open().activateSharedBudget({ ...input, history: [...input.history].reverse() }), first);
  assert.deepEqual(await f.open().sharedBudget(), first);
  assert.deepEqual(await f.db.collection('delegated_usage').findOne({ reservationId: old.reservationId }), before);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'native-history' }), 2);
  assert.deepEqual(await f.open().summary(options), {
    monthStart: '2026-09-01T06:00:00.000Z', settledUsd: 3.5, reservedUsd: 0,
    sharedMode: true, nativeUsd: 0, delegatedUsd: 0.5, historyUsd: 3, reconciliationUsd: 0,
  });
  await assert.rejects(() => f.ledger.activateSharedBudget({ ...input, history: input.history.slice(1) }), /shared_budget_conflict/);
});

test('native and delegated concurrency share one stored hard cap across independent clients', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget(activation());
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserve(f.open(), {
    reserveUsd: 1, directCapUsd: 1000, metadata: { source: i % 2 ? 'native' : 'delegated' },
  })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.message, 'monthly_hard_limit');
  const summary = await f.ledger.summary(options);
  assert.equal(summary.settledUsd + summary.reservedUsd, 10);
  for (const result of results.filter((r) => r.status === 'fulfilled')) {
    await f.ledger.settle({ reservationId: result.value.reservationId, actualUsd: 0.5 });
  }
  const settled = await f.ledger.summary(options);
  assert.equal(settled.nativeUsd + settled.delegatedUsd, 4);
  assert.equal(settled.historyUsd, 2);
  assert.equal(settled.settledUsd, 6);
});

test('activation requires a drained ledger and imported events roll back on failure', async (t) => {
  const f = await fixture(t);
  const r = await reserve(f.ledger, { directCapUsd: 10 });
  await assert.rejects(() => f.ledger.activateSharedBudget(activation()), /shared_budget_not_drained/);
  assert.equal(await f.ledger.sharedBudget(), null);
  await f.ledger.release({ reservationId: r.reservationId });
  await f.db.command({ collMod: 'delegated_usage', validator: { source: { $ne: 'native-history' } } });
  await assert.rejects(() => f.ledger.activateSharedBudget(activation()), (error) => error.code === 121);
  assert.equal(await f.ledger.sharedBudget(), null);
  assert.equal((await f.ledger.summary(options)).settledUsd, 0);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'native-history' }), 0);
  await f.db.command({ collMod: 'delegated_usage', validator: {} });
  await f.ledger.activateSharedBudget(activation());
  assert.equal((await f.ledger.summary(options)).settledUsd, 2);
});

test('activation racing legacy admission cannot import history beside an unaccounted reservation', async (t) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const f = await fixture(t);
    const input = { ...activation(), history: [{ id: 'native-before-cutover', at: now, usd: 8 }] };
    const [activated, reserved] = await Promise.allSettled([
      f.ledger.activateSharedBudget(input), reserve(f.open(), { reserveUsd: 5, directCapUsd: 1000 }),
    ]);
    assert.equal(Number(activated.status === 'fulfilled') + Number(reserved.status === 'fulfilled'), 1);
    if (activated.status === 'fulfilled') {
      assert.equal(reserved.reason.message, 'monthly_hard_limit');
      assert.equal((await f.ledger.summary(options)).settledUsd, 8);
    } else {
      assert.equal(activated.reason.message, 'shared_budget_not_drained');
      assert.equal(await f.ledger.sharedBudget(), null);
      assert.equal((await f.ledger.summary(options)).reservedUsd, 5);
    }
  }
});

test('concurrent identical activations import one manifest, and differing manifests cannot both commit', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.ledger.activateSharedBudget(activation()), f.open().activateSharedBudget(activation())]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ source: 'native-history' }), 1);
  const second = await fixture(t);
  const changed = { ...activation(), history: [{ id: 'other', at: now, usd: 3 }] };
  const race = await Promise.allSettled([second.ledger.activateSharedBudget(activation()), second.open().activateSharedBudget(changed)]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(race.find((r) => r.status === 'rejected').reason.message, 'shared_budget_conflict');
  assert.equal(await second.db.collection('delegated_usage').countDocuments({ source: 'native-history' }), 1);
});

test('shared mode enforces timezone, source consistency, and valid caps', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => reserve(f.ledger, { source: 'native', directCapUsd: 10 }), /shared_budget_required/);
  await f.ledger.activateSharedBudget(activation());
  await assert.rejects(() => reserve(f.ledger, { timeZone: 'UTC' }), /shared_budget_timezone_mismatch/);
  await assert.rejects(() => reserve(f.ledger, { source: 'native', metadata: { source: 'delegated' } }), /invalid_reservation_source/);
  for (const directCapUsd of [-1, NaN, Infinity, null, '100']) {
    await assert.rejects(() => reserve(f.ledger, { directCapUsd }), /invalid_direct_cap_usd/);
  }
  assert.equal((await f.ledger.summary(options)).reservedUsd, 0);
});

test('history uses Denver periods and activation rejects blocked accounting', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget({ ...activation(), history: [
    { id: 'august', at: '2026-09-01T05:59:59Z', usd: 1 },
    { id: 'september', at: '2026-09-01T06:00:00Z', usd: 2 },
  ] });
  assert.equal((await f.ledger.summary({ now: new Date('2026-08-30T18:00:00Z') })).historyUsd, 1);
  assert.equal((await f.ledger.summary(options)).historyUsd, 2);
  const blocked = await fixture(t);
  const r = await reserve(blocked.ledger, { directCapUsd: 10 });
  await assert.rejects(() => blocked.ledger.settle({ reservationId: r.reservationId, actualUsd: 2 }), /reservation_underestimated/);
  await assert.rejects(() => blocked.ledger.activateSharedBudget(activation()), /ledger_accounting_blocked/);
  assert.equal(await blocked.ledger.sharedBudget(), null);
});

test('live numeric counter drift blocks native admission without reconnecting or modifying events', async (t) => {
  for (const field of ['settledUsd', 'reservedUsd']) {
    await t.test(field, async (subtest) => {
      const f = await fixture(subtest);
      await f.ledger.activateSharedBudget(activation());
      const prior = await reserve(f.ledger, { reserveUsd: 3, source: 'native' });
      if (field === 'settledUsd') await f.ledger.settle({ reservationId: prior.reservationId, actualUsd: 3 });
      await f.db.collection('budget_state').updateOne({ _id: '2026-09-01T06:00:00.000Z' }, { $set: { [field]: 0 } });
      const eventsBefore = await f.db.collection('delegated_usage').find({}).toArray();
      const statesBefore = await f.db.collection('budget_state').find({}).toArray();
      const controlBefore = await f.db.collection('budget_control').findOne({ _id: 'global' });
      await assert.rejects(() => reserve(f.ledger, { reserveUsd: 8, source: 'native' }), /ledger_integrity_invalid/);
      if (field === 'reservedUsd') {
        await assert.rejects(() => reserve(f.ledger, {
          reservationId: prior.reservationId, reserveUsd: 3, source: 'native',
        }), /ledger_integrity_invalid/);
      }
      assert.deepEqual(await f.db.collection('delegated_usage').find({}).toArray(), eventsBefore);
      assert.deepEqual(await f.db.collection('budget_state').find({}).toArray(), statesBefore);
      assert.deepEqual(await f.db.collection('budget_control').findOne({ _id: 'global' }), controlBefore);
    });
  }
});

test('restored unknown, prototype and conflicting sources fail the first mutation and source totals', async (t) => {
  const scenarios = [
    { name: 'prototype source constructor', source: 'constructor', metadataSource: 'constructor' },
    { name: 'prototype source __proto__', source: '__proto__', metadataSource: '__proto__' },
    { name: 'unknown source', source: 'unpriced', metadataSource: 'unpriced' },
    { name: 'conflicting valid sources', source: 'native', metadataSource: 'delegated' },
    { name: 'unknown metadata source', source: 'native-history', metadataSource: 'constructor' },
    { name: 'null source', source: null, metadataSource: 'native-history' },
    { name: 'empty source', source: '', metadataSource: 'native-history' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const f = await fixture(subtest);
      await f.ledger.activateSharedBudget(activation());
      await f.db.collection('delegated_usage').updateOne({ source: 'native-history' }, {
        $set: { source: scenario.source, 'metadata.source': scenario.metadataSource },
      });
      const eventsBefore = await f.db.collection('delegated_usage').find({}).toArray();
      const restored = f.open();
      await assert.rejects(() => reserve(restored, { source: 'native' }), /ledger_integrity_invalid/);
      await assert.rejects(() => restored.summary(options), /ledger_integrity_invalid/);
      assert.deepEqual(await f.db.collection('delegated_usage').find({}).toArray(), eventsBefore);
    });
  }
});

test('month audit rejects source corruption introduced after the initial integrity audit', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget(activation());
  const event = await reserve(f.ledger, { source: 'native' });
  await f.ledger.settle({ reservationId: event.reservationId, actualUsd: 0.5 });
  await f.db.collection('delegated_usage').updateOne({ reservationId: event.reservationId }, {
    $set: { source: 'constructor', 'metadata.source': 'constructor' },
  });
  await assert.rejects(() => reserve(f.ledger, { source: 'native' }), /ledger_integrity_invalid/);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({ status: 'reserved' }), 0);
});

test('unlabelled legacy events remain delegated after both full and indexed month audits', async (t) => {
  const f = await fixture(t);
  const prior = await reserve(f.ledger, { directCapUsd: 10 });
  await f.ledger.settle({ reservationId: prior.reservationId, actualUsd: 0.5 });
  await f.db.collection('delegated_usage').updateOne({ reservationId: prior.reservationId }, {
    $unset: { source: '', 'metadata.source': '' },
  });
  const restored = f.open();
  await restored.activateSharedBudget(activation());
  const native = await reserve(restored, { source: 'native' });
  await restored.settle({ reservationId: native.reservationId, actualUsd: 0.25 });
  const summary = await restored.summary(options);
  assert.equal(summary.delegatedUsd, 0.5);
  assert.equal(summary.nativeUsd, 0.25);
  assert.equal(summary.historyUsd, 2);
  assert.equal(summary.settledUsd, 2.75);
});

test('accounting quarantine remains global across months despite valid current-month sums', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget(activation());
  const prior = await reserve(f.ledger, { source: 'native' });
  await assert.rejects(() => f.ledger.settle({ reservationId: prior.reservationId, actualUsd: 2 }), /reservation_underestimated/);
  await assert.rejects(() => reserve(f.ledger, {
    now: new Date('2026-10-02T18:00:00Z'), source: 'native',
  }), /ledger_accounting_blocked/);
});

test('calendar reporting reads previous-month week events, retains estimates and leaves durable balances unchanged', async (t) => {
  const f = await fixture(t);
  await f.ledger.activateSharedBudget({ ...activation(),
    history: [{ id: 'week-history', at: '2026-09-28T12:00:00Z', usd: .2 }],
    cutoverAt: '2026-09-29T12:00:00Z' });
  const reportNow = new Date('2026-10-01T18:00:00Z');
  const hold = await f.ledger.reserve({ now: reportNow, timeZone, source: 'native', reserveUsd: .1 });
  await f.ledger.settle({ reservationId: hold.reservationId, actualUsd: .1, usage: { estimated: true } });
  const before = await f.db.collection('budget_state').find({}).toArray();
  const eventsBefore = await f.db.collection('delegated_usage').find({}).toArray();
  const periods = await f.open().spendingPeriods({ now: reportNow, timeZone });
  assert.equal(periods.todayUsd, .1);
  assert.ok(Math.abs(periods.weekUsd - .3) < 1e-9);
  assert.equal(periods.weekEstimatedUsd, .1);
  assert.equal(periods.monthUnallocatedUsd, 0);
  assert.deepEqual(await f.db.collection('budget_state').find({}).toArray(), before);
  assert.deepEqual(await f.db.collection('delegated_usage').find({}).toArray(), eventsBefore);
});
