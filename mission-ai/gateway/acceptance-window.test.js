import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceWindow } from './acceptance-window.js';
import { createMemoryUsageLedger } from './usage-ledger.js';

const now = new Date('2026-09-29T04:00:00Z');
const env = { MISSION_AI_NATIVE_ENABLED: 'false', MISSION_AI_ACCEPTANCE_START: now.toISOString(),
  MISSION_AI_ACCEPTANCE_END: '2026-09-29T04:30:00Z', MISSION_AI_ACCEPTANCE_BASELINE_USD: '0.069074775',
  MISSION_AI_ACCEPTANCE_ALLOWANCE_USD: '0.10' };

test('temporary acceptance expires and never replaces an enabled general gate', () => {
  assert.equal(acceptanceWindow(env, now).ceilingUsd, 0.169074775);
  for (const change of [{MISSION_AI_NATIVE_ENABLED:'true'}, {MISSION_AI_ACCEPTANCE_ALLOWANCE_USD:'0.11'},
    {MISSION_AI_ACCEPTANCE_END:'2026-09-29T04:31:00Z'}, {MISSION_AI_ACCEPTANCE_BASELINE_USD:'NaN'},
    {MISSION_AI_ACCEPTANCE_START:''}]) assert.equal(acceptanceWindow({...env,...change},now),null);
  assert.equal(acceptanceWindow(env,new Date('2026-09-29T03:59:59Z')),null);
  assert.equal(acceptanceWindow(env,new Date(env.MISSION_AI_ACCEPTANCE_END)),null);
});

test('the ledger refuses concurrent spending above the acceptance ceiling', async () => {
  const ledger = createMemoryUsageLedger();
  const cap = acceptanceWindow(env,now).ceilingUsd;
  await ledger.reserve({reservationId:'baseline',reserveUsd:0.069074775,directCapUsd:cap,now});
  await ledger.settle({reservationId:'baseline',actualUsd:0.069074775});
  const results = await Promise.allSettled([1,2].map(i=>ledger.reserve({reservationId:String(i),
    reserveUsd:0.06,directCapUsd:cap,now})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const boundary = {...env, MISSION_AI_ACCEPTANCE_START:'2026-10-01T05:55:00Z',
    MISSION_AI_ACCEPTANCE_END:'2026-10-01T06:05:00Z'};
  assert.equal(acceptanceWindow(boundary,new Date(boundary.MISSION_AI_ACCEPTANCE_START)),null);
});
