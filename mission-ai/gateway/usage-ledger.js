import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

const DEFAULT_DB = 'MissionAI';
const STATE_COLLECTION = 'budget_state';
const EVENT_COLLECTION = 'delegated_usage';
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

function monthKey(date, timeZone) {
  return monthStartFor(date, timeZone).toISOString();
}

function validUsd(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid_${name}`);
  return number;
}

function reservationReceipt(event) {
  return {
    reservationId: event.reservationId,
    monthStart: event.monthStart,
    reservedUsd: event.reservedUsd,
  };
}

function existingReservation(event, key, amount, metadata) {
  if (event.monthStart !== key || event.reservedUsd !== amount ||
      !isDeepStrictEqual(event.metadata, metadata)) throw new Error('reservation_conflict');
  if (event.status !== 'reserved') throw new Error('reservation_already_finalized');
  return reservationReceipt(event);
}

function settlementReceipt(event) {
  if (event.underestimated) throw new Error('reservation_underestimated');
  return { ...reservationReceipt(event), actualUsd: event.actualUsd, status: 'settled' };
}

function storedAmounts(row) {
  if (!row) return { settledUsd: 0, reservedUsd: 0 };
  for (const field of ['settledUsd', 'reservedUsd']) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < -1e-9) {
      throw new Error('ledger_state_invalid');
    }
  }
  return { settledUsd: Math.max(0, row.settledUsd), reservedUsd: Math.max(0, row.reservedUsd) };
}

function accountingBlock(blocked) {
  return blocked ? { accountingBlocked: true, accountingIssue: 'reservation_underestimated' } : {};
}

export function createMemoryUsageLedger() {
  const state = new Map();
  const events = new Map();

  function getState(key) {
    if (!state.has(key)) state.set(key, { settledUsd: 0, reservedUsd: 0 });
    return state.get(key);
  }

  return {
    async summary({ now = new Date(), timeZone = 'America/Denver' } = {}) {
      const key = monthKey(now, timeZone);
      return {
        monthStart: key,
        ...getState(key),
        ...accountingBlock([...state.values()].some((row) => row.accountingBlocked)),
      };
    },
    async breakdown({ now = new Date(), timeZone = 'America/Denver' } = {}) {
      const key = monthKey(now, timeZone);
      const groups = {
        byProvider: new Map(),
        byModel: new Map(),
        byTask: new Map(),
        byProject: new Map(),
      };
      for (const event of events.values()) {
        if (event.monthStart !== key || event.status !== 'settled') continue;
        const amount = Number(event.actualUsd || 0);
        const meta = event.metadata || {};
        const values = {
          byProvider: String(meta.provider || 'unknown'),
          byModel: String(meta.model || 'unknown'),
          byTask: String(meta.task || 'unknown'),
          byProject: String(meta.project || 'unassigned'),
        };
        for (const [group, value] of Object.entries(values)) {
          groups[group].set(value, Number(groups[group].get(value) || 0) + amount);
        }
      }
      const serialize = (map, keyName) =>
        [...map.entries()]
          .map(([name, spendUsd]) => ({ [keyName]: name, spendUsd }))
          .sort((a, b) => b.spendUsd - a.spendUsd);
      return {
        monthStart: key,
        byProvider: serialize(groups.byProvider, 'provider'),
        byModel: serialize(groups.byModel, 'model'),
        byTask: serialize(groups.byTask, 'task'),
        byProject: serialize(groups.byProject, 'project'),
      };
    },
    async reserve({
      reservationId = crypto.randomUUID(),
      reserveUsd,
      directCapUsd,
      now = new Date(),
      timeZone = 'America/Denver',
      metadata = {},
    }) {
      const amount = validUsd(reserveUsd, 'reserve_usd');
      const cap = validUsd(directCapUsd, 'direct_cap_usd');
      const key = monthKey(now, timeZone);
      if ([...state.values()].some((row) => row.accountingBlocked)) {
        throw new Error('ledger_accounting_blocked');
      }
      const previous = events.get(reservationId);
      if (previous) return existingReservation(previous, key, amount, metadata);
      const current = getState(key);
      if (current.settledUsd + current.reservedUsd + amount > cap + 1e-9) {
        throw new Error('monthly_hard_limit');
      }
      current.reservedUsd += amount;
      events.set(reservationId, {
        reservationId,
        monthStart: key,
        reservedUsd: amount,
        status: 'reserved',
        metadata: { ...metadata },
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      return { reservationId, monthStart: key, reservedUsd: amount };
    },
    async settle({ reservationId, actualUsd, usage = {} }) {
      const event = events.get(reservationId);
      const actual = validUsd(actualUsd, 'actual_usd');
      if (event?.status === 'settled') {
        if (event.actualUsd !== actual) throw new Error('settlement_conflict');
        return settlementReceipt(event);
      }
      if (!event || event.status !== 'reserved') throw new Error('reservation_not_found');
      const underestimated = actual > event.reservedUsd + 1e-9;
      const current = getState(event.monthStart);
      current.reservedUsd = Math.max(0, current.reservedUsd - event.reservedUsd);
      current.settledUsd += actual;
      event.status = 'settled';
      event.actualUsd = actual;
      event.usage = { ...usage };
      if (underestimated) {
        event.underestimated = true;
        Object.assign(current, accountingBlock(true));
      }
      return settlementReceipt(event);
    },
    async release({ reservationId, reason = 'released' }) {
      const event = events.get(reservationId);
      if (!event || event.status !== 'reserved') return false;
      const current = getState(event.monthStart);
      current.reservedUsd = Math.max(0, current.reservedUsd - event.reservedUsd);
      event.status = 'released';
      event.reason = String(reason);
      return true;
    },
    async reconcileStaleReservations({
      now = new Date(),
      maxAgeMs = DEFAULT_RESERVATION_TTL_MS,
    } = {}) {
      const cutoff = new Date(now).getTime() - Number(maxAgeMs);
      let settled = 0;
      for (const event of events.values()) {
        if (event.status !== 'reserved') continue;
        if (new Date(event.updatedAt || event.createdAt || 0).getTime() > cutoff) continue;
        const current = getState(event.monthStart);
        current.reservedUsd = Math.max(0, current.reservedUsd - event.reservedUsd);
        current.settledUsd += event.reservedUsd;
        event.status = 'settled';
        event.actualUsd = event.reservedUsd;
        event.usage = {
          ...(event.usage || {}),
          estimated: true,
          reason: 'stale_reservation',
        };
        event.updatedAt = new Date(now);
        settled += 1;
      }
      return { settled };
    },
  };
}

let cachedMongoLedger;

export function createMongoUsageLedger({
  uri =
    process.env.MISSION_AI_LEDGER_MONGO_URI ||
    process.env.MISSION_AI_MONGO_URI ||
    '',
  dbName = process.env.MISSION_AI_LEDGER_DB || DEFAULT_DB,
} = {}) {
  if (!uri) throw new Error('ledger_not_configured');

  let connection;
  let connectionPromise;
  let writeReady;
  let integrityChecked = false;

  async function db() {
    if (!connectionPromise) {
      const pending = mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        maxPoolSize: 3,
      });
      connection = pending;
      connectionPromise = pending.asPromise()
        .then(() => pending.useDb(dbName, { useCache: true }))
        .catch(async (error) => {
          await pending.close().catch(() => {});
          connectionPromise = undefined;
          throw error;
        });
    }
    return connectionPromise;
  }

  async function validateIntegrity(database, session) {
    const rows = await database.collection(STATE_COLLECTION).find({}, { session }).toArray();
    const balances = new Map(rows.map((row) => [row._id, storedAmounts(row)]));
    const totals = new Map();
    const events = database.collection(EVENT_COLLECTION).find({}, { session, projection: {
      monthStart: 1, status: 1, reservedUsd: 1, actualUsd: 1,
    } });
    for await (const event of events) {
      if (!balances.has(event.monthStart) ||
          !['reserved', 'settled', 'released'].includes(event.status) ||
          typeof event.reservedUsd !== 'number' || !Number.isFinite(event.reservedUsd) ||
          event.reservedUsd < 0 || (event.status === 'settled' &&
          (typeof event.actualUsd !== 'number' || !Number.isFinite(event.actualUsd) || event.actualUsd < 0))) {
        throw new Error('ledger_integrity_invalid');
      }
      const total = totals.get(event.monthStart) || { settledUsd: 0, reservedUsd: 0 };
      if (event.status === 'reserved') total.reservedUsd += event.reservedUsd;
      if (event.status === 'settled') total.settledUsd += event.actualUsd;
      totals.set(event.monthStart, total);
    }
    for (const [key, balance] of balances) {
      const total = totals.get(key) || { settledUsd: 0, reservedUsd: 0 };
      if (Math.abs(balance.settledUsd - total.settledUsd) > 1e-9 ||
          Math.abs(balance.reservedUsd - total.reservedUsd) > 1e-9) {
        throw new Error('ledger_integrity_invalid');
      }
    }
  }

  async function transaction(work) {
    const database = await db();
    if (!writeReady) {
      writeReady = database.collection(EVENT_COLLECTION)
        .createIndex({ reservationId: 1 }, { unique: true, name: 'reservation_id_unique' })
        .catch((error) => {
          writeReady = undefined;
          throw error;
        });
    }
    await writeReady;
    const session = await database.startSession();
    const needsIntegrityCheck = !integrityChecked;
    try {
      const result = await session.withTransaction(async () => {
        // Audit restored/legacy balances in the same snapshot as this first mutation.
        if (needsIntegrityCheck) await validateIntegrity(database, session);
        return work(database, session);
      }, {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5000,
      });
      integrityChecked = true;
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function finalize(database, session, event, status, details, now) {
    const states = database.collection(STATE_COLLECTION);
    const row = await states.findOne({ _id: event.monthStart }, { session });
    if (!row) throw new Error('ledger_state_invalid');
    const amounts = storedAmounts(row);
    const reserved = validUsd(event.reservedUsd, 'reserved_usd');
    if (amounts.reservedUsd + 1e-9 < reserved) throw new Error('ledger_state_invalid');
    const settled = status === 'settled' ? validUsd(details.actualUsd, 'actual_usd') : 0;
    const underestimated = status === 'settled' && settled > reserved + 1e-9;
    const result = { ...event, ...details, status, updatedAt: now,
      ...(underestimated ? { underestimated: true } : {}) };
    await database.collection(EVENT_COLLECTION).updateOne(
      { _id: event._id },
      { $set: { ...details, status, updatedAt: now,
        ...(underestimated ? { underestimated: true } : {}) } },
      { session },
    );
    await states.updateOne(
      { _id: event.monthStart },
      { $set: {
        reservedUsd: Math.max(0, amounts.reservedUsd - reserved),
        settledUsd: amounts.settledUsd + settled,
        updatedAt: now,
        ...accountingBlock(underestimated),
      } },
      { session },
    );
    return result;
  }

  return {
    async close() {
      await connectionPromise?.catch(() => {});
      await connection?.close();
      connection = undefined;
      connectionPromise = undefined;
      writeReady = undefined;
      integrityChecked = false;
    },

    async summary({ now = new Date(), timeZone = 'America/Denver' } = {}) {
      const key = monthKey(now, timeZone);
      const database = await db();
      const states = database.collection(STATE_COLLECTION);
      const [row, blocked] = await Promise.all([
        states.findOne({ _id: key }),
        states.findOne({ accountingBlocked: true }, { projection: { _id: 1 } }),
      ]);
      if (!row && await database.collection(EVENT_COLLECTION).findOne(
        { monthStart: key }, { projection: { _id: 1 } },
      )) throw new Error('ledger_integrity_invalid');
      return { monthStart: key, ...storedAmounts(row), ...accountingBlock(blocked) };
    },

    async breakdown({ now = new Date(), timeZone = 'America/Denver' } = {}) {
      const key = monthKey(now, timeZone);
      const database = await db();
      const rows = await database.collection(EVENT_COLLECTION).aggregate([
        { $match: { monthStart: key, status: 'settled' } },
        { $project: {
          actualUsd: '$actualUsd',
          provider: { $ifNull: ['$metadata.provider', 'unknown'] },
          model: { $ifNull: ['$metadata.model', 'unknown'] },
          task: { $ifNull: ['$metadata.task', 'unknown'] },
          project: { $ifNull: ['$metadata.project', 'unassigned'] },
        } },
      ]).toArray();
      const aggregate = (field, keyName) => {
        const totals = new Map();
        for (const row of rows) {
          const name = String(row[field] || 'unknown');
          const actual = validUsd(row.actualUsd, 'actual_usd');
          totals.set(name, Number(totals.get(name) || 0) + actual);
        }
        return [...totals.entries()]
          .map(([name, spendUsd]) => ({ [keyName]: name, spendUsd }))
          .sort((a, b) => b.spendUsd - a.spendUsd);
      };
      return {
        monthStart: key,
        byProvider: aggregate('provider', 'provider'),
        byModel: aggregate('model', 'model'),
        byTask: aggregate('task', 'task'),
        byProject: aggregate('project', 'project'),
      };
    },

    async reserve({
      reservationId = crypto.randomUUID(), reserveUsd, directCapUsd,
      now = new Date(), timeZone = 'America/Denver', metadata = {},
    }) {
      const amount = validUsd(reserveUsd, 'reserve_usd');
      const cap = validUsd(directCapUsd, 'direct_cap_usd');
      const key = monthKey(now, timeZone);
      const reserve = async (database, session) => {
        const states = database.collection(STATE_COLLECTION);
        const events = database.collection(EVENT_COLLECTION);
        if (await states.findOne({ accountingBlocked: true }, { session, projection: { _id: 1 } })) {
          throw new Error('ledger_accounting_blocked');
        }
        const previous = await events.findOne({ reservationId }, { session });
        if (previous) return existingReservation(previous, key, amount, metadata);
        const existing = await states.findOne({ _id: key }, { session });
        if (!existing && await events.findOne({ monthStart: key }, { session, projection: { _id: 1 } })) {
          throw new Error('ledger_integrity_invalid');
        }
        await states.updateOne(
          { _id: key },
          { $setOnInsert: { settledUsd: 0, reservedUsd: 0, createdAt: new Date(now) } },
          { upsert: true, session },
        );
        const current = storedAmounts(await states.findOne({ _id: key }, { session }));
        if (current.settledUsd + current.reservedUsd + amount > cap + 1e-9) {
          throw new Error('monthly_hard_limit');
        }
        await states.updateOne(
          { _id: key },
          { $set: { reservedUsd: current.reservedUsd + amount, updatedAt: new Date(now) } },
          { session },
        );
        const event = {
          reservationId, monthStart: key, reservedUsd: amount, status: 'reserved',
          metadata: { ...metadata }, createdAt: new Date(now), updatedAt: new Date(now),
        };
        await events.insertOne(event, { session });
        return reservationReceipt(event);
      };
      try {
        return await transaction(reserve);
      } catch (error) {
        // A concurrent retry may have committed this ID on another month document.
        if (error?.code !== 11000) throw error;
        return transaction(reserve);
      }
    },

    async settle({ reservationId, actualUsd, usage = {} }) {
      const actual = validUsd(actualUsd, 'actual_usd');
      const event = await transaction(async (database, session) => {
        const previous = await database.collection(EVENT_COLLECTION).findOne({ reservationId }, { session });
        if (previous?.status === 'settled') {
          if (previous.actualUsd !== actual) throw new Error('settlement_conflict');
          return previous;
        }
        if (!previous || previous.status !== 'reserved') throw new Error('reservation_not_found');
        return finalize(database, session, previous, 'settled', {
          actualUsd: actual, usage: { ...usage },
        }, new Date());
      });
      return settlementReceipt(event);
    },

    async release({ reservationId, reason = 'released' }) {
      return transaction(async (database, session) => {
        const event = await database.collection(EVENT_COLLECTION).findOne({ reservationId }, { session });
        if (!event || event.status !== 'reserved') return false;
        await finalize(database, session, event, 'released', { reason: String(reason) }, new Date());
        return true;
      });
    },

    async reconcileStaleReservations({
      now = new Date(), maxAgeMs = DEFAULT_RESERVATION_TTL_MS, limit = 100,
    } = {}) {
      const currentTime = new Date(now);
      const cutoff = new Date(currentTime.getTime() - validUsd(maxAgeMs, 'max_age_ms'));
      const database = await db();
      const stale = await database.collection(EVENT_COLLECTION)
        .find({ status: 'reserved', updatedAt: { $lte: cutoff } })
        .sort({ updatedAt: 1 }).limit(Math.max(1, Math.min(Number(limit) || 100, 1000)))
        .toArray();
      let settled = 0;
      for (const candidate of stale) {
        settled += await transaction(async (currentDatabase, session) => {
          const event = await currentDatabase.collection(EVENT_COLLECTION).findOne({
            _id: candidate._id, status: 'reserved', updatedAt: { $lte: cutoff },
          }, { session });
          if (!event) return 0;
          await finalize(currentDatabase, session, event, 'settled', {
            actualUsd: validUsd(event.reservedUsd, 'reserved_usd'),
            usage: { ...(event.usage || {}), estimated: true, reason: 'stale_reservation' },
          }, currentTime);
          return 1;
        });
      }
      return { settled };
    },
  };
}

export function defaultUsageLedger() {
  if (!cachedMongoLedger) cachedMongoLedger = createMongoUsageLedger();
  return cachedMongoLedger;
}

export function resetDefaultUsageLedger() {
  cachedMongoLedger = undefined;
}
