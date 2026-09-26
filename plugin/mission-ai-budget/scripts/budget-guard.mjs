import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
const target = Number(process.env.MISSION_AI_BUDGET_TARGET_USD || 100);
const economy = Number(process.env.MISSION_AI_BUDGET_ECONOMY_USD || 125);
const hard = Number(process.env.MISSION_AI_BUDGET_HARD_USD || 175);
const timeZone = process.env.MISSION_AI_BUDGET_TIMEZONE || 'America/Denver';

function validBudget(value) {
  return Number.isFinite(value) && value >= 0;
}

if (!uri || !validBudget(target) || !validBudget(economy) || !validBudget(hard) ||
    !(target <= economy && economy <= hard)) {
  console.error('Mission AI budget policy is not configured safely.');
  process.exit(2);
}

function localParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

function zonedMidnightUtc(year, month, day, zone) {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desired;
  for (let i = 0; i < 3; i += 1) {
    const actual = localParts(new Date(guess), zone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += desired - represented;
  }
  return new Date(guess);
}

function currentMonthStart(zone) {
  const p = localParts(new Date(), zone);
  return zonedMidnightUtc(p.year, p.month, 1, zone);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
try { JSON.parse(input || '{}'); } catch {
  console.error('Mission AI budget guard received an invalid hook payload.');
  process.exit(2);
}

let connection;
try {
  connection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 1,
  }).asPromise();

  const start = currentMonthStart(timeZone);
  const rows = await connection.collection('transactions').aggregate([
    { $match: {
      createdAt: { $gte: start },
      tokenType: { $in: ['prompt', 'completion'] },
      tokenValue: { $lt: 0 },
    } },
    { $group: { _id: null, microUsd: { $sum: { $multiply: ['$tokenValue', -1] } } } },
  ]).toArray();

  const spend = Number(rows[0]?.microUsd || 0) / 1_000_000;
  const display = spend.toFixed(2);

  if (spend >= hard) {
    console.error('Mission AI monthly hard budget reached ($' + display + ' / $' + hard.toFixed(2) + '). Increase the budget explicitly before sending additional model requests.');
    process.exitCode = 2;
  } else if (spend >= economy) {
    process.stdout.write(JSON.stringify({
      additionalContext: 'MISSION AI ECONOMY MODE: Current month spend is $' + display + '; economy threshold is $' + economy.toFixed(2) + ' and hard limit is $' + hard.toFixed(2) + '. Prefer the lowest-cost capable model/agent. Escalate to premium specialists only when the task materially requires it.'
    }));
  } else if (spend >= target) {
    process.stdout.write(JSON.stringify({
      additionalContext: 'MISSION AI BUDGET NOTICE: Current month spend is $' + display + '; target is $' + target.toFixed(2) + ' and economy mode begins at $' + economy.toFixed(2) + '. Avoid unnecessary premium-model delegation.'
    }));
  }
} catch {
  console.error('Mission AI could not verify the monthly spend and is failing closed to protect the hard budget.');
  process.exitCode = 2;
} finally {
  if (connection) await connection.close().catch(() => {});
}
