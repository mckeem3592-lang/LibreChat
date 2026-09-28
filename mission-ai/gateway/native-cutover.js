// Command-line dependency wiring. Planning/approval validation lives in packages/api.
import crypto from 'node:crypto';
import { readFile, writeFile, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import mongoose from 'mongoose';
import { createReconciliationEvidence, normalizeReconciliations } from './generated/reconciliation.js';
import { createNativeCutover } from './generated/cutover.js';
import { createMongoUsageLedger } from './usage-ledger.js';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';
import { providerForModel } from './dashboard.js';

const argv = process.argv.slice(2);
const command = argv.shift();
const allowed = command === 'plan' ? ['--cutover-at', '--out', '--reconciliations'] : ['--plan', '--approve-digest', '--drained', '--reconciliations'];
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i];
  if (!allowed.includes(key) || args[key] !== undefined) throw new Error('invalid_cutover_arguments');
  args[key] = key === '--drained' ? true : argv[++i];
  if (args[key] === undefined) throw new Error('invalid_cutover_arguments');
}
if (!['plan', 'apply'].includes(command)) throw new Error('expected_plan_or_apply');
const uri = process.env.MISSION_AI_MONGO_URI;
const ledgerUri = process.env.MISSION_AI_LEDGER_MONGO_URI;
if (!uri || !ledgerUri) throw new Error('dedicated_database_connections_required');
let nativeConnection;
try {
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const readBounded = async (path) => {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 5_000_000) throw new Error('invalid_evidence_file');
      return await file.readFile();
    } finally { await file.close(); }
  };
  const evidence = args['--reconciliations'] ? createReconciliationEvidence(
    JSON.parse((await readBounded(args['--reconciliations'])).toString('utf8')),
    { read: (path) => readBounded(resolve(dirname(args['--reconciliations']), path)), hash },
  ) : undefined;
  if (evidence && (process.env.MISSION_AI_NATIVE_ENABLED !== 'false' ||
      process.env.MISSION_AI_DELEGATION_ENABLED !== 'false')) throw new Error('paid_gates_must_be_disabled');
  nativeConnection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 1,
  }).asPromise();
  const database = nativeConnection.db.databaseName;
  const catalog = JSON.parse(await readFile(new URL('../config/provider-catalog.json', import.meta.url), 'utf8'));
  const ledger = createMongoUsageLedger({ uri: ledgerUri });
  const cutover = createNativeCutover({
    hash,
    verifyEvidence: evidence?.verifyEvidence,
    monthStart: monthStartFor,
    providerForModel: (model) => providerForModel(model, catalog),
    readRows: async (expectedDatabase, start) => {
      if (expectedDatabase !== database) throw new Error('native_database_changed');
      const rows = await nativeConnection.collection('transactions').find({
        createdAt: { $gte: start }, tokenType: { $in: ['prompt', 'completion'] },
      }, { projection: { _id: 1, createdAt: 1, tokenType: 1, tokenValue: 1, model: 1 } }).limit(100_001).toArray();
      return rows.map((row) => ({ id: String(row._id), createdAt: row.createdAt?.toISOString(),
        tokenType: row.tokenType, tokenValue: row.tokenValue, model: row.model }));
    },
    activate: (input) => ledger.activateSharedBudget(input),
    now: () => new Date(),
  });
  if (command === 'plan') {
    if (!args['--out']) throw new Error('cutover_output_required');
    const plan = await cutover.plan({ database,
      ...(evidence ? { reconciliations: evidence.reconciliations } : {}), cutoverAt: args['--cutover-at'],
      timeZone: process.env.MISSION_AI_BUDGET_TIMEZONE || 'America/Denver',
      policy: { targetUsd: Number(process.env.MISSION_AI_BUDGET_TARGET_USD ?? 100),
        economyUsd: Number(process.env.MISSION_AI_BUDGET_ECONOMY_USD ?? 125),
        hardUsd: Number(process.env.MISSION_AI_BUDGET_HARD_USD ?? 175) } });
    await writeFile(args['--out'], `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'prepared', database, nativeUsd: plan.nativeUsd,
      transactionCount: plan.history.length, digest: plan.digest, applied: false,
      ...(plan.version === 2 ? { reconciliationCount: plan.reconciliations.length,
        reconciliationUsd: plan.reconciliationUsd, correctedNativeUsd: plan.correctedNativeUsd,
        basis: 'provider_usage_and_published_rates' } : {}) }));
  } else {
    const plan = JSON.parse(await readFile(args['--plan'], 'utf8'));
    if (plan.version === 2) {
      if (!evidence || JSON.stringify(normalizeReconciliations(evidence.reconciliations, plan.history,
        { database: plan.database, monthStart: plan.monthStart, cutoverAt: plan.cutoverAt }, hash)) !==
        JSON.stringify(plan.reconciliations)) throw new Error('reconciliation_evidence_changed');
    } else if (evidence) throw new Error('unexpected_reconciliation_evidence');
    const result = await cutover.apply({ plan,
      approvedDigest: args['--approve-digest'], drained: args['--drained'] === true,
      nativeEnabled: process.env.MISSION_AI_NATIVE_ENABLED,
      delegationEnabled: process.env.MISSION_AI_DELEGATION_ENABLED });
    console.log(JSON.stringify({ status: 'activated', ...result }));
  }
} catch {
  // Driver errors may contain connection details; do not echo them from an operator command.
  console.error('Native cutover did not complete. Check the approved plan, drained state, and database access.');
  process.exitCode = 1;
} finally {
  await nativeConnection?.close().catch(() => {});
  await mongoose.disconnect().catch(() => {});
}
