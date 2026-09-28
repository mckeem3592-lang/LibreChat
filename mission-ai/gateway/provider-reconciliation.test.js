import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createNativeCutover } from './generated/cutover.js';
import { createReconciliationEvidence, normalizeReconciliations } from './generated/reconciliation.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { queryMissionDashboard, combineDashboard } from './mission-dashboard.js';
import { requestBudget, readBudgetDashboard } from './request-budget.js';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date('2026-09-28T17:00:00.000Z');
const periodStart = '2026-09-01T06:00:00.000Z';
const policy = { targetUsd: 2, economyUsd: 3, hardUsd: 4 };
const input = { database: 'test', cutoverAt: now.toISOString(), timeZone: 'America/Denver', policy };
const documents = new Map([['usage', Buffer.from('synthetic usage')], ['pricing', Buffer.from('synthetic rates')],
  ['scope', Buffer.from('synthetic scope attestation')]]);
const correction = () => ({ provider: 'anthropic', reason: 'provider_usage_reconciliation',
  basis: 'provider_usage_and_published_rates', database: 'test', periodStart,
  periodEnd: now.toISOString(), coveredHistoryIds: ['test/transactions/a'],
  recordedNanoUsd: 2_000_000_000, providerNanoUsd: 2_500_000_000, adjustmentNanoUsd: 500_000_000,
  evidence: { usageSha256: hash(documents.get('usage')), pricingSha256: hash(documents.get('pricing')),
    scopeSha256: hash(documents.get('scope')) } });
function evidence(items = [correction()], docs = new Map(documents)) {
  return createReconciliationEvidence({ version: 1, reconciliations: items,
    evidenceFiles: [...documents].map(([path, bytes]) => ({ path, sha256: hash(bytes) })) },
  { read: async (path) => docs.get(path), hash });
}
function fixture(extra = {}) {
  const rows = [{ id: 'a', createdAt: '2026-09-26T12:00:00.000Z', tokenType: 'prompt',
    tokenValue: -2_000_000, model: 'synthetic-sonnet' }];
  const ledger = createMemoryUsageLedger();
  const tool = createNativeCutover({ hash, monthStart: monthStartFor, providerForModel: () => 'anthropic',
    readRows: async () => rows, now: () => now, activate: (args) => ledger.activateSharedBudget(args),
    verifyEvidence: evidence().verifyEvidence, ...extra });
  return { tool, ledger, rows };
}
const apply = (f, plan, extra = {}) => f.tool.apply({ plan, approvedDigest: plan.digest,
  nativeEnabled: 'false', delegationEnabled: 'false', drained: true, ...extra });

test('v2 approval imports a distinct positive correction once, preserving original data and cost categories', async () => {
  const f = fixture(), original = structuredClone(f.rows);
  const plan = await f.tool.plan({ ...input, reconciliations: [correction()] });
  assert.equal(plan.version, 2);
  assert.equal(plan.nativeUsd, 2);
  assert.equal(plan.reconciliationUsd, 0.5);
  assert.equal(plan.correctedNativeUsd, 2.5);
  assert.equal(await f.ledger.sharedBudget(), null);
  await apply(f, plan);
  await apply(f, plan);
  assert.deepEqual(f.rows, original);
  const summary = await f.ledger.summary({ now });
  assert.equal(summary.historyUsd, 2);
  assert.equal(summary.nativeUsd, 0);
  assert.equal(summary.delegatedUsd, 0);
  assert.equal(summary.reconciliationUsd, 0.5);
  assert.equal(summary.settledUsd, 2.5);
  assert.equal(summary.reservedUsd, 0);
  const id = `provider-reconciliation:${plan.reconciliations[0].id}`;
  await assert.rejects(() => f.ledger.reserve({ source: 'provider-reconciliation', now, reserveUsd: 1 }), /invalid_reservation_source/);
  await assert.rejects(() => f.ledger.settle({ reservationId: id, actualUsd: 0.5 }), /invalid_reservation_source/);
  assert.equal(await f.ledger.release({ reservationId: id }), false);
  const nativeReader = () => assert.fail('must not re-read native mirror after activation');
  const dashboard = await queryMissionDashboard({ now, usageLedger: f.ledger, nativeReader });
  assert.equal(dashboard.nativeSpendUsd, 2);
  assert.equal(dashboard.delegatedSpendUsd, 0);
  assert.equal(dashboard.reconciliationUsd, 0.5);
  assert.equal(dashboard.spendUsd, 2.5);
  assert.equal(dashboard.byProvider[0].spendUsd, 2.5);
  assert.equal(dashboard.byTask.find((row) => row.task === 'provider-reconciliation').spendUsd, 0.5);
  const budget = requestBudget(await readBudgetDashboard({ ledger: f.ledger, nativeReader, now }), summary);
  assert.equal(budget.projectedUsd, 2.5);
  assert.equal(budget.reconciliationUsd, 0.5);
  for (const reconciliationUsd of [undefined, null, NaN, '0.5', -1, 0]) {
    assert.throws(() => requestBudget({ accountingMode: 'shared', ...policy },
      { ...summary, reconciliationUsd }), /invalid_budget_snapshot/);
  }
  await assert.rejects(() => f.ledger.reserve({ now, reserveUsd: 1.500001 }), /monthly_hard_limit/);
  await f.ledger.reserve({ now, reserveUsd: 1.5 });
});

test('v2 digest binds evidence, coverage, arithmetic and basis; equivalent input order is canonical', async () => {
  const f = fixture();
  const plan = await f.tool.plan({ ...input, reconciliations: [correction()] });
  const reversed = Object.fromEntries(Object.entries(correction()).reverse());
  assert.deepEqual(await f.tool.plan({ ...input, reconciliations: [reversed] }), plan);
  for (const mutate of [
    (p) => { p.reconciliations[0].adjustmentNanoUsd++; },
    (p) => { p.reconciliations[0].providerNanoUsd++; },
    (p) => { p.reconciliations[0].evidence.usageSha256 = 'a'.repeat(64); },
    (p) => { p.reconciliations[0].basis = 'exact_invoice'; },
    (p) => { p.reconciliations[0].coveredHistoryIds = ['test/transactions/absent']; },
    (p) => { p.reconciliationUsd = 0; },
    (p) => { p.version = 1; },
  ]) {
    const changed = structuredClone(plan); mutate(changed);
    await assert.rejects(() => apply(f, changed));
    assert.equal(await f.ledger.sharedBudget(), null);
  }
});

test('strict reconciliation schema rejects unsafe labels, bad scopes, non-positive values and overlapping rows', async () => {
  const f = fixture();
  for (const change of [
    { provider: '__proto__' }, { provider: null }, { provider: ['anthropic'] }, { extra: 'secret' }, { id: 'manual-id' },
    { evidence: { ...correction().evidence, secret: 'do not persist' } },
    { database: 'other' }, { periodStart: '2026-08-01T06:00:00.000Z' },
    { periodEnd: '2026-09-29T17:00:00.000Z' }, { periodEnd: periodStart },
    { adjustmentNanoUsd: 0 }, { adjustmentNanoUsd: -1 }, { adjustmentNanoUsd: 0.5 },
    { adjustmentNanoUsd: NaN }, { adjustmentNanoUsd: Infinity },
    { providerNanoUsd: Number.MAX_SAFE_INTEGER + 1 }, { recordedNanoUsd: 1 },
    { coveredHistoryIds: [] }, { coveredHistoryIds: ['test/transactions/a', 'test/transactions/a'] },
  ]) await assert.rejects(() => f.tool.plan({ ...input, reconciliations: [{ ...correction(), ...change }] }));
  await assert.rejects(() => f.tool.plan({ ...input, reconciliations: [correction(), correction()] }));
  await assert.rejects(() => f.tool.plan({ ...input, reconciliations: [] }));
  assert.equal(await f.ledger.sharedBudget(), null);
});

test('evidence files are rehashed during approval and missing, changed, extra or oversized evidence fails closed', async () => {
  const docs = new Map(documents), files = evidence([correction()], docs);
  const f = fixture({ verifyEvidence: files.verifyEvidence });
  const plan = await f.tool.plan({ ...input, reconciliations: files.reconciliations });
  docs.set('usage', Buffer.from('changed after plan'));
  await assert.rejects(() => apply(f, plan), /reconciliation_evidence_unverified/);
  assert.equal(await f.ledger.sharedBudget(), null);
  const missing = fixture({ verifyEvidence: undefined });
  await assert.rejects(() => missing.tool.plan({ ...input, reconciliations: [correction()] }), /evidence_unverified/);
  assert.throws(() => createReconciliationEvidence({ version: 1, reconciliations: [],
    evidenceFiles: [{ sha256: 'x', path: 'private' }] }, { read: async () => Buffer.alloc(0), hash }));
  docs.set('usage', Buffer.alloc(5_000_001));
  await assert.rejects(() => apply(f, plan), /evidence_unverified/);
  const normalized = normalizeReconciliations([correction()], plan.history,
    { database: 'test', monthStart: periodStart, cutoverAt: input.cutoverAt }, hash);
  assert.equal(normalized[0].id, plan.reconciliations[0].id);
});

test('v2 still requires disabled/drained approval and rejects late or repriced native data', async () => {
  const f = fixture();
  const plan = await f.tool.plan({ ...input, reconciliations: [correction()] });
  for (const extra of [{ drained: false }, { nativeEnabled: 'true' }, { delegationEnabled: 'true' },
    { approvedDigest: '0'.repeat(64) }]) await assert.rejects(() => apply(f, plan, extra));
  f.rows[0].tokenValue--;
  await assert.rejects(() => apply(f, plan));
  assert.equal(await f.ledger.sharedBudget(), null);
});

test('shared dashboard rejects missing, malformed and inconsistent accounting partitions', () => {
  const dashboard = { accountingMode: 'shared', timeZone: 'America/Denver', ...policy };
  const summary = { sharedMode: true, nativeUsd: 0, historyUsd: 2, delegatedUsd: 0,
    reconciliationUsd: 0.5, settledUsd: 2.5, reservedUsd: 0 };
  for (const key of ['nativeUsd', 'historyUsd', 'delegatedUsd', 'reconciliationUsd', 'settledUsd', 'reservedUsd']) {
    for (const value of [undefined, null, NaN, Infinity, -1, '0']) {
      assert.throws(() => combineDashboard(dashboard, { ...summary, [key]: value }, {}), /invalid_budget_snapshot/);
    }
  }
  assert.throws(() => combineDashboard(dashboard, { ...summary, reconciliationUsd: 0 }, {}), /invalid_budget_snapshot/);
});

test('v1 plan digest remains byte-for-byte compatible with the pre-reconciliation fixture', async () => {
  const f = fixture({ providerForModel: () => 'openai', readRows: async () => [
    { id: 'prompt', createdAt: now.toISOString(), tokenType: 'prompt', tokenValue: -60_000, model: 'gpt-6-luna' },
    { id: 'completion', createdAt: now.toISOString(), tokenType: 'completion', tokenValue: -5_000, model: 'gpt-6-luna' },
  ] });
  const plan = await f.tool.plan({ ...input, policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 } });
  assert.equal(plan.version, 1);
  assert.equal(plan.digest, 'fdb385f28fd95f17b913978a980ac23dd4dea0505c5603466ec60c779a851665');
  assert.equal(Object.hasOwn(plan, 'reconciliations'), false);
});
