import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryUsageLedger } from './usage-ledger.js';

const now = new Date('2026-09-27T18:00:00Z');
const timeZone = 'America/Denver';
const activation = () => ({
  policy: { targetUsd: 5, economyUsd: 8, hardUsd: 10 }, timeZone,
  cutoverAt: now, history: [{ id: 'test/transactions/one', at: '2026-09-02T18:00:00Z', usd: 2 }],
});
const reserve = (ledger, extra = {}) => ledger.reserve({ now, timeZone, reserveUsd: 1, ...extra });

test('shared activation preserves delegated spend and exposes disjoint native/history totals', async () => {
  const ledger = createMemoryUsageLedger();
  assert.equal(await ledger.sharedBudget(), null);
  const old = await reserve(ledger, { directCapUsd: 10 });
  await ledger.settle({ reservationId: old.reservationId, actualUsd: 0.5 });
  const config = await ledger.activateSharedBudget(activation());
  assert.deepEqual(config, { mode: 'shared', policy: activation().policy, timeZone, cutoverAt: now.toISOString() });
  config.policy.hardUsd = 10000;
  assert.equal((await ledger.sharedBudget()).policy.hardUsd, 10);
  const native = await reserve(ledger, { metadata: { source: 'native' } });
  await ledger.settle({ reservationId: native.reservationId, actualUsd: 0.75 });
  assert.deepEqual(await ledger.summary({ now, timeZone }), {
    monthStart: '2026-09-01T06:00:00.000Z', settledUsd: 3.25, reservedUsd: 0,
    sharedMode: true, nativeUsd: 0.75, delegatedUsd: 0.5, historyUsd: 2,
  });
});

test('activation retry is order-independent but changed immutable history or policy conflicts', async () => {
  const ledger = createMemoryUsageLedger();
  const input = activation();
  input.history.push({ id: 'test/transactions/two', at: now, usd: 1, provider: 'anthropic', model: 'fixture' });
  await ledger.activateSharedBudget(input);
  await ledger.activateSharedBudget({ ...input, history: [...input.history].reverse() });
  await assert.rejects(() => ledger.activateSharedBudget({ ...input, history: input.history.slice(1) }), /shared_budget_conflict/);
  await assert.rejects(() => ledger.activateSharedBudget({ ...input, policy: { ...input.policy, hardUsd: 20 } }), /shared_budget_conflict/);
  assert.equal((await ledger.summary({ now })).settledUsd, 3);
});

test('shared activation requires drained and unblocked accounting', async () => {
  const ledger = createMemoryUsageLedger();
  const r = await reserve(ledger, { directCapUsd: 10 });
  await assert.rejects(() => ledger.activateSharedBudget(activation()), /shared_budget_not_drained/);
  assert.equal(await ledger.sharedBudget(), null);
  await assert.rejects(() => ledger.settle({ reservationId: r.reservationId, actualUsd: 2 }), /reservation_underestimated/);
  await assert.rejects(() => ledger.activateSharedBudget(activation()), /ledger_accounting_blocked/);
});

test('shared cap overrides excessive caller caps and can retain a smaller caller ceiling', async () => {
  const ledger = createMemoryUsageLedger();
  await ledger.activateSharedBudget(activation());
  await reserve(ledger, { reserveUsd: 8, directCapUsd: 1000 });
  await assert.rejects(() => reserve(ledger, { directCapUsd: 1000 }), /monthly_hard_limit/);
  const second = createMemoryUsageLedger();
  await second.activateSharedBudget(activation());
  await assert.rejects(() => reserve(second, { reserveUsd: 2, directCapUsd: 3 }), /monthly_hard_limit/);
  for (const directCapUsd of [-1, Infinity, NaN, null, '100']) {
    await assert.rejects(() => reserve(second, { directCapUsd }), /invalid_direct_cap_usd/);
  }
});

test('native mode and sources cannot be forged or replayed as a different source', async () => {
  const ledger = createMemoryUsageLedger();
  await assert.rejects(() => reserve(ledger, { directCapUsd: 10, source: 'native' }), /shared_budget_required/);
  await ledger.activateSharedBudget(activation());
  await assert.rejects(() => reserve(ledger, { source: 'native', metadata: { source: 'delegated' } }), /invalid_reservation_source/);
  await assert.rejects(() => reserve(ledger, { source: 'native-history' }), /invalid_reservation_source/);
  await reserve(ledger, { reservationId: 'same', source: 'native' });
  await assert.rejects(() => reserve(ledger, { reservationId: 'same', source: 'delegated' }), /reservation_conflict/);
  await assert.rejects(() => reserve(ledger, { timeZone: 'UTC' }), /shared_budget_timezone_mismatch/);
});

test('invalid activation inputs do not modify history or activate shared mode', async () => {
  const scenarios = [
    { policy: { targetUsd: 10, economyUsd: 8, hardUsd: 10 } },
    { policy: { targetUsd: '5', economyUsd: 8, hardUsd: 10 } },
    { timeZone: 'Not/AZone' },
    { cutoverAt: 'not-a-time' },
    { cutoverAt: new Date(Date.now() + 60000) },
    { history: [{ id: 'same', at: now, usd: 1 }, { id: 'same', at: now, usd: 1 }] },
    { history: [{ id: 'one', at: '2026-09-28T18:00:00Z', usd: 1 }] },
    ...[-1, Infinity, NaN, null, '1'].map((usd) => ({ history: [{ id: 'one', at: now, usd }] })),
  ];
  for (const change of scenarios) {
    const ledger = createMemoryUsageLedger();
    await assert.rejects(() => ledger.activateSharedBudget({ ...activation(), ...change }));
    assert.equal(await ledger.sharedBudget(), null);
    assert.equal((await ledger.summary({ now })).settledUsd, 0);
  }
});

test('history retains its own Denver month and default source stays delegated', async () => {
  const ledger = createMemoryUsageLedger();
  await ledger.activateSharedBudget({ ...activation(), history: [
    { id: 'august', at: '2026-09-01T05:59:59Z', usd: 1 },
    { id: 'september', at: '2026-09-01T06:00:00Z', usd: 2 },
  ] });
  const current = await reserve(ledger);
  await ledger.settle({ reservationId: current.reservationId, actualUsd: 0.5 });
  assert.equal((await ledger.summary({ now: new Date('2026-08-30T18:00:00Z') })).historyUsd, 1);
  assert.equal((await ledger.summary({ now })).historyUsd, 2);
  assert.equal((await ledger.summary({ now })).delegatedUsd, 0.5);
});
