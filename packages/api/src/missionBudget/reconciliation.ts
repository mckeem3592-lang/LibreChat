export type ReconciliationHistory = { id: string; at: string; usd: number; provider?: string };
export type ProviderReconciliation = {
  id: string;
  provider: 'openai' | 'anthropic' | 'google';
  reason: 'provider_usage_reconciliation';
  basis: 'provider_usage_and_published_rates';
  database: string;
  periodStart: string;
  periodEnd: string;
  coveredHistoryIds: string[];
  recordedNanoUsd: number;
  providerNanoUsd: number;
  adjustmentNanoUsd: number;
  evidence: { usageSha256: string; pricingSha256: string; scopeSha256: string };
};
type Hash = (text: string) => string;
function fail(): never { throw new Error('invalid_provider_reconciliation'); }
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))) fail();
  return value as Record<string, unknown>;
}
function nano(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail();
  return value;
}
export function usdToNano(usd: number): number {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) fail();
  const scaled = usd * 1e9;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > Math.max(1e-6, Math.abs(scaled) * Number.EPSILON * 8)) fail();
  return nano(rounded);
}

/** Evidence hashes attest identity, not authenticity; the operator must review account/scope. */
export function normalizeReconciliations(input: unknown, history: ReconciliationHistory[],
  context: { database?: string; monthStart: string; cutoverAt: string }, hash: Hash): ProviderReconciliation[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) fail();
  const byId = new Map(history.map((item) => [item.id, item]));
  const covered = new Set<string>();
  const result = input.map((value) => {
    const row = object(value, ['provider', 'reason', 'basis', 'database', 'periodStart', 'periodEnd',
      'coveredHistoryIds', 'recordedNanoUsd', 'providerNanoUsd', 'adjustmentNanoUsd', 'evidence'], ['id']);
    if (typeof row.provider !== 'string' || !['openai', 'anthropic', 'google'].includes(row.provider) ||
        row.reason !== 'provider_usage_reconciliation' ||
        row.basis !== 'provider_usage_and_published_rates' ||
        typeof row.database !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.database) ||
        (context.database !== undefined && row.database !== context.database)) fail();
    const provider = row.provider as ProviderReconciliation['provider'];
    const database = row.database;
    const periodStart = stamp(row.periodStart), periodEnd = stamp(row.periodEnd);
    if (periodStart < context.monthStart || periodEnd > context.cutoverAt || periodStart >= periodEnd) fail();
    if (!Array.isArray(row.coveredHistoryIds) || !row.coveredHistoryIds.length || row.coveredHistoryIds.length > 100_000) fail();
    let recorded = 0;
    const coveredHistoryIds = row.coveredHistoryIds.map((id) => {
      if (typeof id !== 'string' || !id.startsWith(`${database}/transactions/`) || covered.has(id)) fail();
      const entry = byId.get(id);
      if (!entry || entry.provider !== provider || entry.at < periodStart || entry.at >= periodEnd) fail();
      recorded = nano(recorded + usdToNano(entry.usd));
      covered.add(id);
      return id;
    }).sort();
    const recordedNanoUsd = nano(row.recordedNanoUsd), providerNanoUsd = nano(row.providerNanoUsd);
    const adjustmentNanoUsd = nano(row.adjustmentNanoUsd);
    if (recorded !== recordedNanoUsd || adjustmentNanoUsd <= 0 ||
        providerNanoUsd - recordedNanoUsd !== adjustmentNanoUsd) fail();
    const rawEvidence = object(row.evidence, ['usageSha256', 'pricingSha256', 'scopeSha256']);
    for (const value of Object.values(rawEvidence)) if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail();
    const evidence = { usageSha256: rawEvidence.usageSha256 as string,
      pricingSha256: rawEvidence.pricingSha256 as string, scopeSha256: rawEvidence.scopeSha256 as string };
    const reason = 'provider_usage_reconciliation' as const;
    const id = hash(JSON.stringify({ provider, reason, database, periodStart, periodEnd, coveredHistoryIds,
      scopeSha256: evidence.scopeSha256 }));
    if (row.id !== undefined && row.id !== id) fail();
    return { id, provider, reason, basis: 'provider_usage_and_published_rates' as const, database, periodStart, periodEnd, coveredHistoryIds,
      recordedNanoUsd, providerNanoUsd, adjustmentNanoUsd, evidence };
  });
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export async function verifyReconciliationEvidence(items: ProviderReconciliation[],
  verify: ((hashes: string[]) => Promise<boolean>) | undefined): Promise<void> {
  const hashes = [...new Set(items.reduce<string[]>((values, item) => values.concat(Object.values(item.evidence)), []))].sort();
  if (!verify || await verify(hashes) !== true) throw new Error('reconciliation_evidence_unverified');
}

/** Private operator files are read again on every plan/apply; their paths never enter the plan. */
export function createReconciliationEvidence(input: unknown, deps: {
  read: (path: string) => Promise<Uint8Array>; hash: (bytes: Uint8Array) => string;
}) {
  const bundle = object(input, ['version', 'reconciliations', 'evidenceFiles']);
  if (bundle.version !== 1 || !Array.isArray(bundle.evidenceFiles) ||
      bundle.evidenceFiles.length > 300 || !Array.isArray(bundle.reconciliations)) fail();
  const files = new Map<string, string>();
  for (const value of bundle.evidenceFiles) {
    const file = object(value, ['sha256', 'path']);
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        files.has(file.sha256) || typeof file.path !== 'string' || !file.path ||
        file.path.length > 4096 || file.path.includes('\0')) fail();
    files.set(file.sha256, file.path);
  }
  return { reconciliations: bundle.reconciliations, verifyEvidence: async (hashes: string[]) => {
    if (hashes.length !== files.size || hashes.some((hash) => !files.has(hash))) return false;
    for (const hash of hashes) {
      const bytes = await deps.read(files.get(hash)!);
      // Evidence is deliberately bounded; raw provider exports stay outside logs and plans.
      if (bytes.byteLength === 0 || bytes.byteLength > 5_000_000 || deps.hash(bytes) !== hash) return false;
    }
    return true;
  } };
}
