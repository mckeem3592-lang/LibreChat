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
const options = { now, timeZone: 'America/Denver' };
const monthStart = '2026-09-01T06:00:00.000Z';

before(async () => {
  replSet = await MongoMemoryReplSet.create({
    binary: {
      version: process.env.MONGOMS_VERSION || '8.0.17',
      downloadDir: process.env.MONGOMS_DOWNLOAD_DIR || join(tmpdir(), 'mission-ai-mongodb'),
    },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'enableTestCommands=1'] }],
  });
}, { timeout: 120000 });

after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

async function fixture(t) {
  const dbName = `MissionAILedgerTest_${randomUUID().replaceAll('-', '')}`;
  const uri = replSet.getUri(dbName);
  const ledgers = [];
  const open = () => {
    const ledger = createMongoUsageLedger({ uri, dbName });
    ledgers.push(ledger);
    return ledger;
  };
  const client = await new mongoose.mongo.MongoClient(uri).connect();
  t.after(async () => {
    await Promise.all(ledgers.map((ledger) => ledger.close()));
    await client.close();
  });
  return { db: client.db(dbName), client, ledger: open(), open };
}

async function totals(db, expected) {
  const states = await db.collection('budget_state').find({}).toArray();
  const events = await db.collection('delegated_usage').find({}).toArray();
  const settledUsd = events.filter((e) => e.status === 'settled').reduce((sum, e) => sum + e.actualUsd, 0);
  const reservedUsd = events.filter((e) => e.status === 'reserved').reduce((sum, e) => sum + e.reservedUsd, 0);
  assert.ok(Math.abs(states.reduce((sum, row) => sum + row.settledUsd, 0) - settledUsd) < 1e-9);
  assert.ok(Math.abs(states.reduce((sum, row) => sum + row.reservedUsd, 0) - reservedUsd) < 1e-9);
  assert.deepEqual({ settledUsd, reservedUsd }, expected);
}

const reserve = (ledger, extra = {}) => ledger.reserve({ reserveUsd: 3, directCapUsd: 10, ...options, ...extra });

test('Mongo commits reserve/settle/release and retains state across ledger clients', async (t) => {
  const f = await fixture(t);
  const first = await reserve(f.ledger, { metadata: { provider: 'openai', model: 'fixture', task: 'chat', project: 'test' } });
  await f.ledger.close();
  const restarted = f.open();
  assert.deepEqual(await restarted.summary(options), { monthStart, settledUsd: 0, reservedUsd: 3 });
  await restarted.settle({ reservationId: first.reservationId, actualUsd: 1.25 });
  const second = await reserve(restarted, { reserveUsd: 2 });
  assert.equal(await restarted.release({ reservationId: second.reservationId }), true);
  assert.equal(await restarted.release({ reservationId: second.reservationId }), false);
  await restarted.close();
  assert.deepEqual(await f.open().summary(options), { monthStart, settledUsd: 1.25, reservedUsd: 0 });
  assert.deepEqual((await f.open().breakdown(options)).byProvider, [{ provider: 'openai', spendUsd: 1.25 }]);
  await totals(f.db, { settledUsd: 1.25, reservedUsd: 0 });
});

test('concurrent reservations cannot exceed one shared hard cap', async (t) => {
  const f = await fixture(t);
  const ledgers = [f.ledger, f.open(), f.open()];
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
    reserve(ledgers[i % ledgers.length], { reserveUsd: 1, directCapUsd: 5 })));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 5);
  for (const result of outcomes.filter((r) => r.status === 'rejected')) {
    assert.equal(result.reason.message, 'monthly_hard_limit');
  }
  assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 5);
  await totals(f.db, { settledUsd: 0, reservedUsd: 5 });
});

test('reservation and settlement retries are idempotent and conflicting reuse fails closed', async (t) => {
  const f = await fixture(t);
  const input = { reservationId: 'same-request', metadata: { project: 'test' } };
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => reserve(f.open(), input)));
  assert.ok(outcomes.every((r) => r.reservationId === 'same-request'));
  assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 1);
  await assert.rejects(() => reserve(f.ledger, { ...input, reserveUsd: 4 }), /reservation_conflict/);
  await assert.rejects(() => reserve(f.ledger, { ...input, metadata: { project: 'other' } }), /reservation_conflict/);
  await Promise.all(Array.from({ length: 4 }, () => f.open().settle({ reservationId: 'same-request', actualUsd: 1.25 })));
  await assert.rejects(() => f.ledger.settle({ reservationId: 'same-request', actualUsd: 1.5 }), /settlement_conflict/);
  await assert.rejects(() => reserve(f.ledger, input), /reservation_already_finalized/);
  await totals(f.db, { settledUsd: 1.25, reservedUsd: 0 });
});

test('failed event insertion rolls back its budget reservation', async (t) => {
  const f = await fixture(t);
  await f.db.createCollection('delegated_usage', { validator: { requiredFixtureField: { $exists: true } } });
  await assert.rejects(() => reserve(f.ledger), (error) => error.code === 121);
  assert.deepEqual(await f.ledger.summary(options), { monthStart, settledUsd: 0, reservedUsd: 0 });
  assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 0);
  await totals(f.db, { settledUsd: 0, reservedUsd: 0 });
});

test('failed state settlement rolls back the event and can be retried exactly once', async (t) => {
  const f = await fixture(t);
  const r = await reserve(f.ledger);
  await f.db.command({ collMod: 'budget_state', validator: { settledUsd: { $lte: 0 } } });
  await assert.rejects(() => f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1 }), (error) => error.code === 121);
  assert.equal((await f.db.collection('delegated_usage').findOne({ reservationId: r.reservationId })).status, 'reserved');
  await totals(f.db, { settledUsd: 0, reservedUsd: 3 });
  await f.db.command({ collMod: 'budget_state', validator: {} });
  await f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1 });
  await f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1 });
  await totals(f.db, { settledUsd: 1, reservedUsd: 0 });
});

test('failed release leaves both event and state reserved until successful retry', async (t) => {
  const f = await fixture(t);
  const r = await reserve(f.ledger);
  await f.db.command({ collMod: 'budget_state', validator: { reservedUsd: { $gte: 3 } } });
  await assert.rejects(() => f.ledger.release({ reservationId: r.reservationId }), (error) => error.code === 121);
  assert.equal((await f.db.collection('delegated_usage').findOne({ reservationId: r.reservationId })).status, 'reserved');
  await totals(f.db, { settledUsd: 0, reservedUsd: 3 });
  await f.db.command({ collMod: 'budget_state', validator: {} });
  assert.equal(await f.ledger.release({ reservationId: r.reservationId }), true);
  await totals(f.db, { settledUsd: 0, reservedUsd: 0 });
});

test('concurrent settlement/release has one terminal outcome and no double debit', async (t) => {
  const f = await fixture(t);
  const r = await reserve(f.ledger);
  const results = await Promise.allSettled([
    f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1 }),
    f.open().release({ reservationId: r.reservationId }),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') assert.equal(result.reason.message, 'reservation_not_found');
  }
  const event = await f.db.collection('delegated_usage').findOne({ reservationId: r.reservationId });
  assert.ok(['settled', 'released'].includes(event.status));
  await totals(f.db, { settledUsd: event.status === 'settled' ? 1 : 0, reservedUsd: 0 });
});

test('overrun records the real charge and blocks new reservations across month boundaries', async (t) => {
  const f = await fixture(t);
  const r = await reserve(f.ledger, { reserveUsd: 1 });
  await assert.rejects(() => f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1.5 }), /reservation_underestimated/);
  await assert.rejects(() => f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1.5 }), /reservation_underestimated/);
  await totals(f.db, { settledUsd: 1.5, reservedUsd: 0 });
  assert.equal((await f.ledger.summary(options)).accountingBlocked, true);
  const nextMonth = new Date('2026-10-02T18:00:00Z');
  assert.equal((await f.open().summary({ now: nextMonth })).accountingBlocked, true);
  await assert.rejects(() => reserve(f.ledger), /ledger_accounting_blocked/);
  await assert.rejects(() => reserve(f.ledger, { now: nextMonth }), /ledger_accounting_blocked/);
  assert.equal(await f.ledger.release({ reservationId: r.reservationId }), false);
});

test('stale settlement is atomic, retryable, and remains in the reservation month', async (t) => {
  const f = await fixture(t);
  const oldNow = new Date('2026-09-01T05:50:00Z');
  const reconcileAt = new Date('2026-09-01T06:06:00Z');
  const r = await reserve(f.ledger, { now: oldNow });
  await f.db.command({ collMod: 'budget_state', validator: { settledUsd: { $lte: 0 } } });
  await assert.rejects(() => f.ledger.reconcileStaleReservations({ now: reconcileAt }), (error) => error.code === 121);
  await totals(f.db, { settledUsd: 0, reservedUsd: 3 });
  await f.db.command({ collMod: 'budget_state', validator: {} });
  const results = await Promise.all([
    f.ledger.reconcileStaleReservations({ now: reconcileAt }),
    f.open().reconcileStaleReservations({ now: reconcileAt }),
  ]);
  assert.equal(results.reduce((sum, value) => sum + value.settled, 0), 1);
  assert.equal((await f.ledger.summary({ now: oldNow })).settledUsd, 3);
  assert.equal((await f.ledger.summary({ now: reconcileAt })).settledUsd, 0);
  const event = await f.db.collection('delegated_usage').findOne({ reservationId: r.reservationId });
  assert.equal(event.usage.estimated, true);
  await totals(f.db, { settledUsd: 3, reservedUsd: 0 });
});

test('Denver monthly keys preserve standard and daylight time boundaries', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['2026-03-01T06:59:59.999Z', '2026-02-01T07:00:00.000Z'],
    ['2026-03-01T07:00:00.000Z', '2026-03-01T07:00:00.000Z'],
    ['2026-04-01T06:00:00.000Z', '2026-04-01T06:00:00.000Z'],
    ['2026-11-01T06:00:00.000Z', '2026-11-01T06:00:00.000Z'],
    ['2026-12-01T07:00:00.000Z', '2026-12-01T07:00:00.000Z'],
  ];
  for (const [at, expected] of cases) {
    const r = await reserve(f.ledger, { reserveUsd: 1, now: new Date(at) });
    assert.equal(r.monthStart, expected);
    await f.ledger.settle({ reservationId: r.reservationId, actualUsd: 0.5 });
    assert.equal((await f.ledger.summary({ now: new Date(at) })).settledUsd, 0.5);
  }
  await totals(f.db, { settledUsd: 2.5, reservedUsd: 0 });
});

test('legacy duplicate IDs fail closed instead of enabling ambiguous settlement', async (t) => {
  const f = await fixture(t);
  await f.db.collection('delegated_usage').insertMany([
    { reservationId: 'duplicate' }, { reservationId: 'duplicate' },
  ]);
  await assert.rejects(() => reserve(f.ledger), (error) => error.code === 11000);
  assert.equal(await f.db.collection('budget_state').countDocuments({}), 0);
});

test('transient write failure retries the transaction without duplicating capacity', async (t) => {
  const f = await fixture(t);
  const admin = f.client.db('admin');
  await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: {
    failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'],
  } });
  try {
    const r = await reserve(f.ledger, { reservationId: 'transient-retry' });
    assert.equal(r.reservationId, 'transient-retry');
    assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 1);
    await totals(f.db, { settledUsd: 0, reservedUsd: 3 });
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
  }
});

test('unknown commit result is retried without repeating ledger increments', async (t) => {
  const f = await fixture(t);
  const r = await reserve(f.ledger);
  const admin = f.client.db('admin');
  await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: {
    failCommands: ['commitTransaction'], errorCode: 91, errorLabels: ['UnknownTransactionCommitResult'],
  } });
  try {
    await f.ledger.settle({ reservationId: r.reservationId, actualUsd: 1 });
    await totals(f.db, { settledUsd: 1, reservedUsd: 0 });
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
  }
});

test('concurrent read initialization shares one connection and creates no ledger collections', async (t) => {
  const f = await fixture(t);
  const connectedBefore = mongoose.connections.filter((c) => c.readyState === 1).length;
  await Promise.all(Array.from({ length: 10 }, () => f.ledger.summary(options)));
  await f.ledger.breakdown(options);
  assert.equal(mongoose.connections.filter((c) => c.readyState === 1).length, connectedBefore + 1);
  assert.deepEqual(await f.db.listCollections({}, { nameOnly: true }).toArray(), []);
  await f.ledger.close();
  assert.equal(mongoose.connections.filter((c) => c.readyState === 1).length, connectedBefore);
});

test('invalid persisted budget values stop reads and new reservations', async (t) => {
  const f = await fixture(t);
  await f.db.collection('budget_state').insertOne({ _id: monthStart, settledUsd: NaN, reservedUsd: 0 });
  await assert.rejects(() => f.ledger.summary(options), /ledger_state_invalid/);
  await assert.rejects(() => reserve(f.ledger), /ledger_state_invalid/);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 0);
});

test('restored orphan events and numeric balance drift fail closed without changing history', async (t) => {
  const cases = [
    { name: 'orphan reserved event', status: 'reserved' },
    { name: 'orphan settled event', status: 'settled' },
    { name: 'orphan released event', status: 'released' },
    { name: 'undercounted reservation', status: 'reserved', balance: { reservedUsd: 1, settledUsd: 0 } },
    { name: 'undercounted settlement', status: 'settled', balance: { reservedUsd: 0, settledUsd: 1 } },
    { name: 'overcounted settlement', status: 'settled', balance: { reservedUsd: 0, settledUsd: 5 } },
    { name: 'balance without events', balance: { reservedUsd: 3, settledUsd: 0 } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const f = await fixture(subtest);
      if (scenario.status) await f.db.collection('delegated_usage').insertOne({
        reservationId: 'restored-event', monthStart, reservedUsd: 3,
        status: scenario.status, ...(scenario.status === 'settled' ? { actualUsd: 2 } : {}),
        updatedAt: now,
      });
      if (scenario.balance) await f.db.collection('budget_state').insertOne({ _id: monthStart, ...scenario.balance });
      const eventsBefore = await f.db.collection('delegated_usage').find({}).toArray();
      const statesBefore = await f.db.collection('budget_state').find({}).toArray();
      if (!scenario.balance) await assert.rejects(() => f.ledger.summary(options), /ledger_integrity_invalid/);
      await assert.rejects(() => reserve(f.ledger, { now: new Date('2026-10-02T18:00:00Z') }), /ledger_integrity_invalid/);
      await assert.rejects(() => f.ledger.release({ reservationId: 'restored-event' }), /ledger_integrity_invalid/);
      assert.deepEqual(await f.db.collection('delegated_usage').find({}).toArray(), eventsBefore);
      assert.deepEqual(await f.db.collection('budget_state').find({}).toArray(), statesBefore);
    });
  }
});

test('a missing balance cannot be recreated over existing events after initial validation', async (t) => {
  const f = await fixture(t);
  await reserve(f.ledger);
  await f.db.collection('budget_state').deleteOne({ _id: monthStart });
  await assert.rejects(() => reserve(f.ledger), /ledger_integrity_invalid/);
  assert.equal(await f.db.collection('budget_state').countDocuments({}), 0);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 1);
});

test('reopening a connection audits restored numeric drift again', async (t) => {
  const f = await fixture(t);
  await reserve(f.ledger);
  await f.ledger.close();
  await f.db.collection('budget_state').updateOne({ _id: monthStart }, { $set: { reservedUsd: 1 } });
  await assert.rejects(() => reserve(f.ledger), /ledger_integrity_invalid/);
  assert.equal((await f.db.collection('budget_state').findOne({ _id: monthStart })).reservedUsd, 1);
  assert.equal(await f.db.collection('delegated_usage').countDocuments({}), 1);
});
