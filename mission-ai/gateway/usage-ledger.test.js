import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryUsageLedger, createMongoUsageLedger } from './usage-ledger.js';

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

test('ledger reports privacy-safe provider model task and project breakdowns', async () => {
  const ledger = createMemoryUsageLedger();
  const now = new Date('2026-09-27T18:00:00Z');
  const reservation = await ledger.reserve({
    reserveUsd: 2,
    directCapUsd: 10,
    now,
    metadata: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      task: 'coding',
      project: 'mission-ai',
    },
  });
  await ledger.settle({ reservationId: reservation.reservationId, actualUsd: 0.75 });
  const breakdown = await ledger.breakdown({ now });
  assert.deepEqual(breakdown.byProvider, [{ provider: 'anthropic', spendUsd: 0.75 }]);
  assert.deepEqual(breakdown.byModel, [{ model: 'claude-sonnet-5', spendUsd: 0.75 }]);
  assert.deepEqual(breakdown.byTask, [{ task: 'coding', spendUsd: 0.75 }]);
  assert.deepEqual(breakdown.byProject, [{ project: 'mission-ai', spendUsd: 0.75 }]);
  assert.equal(JSON.stringify(breakdown).includes('prompt'), false);
});

test('stale reservations are conservatively settled at the reserved amount', async () => {
  const ledger = createMemoryUsageLedger();
  const reservedAt = new Date('2026-09-27T18:00:00Z');
  const reservation = await ledger.reserve({
    reserveUsd: 3,
    directCapUsd: 10,
    now: reservedAt,
    metadata: { provider: 'openai', model: 'gpt-6-sol', task: 'chat' },
  });

  const result = await ledger.reconcileStaleReservations({
    now: new Date('2026-09-27T18:16:00Z'),
    maxAgeMs: 15 * 60 * 1000,
  });
  assert.equal(result.settled, 1);

  const summary = await ledger.summary({ now: reservedAt });
  assert.equal(summary.reservedUsd, 0);
  assert.equal(summary.settledUsd, 3);

  await assert.rejects(
    () => ledger.settle({ reservationId: reservation.reservationId, actualUsd: 1 }),
    /reservation_not_found/,
  );
});


test('Mongo ledger can reuse the least-privilege Mission AI native URI when no ledger URI is set', () => {
  const originalNative = process.env.MISSION_AI_MONGO_URI;
  const originalLedger = process.env.MISSION_AI_LEDGER_MONGO_URI;
  try {
    process.env.MISSION_AI_MONGO_URI = 'mongodb://example.invalid/LibreChat';
    delete process.env.MISSION_AI_LEDGER_MONGO_URI;
    const ledger = createMongoUsageLedger();
    assert.equal(typeof ledger.summary, 'function');
    assert.equal(typeof ledger.reserve, 'function');
  } finally {
    if (originalNative === undefined) delete process.env.MISSION_AI_MONGO_URI;
    else process.env.MISSION_AI_MONGO_URI = originalNative;
    if (originalLedger === undefined) delete process.env.MISSION_AI_LEDGER_MONGO_URI;
    else process.env.MISSION_AI_LEDGER_MONGO_URI = originalLedger;
  }
});
