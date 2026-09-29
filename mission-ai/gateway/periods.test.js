import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingWindows, summarizeSpendingPeriods } from './generated/periods.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { queryMissionDashboard } from './mission-dashboard.js';
const zone = 'America/Denver';
const now = new Date('2026-10-01T18:00:00Z');
const row = (at, usd, extra = {}) => ({ status: 'settled', source: 'native',
  createdAt: at, monthStart: '2026-10-01T06:00:00.000Z', actualUsd: usd, ...extra });
test('calendar weeks cross month boundaries and use local midnight through DST', () => {
  assert.deepEqual(spendingWindows(now, zone), { asOf: now.toISOString(), timeZone: zone,
    weekStartsOn: 'Monday', dayStart: '2026-10-01T06:00:00.000Z',
    weekStart: '2026-09-28T06:00:00.000Z', monthStart: '2026-10-01T06:00:00.000Z' });
  const spring = spendingWindows(new Date('2026-03-09T18:00:00Z'), zone);
  assert.equal(spring.dayStart, '2026-03-09T06:00:00.000Z');
  const autumn = spendingWindows(new Date('2026-11-02T18:00:00Z'), zone);
  assert.equal(autumn.dayStart, '2026-11-02T07:00:00.000Z');
  assert.equal(spendingWindows(new Date('2026-09-29T02:00:00Z'), zone).dayStart,
    '2026-09-28T06:00:00.000Z');
});
test('reported totals retain estimates, exclude future/unsettled events and do not assign monthly corrections to today', () => {
  const report = summarizeSpendingPeriods([
    row('2026-09-28T06:00:00Z', .2), row('2026-10-01T06:00:00Z', .1, { usage: { estimated: true } }),
    row('2026-10-01T18:00:00Z', .3), row('2026-10-01T18:00:01Z', 100),
    row('2026-10-01T06:00:00Z', 100, { status: 'reserved' }),
    row('2026-09-28T05:59:59Z', 100),
    row('2026-10-01T06:00:00Z', .04, { source: 'provider-reconciliation' }),
  ], now, zone);
  assert.equal(report.todayUsd, .4);
  assert.ok(Math.abs(report.weekUsd - .6) < 1e-9);
  assert.equal(report.todayEstimatedUsd, .1); assert.equal(report.weekEstimatedUsd, .1);
  assert.equal(report.monthUnallocatedUsd, .04);
});
test('invalid amount/date/estimate/timezone cannot become a reassuring zero', () => {
  for (const usd of [NaN, Infinity, -1, '1', undefined])
    assert.throws(() => summarizeSpendingPeriods([row(now, usd)], now, zone));
  for (const extra of [{ createdAt: 'invalid' }, { usage: { estimated: 'true' } }])
    assert.throws(() => summarizeSpendingPeriods([row(now, 1, extra)], now, zone));
  assert.throws(() => spendingWindows(new Date(NaN), zone));
  assert.throws(() => spendingWindows(now, 'invalid-zone'));
});
test('read-only shared dashboard gets full-week history without re-reading the native mirror or changing monthly cap', async () => {
  const ledger = createMemoryUsageLedger();
  await ledger.activateSharedBudget({ policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 },
    timeZone: zone, cutoverAt: '2026-09-29T12:00:00Z', history: [
      { id: 'previous-month-in-week', at: '2026-09-28T12:00:00Z', usd: .2 },
    ] });
  const held = await ledger.reserve({ now, source: 'native', reserveUsd: .1 });
  await ledger.settle({ reservationId: held.reservationId, actualUsd: .1, usage: { estimated: true } });
  const read = () => queryMissionDashboard({ now, usageLedger: ledger, includePeriods: true,
    nativeReader: () => assert.fail('shared reports must not duplicate original native history') });
  const before = await ledger.summary({ now });
  const dashboard = await read();
  assert.equal(dashboard.spendUsd, .1); assert.equal(dashboard.periods.todayUsd, .1);
  assert.ok(Math.abs(dashboard.periods.weekUsd - .3) < 1e-9);
  assert.equal(dashboard.periods.weekEstimatedUsd, .1);
  assert.deepEqual(await ledger.summary({ now }), before);
  const defaultReport = await queryMissionDashboard({ now, usageLedger: ledger });
  assert.equal(defaultReport.periods, undefined);
});
