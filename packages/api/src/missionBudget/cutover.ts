import { normalizeReconciliations, verifyReconciliationEvidence } from './reconciliation.js';
import type { ProviderReconciliation } from './reconciliation.js';

type Policy = { targetUsd: number; economyUsd: number; hardUsd: number };
type Row = { id: string; createdAt: string; tokenType: string; tokenValue: number; model?: string };
type History = { id: string; at: string; usd: number; provider: string; model: string };
export interface CutoverPlan {
  version: 1 | 2;
  reconciliations?: ProviderReconciliation[];
  reconciliationUsd?: number;
  correctedNativeUsd?: number;
  database: string;
  cutoverAt: string;
  monthStart: string;
  timeZone: string;
  policy: Policy;
  history: History[];
  nativeUsd: number;
  digest: string;
}
interface Dependencies {
  hash: (text: string) => string;
  monthStart: (now: Date, timeZone: string) => Date;
  readRows: (database: string, monthStart: Date) => Promise<Row[]>;
  providerForModel: (model: string) => string;
  activate: (input: { policy: Policy; timeZone: string; cutoverAt: string; history: History[]; reconciliations?: ProviderReconciliation[] }) => Promise<unknown>;
  now: () => Date;
  verifyEvidence?: (hashes: string[]) => Promise<boolean>;
}
function fail(code: string): never { throw new Error(code); }
function iso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('invalid_cutover_date');
  return new Date(value).toISOString();
}

/** A preparation tool, never an HTTP activation endpoint. The operator must drain all paid traffic. */
export function createNativeCutover(deps: Dependencies) {
  async function plan(input: {
    database: string; cutoverAt: string; timeZone: string; policy: Policy; reconciliations?: ProviderReconciliation[];
  }): Promise<CutoverPlan> {
    if (!input.database || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.database)) fail('invalid_native_database');
    const cutoff = iso(input.cutoverAt);
    const now = deps.now();
    if (new Date(cutoff) > now) fail('future_cutover');
    const policy = input.policy;
    if (!policy || [policy.targetUsd, policy.economyUsd, policy.hardUsd].some((n) =>
      typeof n !== 'number' || !Number.isFinite(n) || n < 0) ||
      policy.targetUsd > policy.economyUsd || policy.economyUsd > policy.hardUsd) fail('invalid_budget_policy');
    const start = deps.monthStart(new Date(cutoff), input.timeZone);
    if (start.toISOString() !== deps.monthStart(now, input.timeZone).toISOString()) fail('cutover_month_changed');
    const rows = await deps.readRows(input.database, start);
    if (!Array.isArray(rows) || rows.length > 100_000) fail('native_history_too_large');
    const seen = new Set<string>();
    const history: History[] = [];
    for (const row of rows) {
      if (!row || !['prompt', 'completion'].includes(row.tokenType)) fail('invalid_native_transaction');
      if (typeof row.tokenValue !== 'number' || !Number.isFinite(row.tokenValue)) fail('invalid_native_transaction');
      // Positive credits/topups are not paid API charges.
      if (row.tokenValue >= 0) continue;
      const at = iso(row.createdAt);
      if (at > cutoff) fail('native_not_drained');
      if (at < start.toISOString() || !row.id || typeof row.id !== 'string' || seen.has(row.id)) fail('invalid_native_transaction');
      seen.add(row.id);
      const model = row.model ?? 'unknown';
      if (typeof model !== 'string' || !model || model.length > 200) fail('invalid_native_transaction');
      history.push({ id: `${input.database}/transactions/${row.id}`, at,
        usd: -row.tokenValue / 1_000_000, model, provider: deps.providerForModel(model) });
    }
    history.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const nativeUsd = history.reduce((sum, item) => sum + item.usd, 0);
    if (!Number.isFinite(nativeUsd)) fail('invalid_native_total');
    const base = { version: 1 as const, database: input.database, cutoverAt: cutoff,
      monthStart: start.toISOString(), timeZone: input.timeZone,
      policy: { targetUsd: policy.targetUsd, economyUsd: policy.economyUsd, hardUsd: policy.hardUsd },
      history, nativeUsd };
    if (input.reconciliations === undefined) return { ...base, digest: deps.hash(JSON.stringify(base)) };
    const reconciliations = normalizeReconciliations(input.reconciliations, history,
      { database: input.database, monthStart: base.monthStart, cutoverAt: cutoff }, deps.hash);
    await verifyReconciliationEvidence(reconciliations, deps.verifyEvidence);
    const reconciliationUsd = reconciliations.reduce((sum, item) => sum + item.adjustmentNanoUsd / 1e9, 0);
    const correctedNativeUsd = nativeUsd + reconciliationUsd;
    if (!Number.isFinite(correctedNativeUsd)) fail('invalid_native_total');
    const revised = { ...base, version: 2 as const, reconciliations, reconciliationUsd, correctedNativeUsd };
    return { ...revised, digest: deps.hash(JSON.stringify(revised)) };
  }
  return {
    plan,
    async apply(input: { plan: CutoverPlan; approvedDigest: string; drained: boolean;
      nativeEnabled: string | undefined; delegationEnabled: string | undefined }): Promise<unknown> {
      if (input.drained !== true || input.nativeEnabled !== 'false' || input.delegationEnabled !== 'false') {
        fail('cutover_requires_drained_disabled_services');
      }
      const saved = input.plan;
      if (![1, 2].includes(saved?.version) ||
          (saved.version === 1 && saved.reconciliations !== undefined) ||
          (saved.version === 2 && saved.reconciliations === undefined) || !/^[a-f0-9]{64}$/.test(input.approvedDigest) ||
          input.approvedDigest !== saved.digest) fail('cutover_approval_mismatch');
      const fresh = await plan(saved);
      // Includes IDs, costs, models and timestamps: changed/missing/late rows invalidate approval.
      if (fresh.digest !== saved.digest || JSON.stringify(fresh) !== JSON.stringify(saved)) fail('cutover_plan_changed');
      return deps.activate({ policy: fresh.policy, timeZone: fresh.timeZone,
        cutoverAt: fresh.cutoverAt, history: fresh.history,
        ...(fresh.version === 2 ? { reconciliations: fresh.reconciliations } : {}) });
    },
  };
}
