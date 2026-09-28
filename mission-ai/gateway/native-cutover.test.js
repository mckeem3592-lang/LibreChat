import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createNativeCutover } from './generated/cutover.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

const now = new Date('2026-09-28T17:00:00Z');
const input = { database: 'test', cutoverAt: now.toISOString(), timeZone: 'America/Denver',
  policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 } };
function fixture() {
  const rows = [
    { id: 'prompt', createdAt: now.toISOString(), tokenType: 'prompt', tokenValue: -60_000, model: 'gpt-6-luna' },
    { id: 'completion', createdAt: now.toISOString(), tokenType: 'completion', tokenValue: -5_000, model: 'gpt-6-luna' },
    { id: 'credit', createdAt: now.toISOString(), tokenType: 'prompt', tokenValue: 999_999 },
  ];
  const ledger = createMemoryUsageLedger();
  const tool = createNativeCutover({ hash: (value) => crypto.createHash('sha256').update(value).digest('hex'),
    monthStart: monthStartFor, readRows: async () => rows, providerForModel: () => 'openai',
    activate: (args) => ledger.activateSharedBudget(args), now: () => now });
  return { rows, ledger, tool };
}
async function apply(f, plan, extra = {}) {
  return f.tool.apply({ plan, approvedDigest: plan.digest, drained: true,
    nativeEnabled: 'false', delegationEnabled: 'false', ...extra });
}

test('cutover planning is read-only; approved activation imports charges once and preserves delegation', async () => {
  const f = fixture();
  const hold = await f.ledger.reserve({ reserveUsd: 1, directCapUsd: 175, now });
  await f.ledger.settle({ reservationId: hold.reservationId, actualUsd: 0.01 });
  const plan = await f.tool.plan(input);
  assert.equal(await f.ledger.sharedBudget(), null);
  assert.equal(plan.history.length, 2);
  assert.equal(plan.nativeUsd, 0.065);
  await apply(f, plan);
  await apply(f, plan);
  const summary = await f.ledger.summary({ now });
  assert.equal(summary.historyUsd, 0.065);
  assert.equal(summary.delegatedUsd, 0.01);
  assert.ok(Math.abs(summary.settledUsd - 0.075) < 1e-9);
});

test('cutover rejects changed, missing, late, duplicate and malformed transactions', async () => {
  for (const change of [
    (rows) => { rows[0].tokenValue -= 1; },
    (rows) => { rows.shift(); },
    (rows) => { rows[0].createdAt = '2026-09-28T17:00:01Z'; },
    (rows) => { rows.push({ ...rows[0] }); },
    (rows) => { rows[0].tokenValue = '60000'; },
  ]) {
    const f = fixture();
    const plan = await f.tool.plan(input);
    change(f.rows);
    await assert.rejects(() => apply(f, plan));
    assert.equal(await f.ledger.sharedBudget(), null);
  }
});

test('activation requires exact approval, disabled switches and a drained attestation', async () => {
  for (const override of [ { approvedDigest: '0'.repeat(64) }, { drained: false },
    { nativeEnabled: undefined }, { nativeEnabled: 'true' }, { delegationEnabled: 'true' } ]) {
    const f = fixture();
    const plan = await f.tool.plan(input);
    await assert.rejects(() => apply(f, plan, override));
    assert.equal(await f.ledger.sharedBudget(), null);
  }
});

test('future dates and a changed Denver billing month cannot be activated', async () => {
  const f = fixture();
  await assert.rejects(() => f.tool.plan({ ...input, cutoverAt: '2026-10-01T06:00:00Z' }), /future_cutover/);
  await assert.rejects(() => f.tool.plan({ ...input, cutoverAt: '2026-09-01T05:59:59Z' }), /cutover_month_changed/);
});
