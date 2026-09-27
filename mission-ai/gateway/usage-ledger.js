import crypto from 'node:crypto';
import mongoose from 'mongoose';
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
      return { monthStart: key, ...getState(key) };
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
      if (!event || event.status !== 'reserved') throw new Error('reservation_not_found');
      const actual = validUsd(actualUsd, 'actual_usd');
      if (actual > event.reservedUsd + 1e-9) throw new Error('reservation_underestimated');
      const current = getState(event.monthStart);
      current.reservedUsd = Math.max(0, current.reservedUsd - event.reservedUsd);
      current.settledUsd += actual;
      event.status = 'settled';
      event.actualUsd = actual;
      event.usage = { ...usage };
      return { ...event };
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
  uri = process.env.MISSION_AI_LEDGER_MONGO_URI || '',
  dbName = process.env.MISSION_AI_LEDGER_DB || DEFAULT_DB,
} = {}) {
  if (!uri) throw new Error('ledger_not_configured');

  let connection;
  async function db() {
    if (!connection) {
      connection = await mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        maxPoolSize: 3,
      }).asPromise();
    }
    return connection.useDb(dbName);
  }

  return {
    async summary({ now = new Date(), timeZone = 'America/Denver' } = {}) {
      const key = monthKey(now, timeZone);
      const database = await db();
      const row = await database.collection(STATE_COLLECTION).findOne({ _id: key });
      return {
        monthStart: key,
        settledUsd: Number(row?.settledUsd || 0),
        reservedUsd: Number(row?.reservedUsd || 0),
      };
    },

    async breakdown({ now = new Date(), timeZone = 'America/Denver' } = {}) {
      const key = monthKey(now, timeZone);
      const database = await db();
      const rows = await database.collection(EVENT_COLLECTION).aggregate([
        { $match: { monthStart: key, status: 'settled' } },
        {
          $project: {
            actualUsd: { $ifNull: ['$actualUsd', 0] },
            provider: { $ifNull: ['$metadata.provider', 'unknown'] },
            model: { $ifNull: ['$metadata.model', 'unknown'] },
            task: { $ifNull: ['$metadata.task', 'unknown'] },
            project: { $ifNull: ['$metadata.project', 'unassigned'] },
          },
        },
      ]).toArray();

      const aggregate = (field, keyName) => {
        const totals = new Map();
        for (const row of rows) {
          const name = String(row[field] || 'unknown');
          totals.set(name, Number(totals.get(name) || 0) + Number(row.actualUsd || 0));
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
      const database = await db();
      const stateCollection = database.collection(STATE_COLLECTION);
      const eventCollection = database.collection(EVENT_COLLECTION);

      await stateCollection.updateOne(
        { _id: key },
        {
          $setOnInsert: {
            settledUsd: 0,
            reservedUsd: 0,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

      const stateResult = await stateCollection.findOneAndUpdate(
        {
          _id: key,
          $expr: {
            $lte: [
              {
                $add: [
                  { $ifNull: ['$settledUsd', 0] },
                  { $ifNull: ['$reservedUsd', 0] },
                  amount,
                ],
              },
              cap,
            ],
          },
        },
        {
          $inc: { reservedUsd: amount },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'after' },
      );
      if (!stateResult) throw new Error('monthly_hard_limit');

      try {
        await eventCollection.insertOne({
          reservationId,
          monthStart: key,
          reservedUsd: amount,
          status: 'reserved',
          metadata: { ...metadata },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (error) {
        await stateCollection.updateOne(
          { _id: key },
          { $inc: { reservedUsd: -amount }, $set: { updatedAt: new Date() } },
        );
        throw error;
      }
      return { reservationId, monthStart: key, reservedUsd: amount };
    },

    async settle({ reservationId, actualUsd, usage = {} }) {
      const actual = validUsd(actualUsd, 'actual_usd');
      const database = await db();
      const stateCollection = database.collection(STATE_COLLECTION);
      const eventCollection = database.collection(EVENT_COLLECTION);
      const event = await eventCollection.findOne({ reservationId, status: 'reserved' });
      if (!event) throw new Error('reservation_not_found');
      if (actual > Number(event.reservedUsd) + 1e-9) throw new Error('reservation_underestimated');

      const changed = await eventCollection.updateOne(
        { _id: event._id, status: 'reserved' },
        {
          $set: {
            status: 'settled',
            actualUsd: actual,
            usage: { ...usage },
            updatedAt: new Date(),
          },
        },
      );
      if (changed.modifiedCount !== 1) throw new Error('reservation_not_found');

      await stateCollection.updateOne(
        { _id: event.monthStart },
        {
          $inc: {
            reservedUsd: -Number(event.reservedUsd),
            settledUsd: actual,
          },
          $set: { updatedAt: new Date() },
        },
      );
      return {
        reservationId,
        monthStart: event.monthStart,
        reservedUsd: Number(event.reservedUsd),
        actualUsd: actual,
        status: 'settled',
      };
    },

    async release({ reservationId, reason = 'released' }) {
      const database = await db();
      const stateCollection = database.collection(STATE_COLLECTION);
      const eventCollection = database.collection(EVENT_COLLECTION);
      const event = await eventCollection.findOne({ reservationId, status: 'reserved' });
      if (!event) return false;
      const changed = await eventCollection.updateOne(
        { _id: event._id, status: 'reserved' },
        { $set: { status: 'released', reason: String(reason), updatedAt: new Date() } },
      );
      if (changed.modifiedCount !== 1) return false;
      await stateCollection.updateOne(
        { _id: event.monthStart },
        {
          $inc: { reservedUsd: -Number(event.reservedUsd) },
          $set: { updatedAt: new Date() },
        },
      );
      return true;
    },
    async reconcileStaleReservations({
      now = new Date(),
      maxAgeMs = DEFAULT_RESERVATION_TTL_MS,
      limit = 100,
    } = {}) {
      const currentTime = new Date(now);
      const cutoff = new Date(currentTime.getTime() - Number(maxAgeMs));
      const database = await db();
      const stateCollection = database.collection(STATE_COLLECTION);
      const eventCollection = database.collection(EVENT_COLLECTION);
      const stale = await eventCollection
        .find({ status: 'reserved', updatedAt: { $lte: cutoff } })
        .sort({ updatedAt: 1 })
        .limit(Math.max(1, Math.min(Number(limit) || 100, 1000)))
        .toArray();

      let settled = 0;
      for (const event of stale) {
        const amount = Number(event.reservedUsd || 0);
        const changed = await eventCollection.updateOne(
          { _id: event._id, status: 'reserved' },
          {
            $set: {
              status: 'settled',
              actualUsd: amount,
              usage: {
                ...(event.usage || {}),
                estimated: true,
                reason: 'stale_reservation',
              },
              updatedAt: currentTime,
            },
          },
        );
        if (changed.modifiedCount !== 1) continue;
        await stateCollection.updateOne(
          { _id: event.monthStart },
          {
            $inc: { reservedUsd: -amount, settledUsd: amount },
            $set: { updatedAt: currentTime },
          },
        );
        settled += 1;
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
