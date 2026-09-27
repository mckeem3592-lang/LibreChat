import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';
import { creditsToUsd } from '../../plugin/mission-ai-budget/scripts/credits.mjs';
import { summarizeBudget } from '../../plugin/mission-ai-budget/scripts/budget-summary.mjs';

const DEFAULT_TIME_ZONE = 'America/Denver';

export function transactionBreakdownPipeline(monthStart) {
  if (!(monthStart instanceof Date) || Number.isNaN(monthStart.getTime())) {
    throw new Error('invalid_month_start');
  }
  return [
    {
      $match: {
        createdAt: { $gte: monthStart },
        tokenType: { $in: ['prompt', 'completion'] },
        tokenValue: { $lt: 0 },
      },
    },
    {
      $group: {
        _id: {
          model: { $ifNull: ['$model', 'unknown'] },
          tokenType: '$tokenType',
        },
        settledCredits: { $sum: { $multiply: ['$tokenValue', -1] } },
        inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
        writeTokens: { $sum: { $ifNull: ['$writeTokens', 0] } },
        readTokens: { $sum: { $ifNull: ['$readTokens', 0] } },
        rawAmount: { $sum: { $ifNull: ['$rawAmount', 0] } },
      },
    },
    { $sort: { settledCredits: -1 } },
  ];
}

export function providerForModel(model, catalog = {}) {
  for (const [provider, roles] of Object.entries(catalog.providers || {})) {
    if (Object.values(roles || {}).includes(model)) return provider;
  }
  return 'unknown';
}

function addBucket(map, key, row) {
  const current = map.get(key) || {
    settledCredits: 0,
    promptCredits: 0,
    completionCredits: 0,
    inputTokens: 0,
    writeTokens: 0,
    readTokens: 0,
    rawAmount: 0,
  };
  const credits = Number(row.settledCredits || 0);
  current.settledCredits += credits;
  if (row.tokenType === 'prompt') current.promptCredits += credits;
  if (row.tokenType === 'completion') current.completionCredits += credits;
  current.inputTokens += Number(row.inputTokens || 0);
  current.writeTokens += Number(row.writeTokens || 0);
  current.readTokens += Number(row.readTokens || 0);
  current.rawAmount += Number(row.rawAmount || 0);
  map.set(key, current);
}

function serializeBucket(nameKey, name, value) {
  return {
    [nameKey]: name,
    spendUsd: creditsToUsd(value.settledCredits),
    promptSpendUsd: creditsToUsd(value.promptCredits),
    completionSpendUsd: creditsToUsd(value.completionCredits),
    inputTokens: value.inputTokens,
    writeTokens: value.writeTokens,
    readTokens: value.readTokens,
    rawAmount: value.rawAmount,
  };
}

export function buildCostDashboard({
  rows = [],
  catalog = {},
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  targetUsd = 100,
  economyUsd = 125,
  hardUsd = 175,
} = {}) {
  const byModel = new Map();
  const byProvider = new Map();
  let spentCredits = 0;

  for (const source of rows) {
    const row = {
      model: String(source?._id?.model || 'unknown'),
      tokenType: String(source?._id?.tokenType || ''),
      settledCredits: Number(source?.settledCredits || 0),
      inputTokens: Number(source?.inputTokens || 0),
      writeTokens: Number(source?.writeTokens || 0),
      readTokens: Number(source?.readTokens || 0),
      rawAmount: Number(source?.rawAmount || 0),
    };
    if (!Number.isFinite(row.settledCredits) || row.settledCredits < 0) {
      throw new Error('invalid_dashboard_credits');
    }
    spentCredits += row.settledCredits;
    addBucket(byModel, row.model, row);
    addBucket(byProvider, providerForModel(row.model, catalog), row);
  }

  const budget = summarizeBudget({ spentCredits, targetUsd, economyUsd, hardUsd });
  const monthStart = monthStartFor(now, timeZone).toISOString();
  const sortSpend = (a, b) => b.spendUsd - a.spendUsd;

  return {
    monthStart,
    timeZone,
    spentCredits,
    ...budget,
    byProvider: [...byProvider.entries()]
      .map(([provider, value]) => serializeBucket('provider', provider, value))
      .sort(sortSpend),
    byModel: [...byModel.entries()]
      .map(([model, value]) => serializeBucket('model', model, value))
      .sort(sortSpend),
  };
}

async function loadCatalog() {
  const raw = await readFile(new URL('../config/provider-catalog.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

export async function queryCostDashboard({
  uri = process.env.MONGO_URI || '',
  timeZone = process.env.MISSION_AI_BUDGET_TIMEZONE || DEFAULT_TIME_ZONE,
  targetUsd = Number(process.env.MISSION_AI_BUDGET_TARGET_USD || 100),
  economyUsd = Number(process.env.MISSION_AI_BUDGET_ECONOMY_USD || 125),
  hardUsd = Number(process.env.MISSION_AI_BUDGET_HARD_USD || 175),
  now = new Date(),
} = {}) {
  if (!uri) throw new Error('mongo_not_configured');

  const monthStart = monthStartFor(now, timeZone);
  let connection;
  try {
    connection = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      maxPoolSize: 1,
    }).asPromise();
    const rows = await connection
      .collection('transactions')
      .aggregate(transactionBreakdownPipeline(monthStart))
      .toArray();
    return buildCostDashboard({
      rows,
      catalog: await loadCatalog(),
      now,
      timeZone,
      targetUsd,
      economyUsd,
      hardUsd,
    });
  } finally {
    if (connection) await connection.close().catch(() => {});
  }
}
