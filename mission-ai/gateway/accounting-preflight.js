// Deployment-scoped operator diagnostic: mission_ai_reader@test and mission_ai_ledger@MissionAI,
// on the same Atlas cluster, Denver months, and both paid gates explicitly false.
// No activation, reconciliation, or write API is called. Original-service spending remains live:
// this digest is a provisional observation, not a retained/approvable activation artifact.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { createNativeCutover } from './generated/cutover.js';
import { createMongoUsageLedger } from './usage-ledger.js';
import { providerForModel } from './dashboard.js';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

const MAX_ROWS = 100_000;
const TIME_ZONE = 'America/Denver';
const SAFE_ERRORS = new Set(['configuration_invalid', 'database_identity_invalid', 'database_scope_mismatch',
  'row_limit', 'ledger_integrity_invalid', 'ledger_changed_during_observation', 'native_not_drained',
  'invalid_native_transaction', 'invalid_native_total', 'native_history_too_large', 'cutover_month_changed',
  'invalid_budget_policy', 'invalid_shared_budget', 'ledger_state_invalid', 'timeout']);
const errorCode = (error) => SAFE_ERRORS.has(error?.message) ? error.message : 'read_failed';
const fail = (code) => { throw new Error(code); };
const money = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const same = (a, b) => money(a) && money(b) && Math.abs(a - b) <= 1e-9;

function configuration(env) {
  if (env.MISSION_AI_NATIVE_ENABLED !== 'false' || env.MISSION_AI_DELEGATION_ENABLED !== 'false' ||
      env.MISSION_AI_LEDGER_DB !== 'MissionAI' ||
      (env.MISSION_AI_BUDGET_TIMEZONE || TIME_ZONE) !== TIME_ZONE) fail('configuration_invalid');
  const parse = (value, user, database) => {
    let url;
    try { url = new URL(value); } catch { fail('configuration_invalid'); }
    if (url.protocol !== 'mongodb+srv:' || !url.hostname.endsWith('.mongodb.net') || url.port || url.hash ||
        url.pathname !== `/${database}` || decodeURIComponent(url.username) !== user ||
        !decodeURIComponent(url.password)) fail('configuration_invalid');
    const allowed = new Set(['authSource', 'retryWrites', 'w', 'appName', 'tls']);
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
      if (!allowed.has(key) || seen.has(key) || (key === 'authSource' && value !== 'admin') ||
          (['retryWrites', 'tls'].includes(key) && value !== 'true') ||
          (key === 'w' && value !== 'majority')) fail('configuration_invalid');
      seen.add(key);
    }
    return url;
  };
  const reader = parse(env.MISSION_AI_MONGO_URI, 'mission_ai_reader', 'test');
  const writer = parse(env.MISSION_AI_LEDGER_MONGO_URI, 'mission_ai_ledger', 'MissionAI');
  if (reader.hostname !== writer.hostname) fail('configuration_invalid');
  return { targetUsd: Number(env.MISSION_AI_BUDGET_TARGET_USD ?? 100),
    economyUsd: Number(env.MISSION_AI_BUDGET_ECONOMY_USD ?? 125),
    hardUsd: Number(env.MISSION_AI_BUDGET_HARD_USD ?? 175) };
}

function openReadOnly({ uri, database, registerClose }) {
  const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000, socketTimeoutMS: 7000, maxPoolSize: 1 });
  const session = client.startSession({ snapshot: true });
  registerClose(async () => { await session.endSession(); await client.close(); });
  return { db: client.db(database), session };
}

async function roles(db, role, database) {
  let value;
  try { value = await db.command({ connectionStatus: 1 }); } catch { return 'unknown'; }
  const granted = value?.authInfo?.authenticatedUserRoles;
  if (!Array.isArray(granted) || !granted.length) return 'unknown';
  if (!granted.every((entry) => entry.role === role && entry.db === database)) fail('database_scope_mismatch');
  return 'verified';
}

async function rows(resource, collection, filter, projection) {
  const result = await resource.db.collection(collection).find(filter,
    { projection, session: resource.session, maxTimeMS: 7000 }).limit(MAX_ROWS + 1).toArray();
  if (result.length > MAX_ROWS) fail('row_limit');
  return result;
}

function compareLedger(states, events, monthStart, cutoff) {
  const balances = new Map();
  const totals = new Map();
  const counts = { reserved: 0, settled: 0, released: 0 };
  const ids = new Set();
  let blockedStates = 0, estimatedSettlements = 0, underestimatedEvents = 0, staleReservations = 0;
  for (const state of states) {
    if (typeof state._id !== 'string' || !Number.isFinite(Date.parse(state._id)) ||
        monthStartFor(new Date(state._id), TIME_ZONE).toISOString() !== state._id ||
        balances.has(state._id) || !money(state.settledUsd) || !money(state.reservedUsd) ||
        (state.accountingBlocked !== undefined && typeof state.accountingBlocked !== 'boolean')) {
      fail('ledger_integrity_invalid');
    }
    balances.set(state._id, state);
    if (state.accountingBlocked) blockedStates += 1;
  }
  const partitions = { nativeUsd: 0, delegatedUsd: 0, historyUsd: 0 };
  const sourceKeys = new Map([['native', 'nativeUsd'], ['delegated', 'delegatedUsd'], ['native-history', 'historyUsd']]);
  for (const event of events) {
    const source = event.source ?? event.metadata?.source ?? 'delegated';
    if (!Object.hasOwn(counts, event.status) || !balances.has(event.monthStart) ||
        typeof event.reservationId !== 'string' || !event.reservationId || ids.has(event.reservationId) ||
        !money(event.reservedUsd) || (event.status === 'settled' && !money(event.actualUsd)) ||
        (event.source !== undefined && !sourceKeys.has(event.source)) ||
        (event.metadata?.source !== undefined && !sourceKeys.has(event.metadata.source)) ||
        (event.source !== undefined && event.metadata?.source !== undefined && event.source !== event.metadata.source) ||
        (source === 'native-history' && event.status !== 'settled') ||
        (event.underestimated !== undefined && typeof event.underestimated !== 'boolean') ||
        (event.usage?.estimated !== undefined && typeof event.usage.estimated !== 'boolean')) fail('ledger_integrity_invalid');
    ids.add(event.reservationId);
    counts[event.status] += 1;
    const total = totals.get(event.monthStart) || { settledUsd: 0, reservedUsd: 0 };
    if (event.status === 'settled') {
      total.settledUsd += event.actualUsd;
      if (event.monthStart === monthStart) partitions[sourceKeys.get(source)] += event.actualUsd;
      if (event.usage?.estimated === true) estimatedSettlements += 1;
    }
    if (event.status === 'reserved') {
      total.reservedUsd += event.reservedUsd;
      if (!(event.createdAt instanceof Date) || !Number.isFinite(event.createdAt.getTime())) fail('ledger_integrity_invalid');
      if (event.createdAt.getTime() < cutoff.getTime() - 15 * 60_000) staleReservations += 1;
    }
    if (event.underestimated === true) underestimatedEvents += 1;
    totals.set(event.monthStart, total);
  }
  for (const [key, state] of balances) {
    const total = totals.get(key) || { settledUsd: 0, reservedUsd: 0 };
    if (!same(state.settledUsd, total.settledUsd) || !same(state.reservedUsd, total.reservedUsd)) fail('ledger_integrity_invalid');
  }
  const current = totals.get(monthStart) || { settledUsd: 0, reservedUsd: 0 };
  return { statesCompared: states.length, eventsCompared: events.length, eventCounts: counts,
    settledUsd: current.settledUsd, reservedUsd: current.reservedUsd, partitions,
    accountingBlocked: blockedStates > 0, blockedStates, estimatedSettlements,
    underestimatedEvents, staleReservations, stateEventsMatch: true };
}

/** Only injected read methods are needed. A result never authorizes activation or paid traffic. */
export async function runAccountingPreflight({ env = process.env, now = () => new Date(),
  connect = openReadOnly, ledgerFactory = createMongoUsageLedger,
  catalogLoader = async () => JSON.parse(await readFile(new URL('../config/provider-catalog.json', import.meta.url), 'utf8')),
  timeoutMs = 35_000, cleanupMs = 1500 } = {}) {
  const report = { diagnostic: 'mission_ai_accounting_preflight_v1', status: 'incomplete',
    provisional: true, activationAuthorized: false, artifactPersisted: false,
    sourceCommit: typeof env.RENDER_GIT_COMMIT === 'string' && /^[a-f0-9]{40}$/i.test(env.RENDER_GIT_COMMIT)
      ? env.RENDER_GIT_COMMIT.toLowerCase() : null,
    native: { status: 'pending' }, ledger: { status: 'pending' } };
  const close = [];
  let expired = false, timer, cleanupTimer;
  const active = () => { if (expired) fail('timeout'); };
  const registerClose = (fn) => { close.push(fn); if (expired) void Promise.resolve().then(fn).catch(() => {}); };
  const section = async (key, work) => {
    try { const result = await work(); if (!expired) report[key] = { status: 'observed', ...result }; }
    catch (error) { if (!expired) report[key] = { status: 'failed', reason: errorCode(error) }; }
  };
  const work = async () => {
    const policy = configuration(env);
    const cutoff = now();
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) fail('configuration_invalid');
    const monthStart = monthStartFor(cutoff, TIME_ZONE).toISOString();
    Object.assign(report, { cutoff: cutoff.toISOString(), monthStart, timeZone: TIME_ZONE,
      paidGatesDisabled: true, sourceDatabase: 'test', ledgerDatabase: 'MissionAI' });
    await Promise.all([
      section('native', async () => {
        const resource = await connect({ uri: env.MISSION_AI_MONGO_URI, database: 'test', registerClose });
        active();
        if (resource.db.databaseName !== 'test') fail('database_identity_invalid');
        const roleInspection = await roles(resource.db, 'read', 'test');
        active();
        const catalog = await catalogLoader();
        active();
        const planner = createNativeCutover({ now, monthStart: monthStartFor,
          hash: (text) => crypto.createHash('sha256').update(text).digest('hex'),
          providerForModel: (model) => providerForModel(model, catalog),
          // The planner's apply method is never exposed or invoked by this diagnostic.
          activate: () => fail('configuration_invalid'),
          readRows: async () => (await rows(resource, 'transactions', {
            createdAt: { $gte: new Date(monthStart) }, tokenType: { $in: ['prompt', 'completion'] },
          }, { _id: 1, createdAt: 1, tokenType: 1, tokenValue: 1, model: 1 }))
            .map((row) => ({ id: String(row._id), createdAt: row.createdAt?.toISOString(),
              tokenType: row.tokenType, tokenValue: row.tokenValue, model: row.model })),
        });
        const plan = await planner.plan({ database: 'test', cutoverAt: cutoff.toISOString(), timeZone: TIME_ZONE, policy });
        return { roleInspection, transactionCount: plan.history.length, nativeUsd: plan.nativeUsd,
          planDigest: plan.digest, policy: plan.policy };
      }),
      section('ledger', async () => {
        const resource = await connect({ uri: env.MISSION_AI_LEDGER_MONGO_URI, database: 'MissionAI', registerClose });
        active();
        if (resource.db.databaseName !== 'MissionAI') fail('database_identity_invalid');
        const roleInspection = await roles(resource.db, 'readWrite', 'MissionAI');
        active();
        // Sequential reads share a Mongo snapshot; no transaction/write command is required.
        const states = await rows(resource, 'budget_state', {}, { _id: 1, settledUsd: 1, reservedUsd: 1, accountingBlocked: 1 });
        active();
        const events = await rows(resource, 'delegated_usage', {}, { _id: 0, reservationId: 1, monthStart: 1,
          status: 1, reservedUsd: 1, actualUsd: 1, source: 1, 'metadata.source': 1,
          'usage.estimated': 1, underestimated: 1, createdAt: 1 });
        active();
        const audit = compareLedger(states, events, monthStart, cutoff);
        const ledger = ledgerFactory({ uri: env.MISSION_AI_LEDGER_MONGO_URI, dbName: 'MissionAI' });
        registerClose(() => ledger.close());
        const shared = await ledger.sharedBudget();
        active();
        const summary = await ledger.summary({ now: cutoff, timeZone: TIME_ZONE });
        if (!same(audit.settledUsd, summary.settledUsd) || !same(audit.reservedUsd, summary.reservedUsd) ||
            audit.accountingBlocked !== Boolean(summary.accountingBlocked) ||
            Boolean(shared) !== (summary.sharedMode === true) ||
            (shared && (shared.timeZone !== TIME_ZONE || Object.keys(audit.partitions)
              .some((key) => !same(audit.partitions[key], summary[key]))))) fail('ledger_changed_during_observation');
        return { roleInspection, ...audit, sharedActivation: shared ? 'active' : 'inactive',
          readSummaryMatches: true, unresolvedAccounting: audit.accountingBlocked ||
            audit.eventCounts.reserved > 0 || audit.estimatedSettlements > 0 || audit.underestimatedEvents > 0 };
      }),
    ]);
  };
  try {
    await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('timeout')); }, Math.min(timeoutMs, 35_000));
    })]);
    if (report.native.status === 'observed' && report.ledger.status === 'observed') report.status = 'provisional';
  } catch (error) { report.reason = errorCode(error); }
  finally {
    clearTimeout(timer);
    expired = true;
    for (const key of ['native', 'ledger']) if (report[key].status === 'pending') {
      report[key] = { status: report.reason === 'timeout' ? 'timeout' : 'not_checked' };
    }
    await Promise.race([Promise.allSettled(close.map((fn) => Promise.resolve().then(fn))),
      new Promise((resolve) => { cleanupTimer = setTimeout(resolve, Math.min(cleanupMs, 1500)); })]);
    clearTimeout(cleanupTimer);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.length === 2 ? await runAccountingPreflight() :
    { diagnostic: 'mission_ai_accounting_preflight_v1', status: 'incomplete', reason: 'configuration_invalid' };
  // Zero exit is intentional for an operator start-command prefix; inspect JSON status, not exit code.
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}
