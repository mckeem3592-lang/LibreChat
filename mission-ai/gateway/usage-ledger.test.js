import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryUsageLedger } from './usage-ledger.js';

test('ledger reserves, settles, and reports monthly delegated spend', async () => {
  const ledger = createMemoryUsageLedger();
  const now = new Date('2026-09-27T18:00:00Z');
  const reservation = await ledger.reserve({
    reserveUsd: 5,
    directCapUsd: 25,
    now,
    metadata: { provider: 'openai', model: 'gpt-6-sol' },
  });
  assert.deepEqual(await ledger.summary({ now }), {
    monthStart: reservation.monthStart,
    settledUsd: 0,
    reservedUsd: 5,
  });
  await ledger.settle({ reservationId: reservation.reservationId, actualUsd: 1.25 });
  assert.deepEqual(await ledger.summary({ now }), {
    monthStart: reservation.monthStart,
    settledUsd: 1.25,
    reservedUsd: 0,
  });
});

test('ledger refuses a reservation that would cross the direct budget cap', async () => {
  const ledger = createMemoryUsageLedger();
  const now = new Date('2026-09-27T18:00:00Z');
  await ledger.reserve({ reserveUsd: 8, directCapUsd: 10, now });
  await assert.rejects(
    () => ledger.reserve({ reserveUsd: 3, directCapUsd: 10, now }),
    /monthly_hard_limit/,
  );
});

test('released reservations restore capacity', async () => {
  const ledger = createMemoryUsageLedger();
  const now = new Date('2026-09-27T18:00:00Z');
  const reservation = await ledger.reserve({ reserveUsd: 8, directCapUsd: 10, now });
  assert.equal(await ledger.release({ reservationId: reservation.reservationId }), true);
  const second = await ledger.reserve({ reserveUsd: 10, directCapUsd: 10, now });
  assert.ok(second.reservationId);
});

test('settlement cannot exceed the conservative reservation', async () => {
  const ledger = createMemoryUsageLedger();
  const reservation = await ledger.reserve({ reserveUsd: 1, directCapUsd: 10 });
  await assert.rejects(
    () => ledger.settle({ reservationId: reservation.reservationId, actualUsd: 1.01 }),
    /reservation_underestimated/,
  );
});
