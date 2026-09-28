import { FreeSearchError } from './freeSearch.js';

type Json = Record<string, unknown>;
export interface FreeCreditStore {
  read(): Promise<{ accountUsed: number; keyUsed: number }>;
  claim(input: { accountUsed: number; keyUsed: number; keyLimit: number }): Promise<string>;
  settle(lease: string): Promise<void>;
  lock(lease: string): Promise<void>;
}
interface Repository {
  initialize(id: string): Promise<unknown>;
  read(id: string): Promise<unknown>;
  update(query: Json, update: Json): Promise<unknown>;
}
function fail(code: string, status = 503): never { throw new FreeSearchError(code, status); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('search_store_unready');
  return value;
}
function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('search_store_unready');
  return value as Json;
}

/** Durable single-account free-credit holds. A crash or ambiguous POST leaves admission blocked. */
export function createFreeCreditStore(deps: {
  repository: Repository; keyId: string; now: () => Date; randomId: () => string;
}): FreeCreditStore {
  const keyId = deps.keyId;
  if (!/^[a-f0-9]{64}$/.test(keyId)) fail('search_store_unready');
  function id(): string {
    const now = deps.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('search_store_unready');
    return `tavily-free:${now.toISOString().slice(0, 7)}`;
  }
  async function state(scope: string) {
    await deps.repository.initialize(scope);
    const row = record(await deps.repository.read(scope));
    if (row._id !== scope || typeof row.uncertain !== 'boolean' ||
        (row.pending !== null && typeof row.pending !== 'string')) fail('search_store_unready');
    if (row.uncertain || row.pending !== null) fail('search_usage_uncertain');
    const usage = record(row.keyUsage);
    const accountUsed = count(row.accountUsed);
    const keyUsed = count(usage[keyId] ?? 0);
    if (Object.values(usage).some(value => !Number.isSafeInteger(value) || (value as number) < 0)) {
      fail('search_store_unready');
    }
    return { accountUsed, keyUsed };
  }
  async function finalize(lease: string, uncertain: boolean) {
    const separator = lease.indexOf('|');
    if (separator < 1) fail('search_store_unready');
    const scope = lease.slice(0, separator);
    const pending = lease.slice(separator + 1);
    if (!/^tavily-free:\d{4}-(0[1-9]|1[0-2])$/.test(scope) ||
        !/^[a-zA-Z0-9_-]{16,200}$/.test(pending)) fail('search_store_unready');
    const result = record(await deps.repository.update({ _id: scope, pending },
      { $set: { pending: null, uncertain } }));
    if (result._id !== scope || result.pending !== null || result.uncertain !== uncertain) {
      fail('search_store_unready');
    }
  }
  return {
    read: async () => state(id()),
    async claim(input) {
      const scope = id();
      const before = await state(scope);
      const accountUsed = Math.max(before.accountUsed, count(input.accountUsed));
      const keyUsed = Math.max(before.keyUsed, count(input.keyUsed));
      const keyLimit = count(input.keyLimit);
      if (keyLimit < 1 || keyLimit > 1000) fail('search_store_unready');
      if (accountUsed >= 1000 || keyUsed >= keyLimit) fail('search_free_credits_exhausted', 429);
      const pending = deps.randomId();
      if (!/^[a-zA-Z0-9_-]{16,200}$/.test(pending)) fail('search_store_unready');
      const result = await deps.repository.update({
        _id: scope, accountUsed: before.accountUsed, pending: null, uncertain: false,
        $expr: { $eq: [{ $ifNull: [`$keyUsage.${keyId}`, 0] }, before.keyUsed] },
      }, { $set: { accountUsed: accountUsed + 1, [`keyUsage.${keyId}`]: keyUsed + 1, pending } });
      if (!result) fail('search_busy', 409);
      const row = record(result);
      if (row._id !== scope || row.pending !== pending || row.accountUsed !== accountUsed + 1 ||
          record(row.keyUsage)[keyId] !== keyUsed + 1) fail('search_store_unready');
      return `${scope}|${pending}`;
    },
    settle: lease => finalize(lease, false),
    lock: lease => finalize(lease, true),
  };
}
