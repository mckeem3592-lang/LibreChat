import mongoose from 'mongoose';
import { monthStartFor } from './budget-time.mjs';
import { monthlySpendPipeline, settledCreditsFromRows } from './budget-query.mjs';
import { summarizeBudget } from './budget-summary.mjs';

const uri = process.env.MONGO_URI || '';
const timeZone = process.env.MISSION_AI_BUDGET_TIMEZONE || 'America/Denver';
const targetUsd = Number(process.env.MISSION_AI_BUDGET_TARGET_USD || 100);
const economyUsd = Number(process.env.MISSION_AI_BUDGET_ECONOMY_USD || 125);
const hardUsd = Number(process.env.MISSION_AI_BUDGET_HARD_USD || 175);

if (!uri) {
  console.error('Mission AI budget report requires MONGO_URI.');
  process.exit(2);
}

let connection;
try {
  const monthStart = monthStartFor(new Date(), timeZone);
  connection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    maxPoolSize: 1,
  }).asPromise();

  const rows = await connection
    .collection('transactions')
    .aggregate(monthlySpendPipeline(monthStart))
    .toArray();

  const spentCredits = settledCreditsFromRows(rows);
  const summary = summarizeBudget({ spentCredits, targetUsd, economyUsd, hardUsd });

  process.stdout.write(
    JSON.stringify({
      ok: true,
      timeZone,
      monthStart: monthStart.toISOString(),
      spentCredits,
      ...summary,
    }),
  );
} catch (error) {
  console.error(
    'Mission AI budget report failed: ' +
      (error instanceof Error ? error.message : 'unknown_error'),
  );
  process.exitCode = 2;
} finally {
  if (connection) await connection.close().catch(() => {});
}
