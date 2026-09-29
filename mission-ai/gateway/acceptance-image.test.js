import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcceptanceImage } from './acceptance-image.js';
import { acceptanceWindow } from './acceptance-window.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
const now = new Date('2026-09-29T16:00:00Z');
const env = { MISSION_AI_NATIVE_ENABLED: 'false', MISSION_AI_DELEGATION_ENABLED: 'false',
 MISSION_AI_ACCEPTANCE_SCOPE: 'final-workflows', MISSION_AI_ACCEPTANCE_RUN_ID: '12d909f4-c138-4611-85c0-df6295d141dc',
 MISSION_AI_ACCEPTANCE_START: now.toISOString(), MISSION_AI_ACCEPTANCE_END: '2026-09-29T16:30:00Z',
 MISSION_AI_ACCEPTANCE_BASELINE_USD: '0.094592775', MISSION_AI_ACCEPTANCE_ALLOWANCE_USD: '0.50' };
async function fixture(changes = {}) {
 const ledger = createMemoryUsageLedger();
 await ledger.activateSharedBudget({ policy: {targetUsd:100,economyUsd:125,hardUsd:175},timeZone:'America/Denver',cutoverAt:now,history:[] });
 const claims = new Map(); let calls = 0; const settings = {...env,...changes}; let clock=now;
 const store = { async claim(record) { if(claims.has(record._id))throw Error('already_claimed');claims.set(record._id,structuredClone(record)); },
  async readClaim(id) {return claims.get(id);},
  async markDispatch(id,reservationId) { Object.assign(claims.get(id),{stage:'dispatch_started',reservationId}); },
  async complete(id,result) { Object.assign(claims.get(id),{stage:'finished',result}); } };
 const image = {data:'aW1hZ2U=',mimeType:'image/png'};
 const run = createAcceptanceImage({ env:settings,ledger,store,now:()=>clock,
  generateImage: async (input) => {
   assert.equal(input.maxOutputTokens,2048);assert.equal(input.imageSize,'512');assert.equal(input.project,'mission-ai-final-validation');
   assert.equal(input.fetchImpl,undefined);assert.equal(input.enabled,true);
   const reservation=await input.usageLedger.reserve({reservationId:String(calls+1),reserveUsd:.26,directCapUsd:175,now});
   calls++; await input.usageLedger.settle({reservationId:reservation.reservationId,actualUsd:.26});
   return {ok:true,cost:{totalUsd:.26},images:[input.referenceImage ? {...image,data:'ZWRpdGVk'} : image]};
  } });
 return {run,ledger,store,claims,image,settings,calls:()=>calls,setClock:value=>{clock=value;}};
}
test('workflow window requires explicit scope, run identity, disabled general gates and at most fifty cents',()=>{
 assert.equal(acceptanceWindow(env,now).ceilingUsd,.594592775);
 for(const change of [{MISSION_AI_ACCEPTANCE_SCOPE:'anything'},{MISSION_AI_ACCEPTANCE_RUN_ID:''},
  {MISSION_AI_DELEGATION_ENABLED:'true'},{MISSION_AI_ACCEPTANCE_ALLOWANCE_USD:'.501'}])
  assert.equal(acceptanceWindow({...env,...change},now),null);
 const normal={...env};delete normal.MISSION_AI_ACCEPTANCE_SCOPE;
 assert.equal(acceptanceWindow(normal,now),null);
 normal.MISSION_AI_ACCEPTANCE_ALLOWANCE_USD='.13';assert.deepEqual(acceptanceWindow(normal,now).allowedToolNames,['read_file']);
});
test('image cases share one native/delegated ceiling, preserve claims and refuse replay',async()=>{
 const f=await fixture();await f.ledger.reserve({reservationId:'baseline',reserveUsd:.094592775,directCapUsd:175,now});
 await f.ledger.settle({reservationId:'baseline',actualUsd:.094592775});
 await f.run({prompt:'Unique fixture',enabled:false,fetchImpl:()=>assert.fail('injection')});
 assert.equal(f.calls(),1);
 await assert.rejects(f.run({prompt:'Do not repeat'}),/already_claimed/);
 await assert.rejects(f.run({prompt:'Edit fixture',referenceImage:f.image}),/monthly_hard_limit/);
 assert.equal(f.calls(),1);assert.equal((await f.ledger.summary({now})).reservedUsd,0);
 assert.equal(f.claims.size,2);
});
test('expired window, oversized images, unknown generation size and unmatched edit never dispatch',async()=>{
 const f=await fixture();
 for(const input of [{prompt:'x',imageSize:'4K'},{prompt:'x',referenceImage:f.image},
  {prompt:'x',referenceImage:{...f.image,data:'A'.repeat(400001)}},{prompt:'x'.repeat(2001)}])
  await assert.rejects(f.run(input),/image_config_invalid/);
 f.setClock(new Date(env.MISSION_AI_ACCEPTANCE_END));await assert.rejects(f.run({prompt:'x'}),/delegation_disabled/);
 assert.equal(f.calls(),0);assert.equal(f.claims.size,0);
});
test('failure persisting dispatch cancels only the provably unsent reservation and blocks replay',async()=>{
 const f=await fixture();f.store.markDispatch=async()=>{throw Error('claim_uncertain');};
 await assert.rejects(f.run({prompt:'x'}),/claim_uncertain/);assert.equal(f.calls(),0);
 assert.equal((await f.ledger.summary({now})).reservedUsd,0);
 await assert.rejects(f.run({prompt:'x'}),/already_claimed/);
});

test('one generation and its exact edited reference complete once when both fit',async()=>{
 const f=await fixture();
 // No historical seed: the same cap accepts .52 of fixture cost below .594592775.
 await f.run({prompt:'Unique fixture'});await f.run({prompt:'Meaningful edit',referenceImage:f.image});
 assert.equal(f.calls(),2);assert.equal((await f.ledger.summary({now})).reservedUsd,0);
 assert.equal([...f.claims.values()].every(row=>row.stage==='finished'),true);
 assert.notEqual([...f.claims.values()][0].result.imageHash,[...f.claims.values()][1].result.imageHash);
 await assert.rejects(f.run({prompt:'No duplicate edit',referenceImage:f.image}),/already_claimed/);
});
