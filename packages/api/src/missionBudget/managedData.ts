type Json = Record<string, unknown>;
const ID = /^[a-fA-F0-9]{24}$/;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  return value as Json;
}
function keys(value: Json, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
}
function string(value: unknown, max: number, empty = false): void {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new Error();
}
function memory(value: unknown, create = false): void {
  const body = object(value); keys(body, ['key', 'value']);
  if (create || body.key !== undefined) {
    string(body.key, 1000); if (!/^[a-z_]+$/.test(body.key as string)) throw new Error();
  }
  string(body.value, 10000);
}

/** Bounded owner-data routes only. Authentication/ownership stay in each existing router and repository. */
export function admitManagedData(method: string | undefined, raw: string, body: unknown): boolean {
  const [path, query = ''] = raw.split('?');
  if (!path.startsWith('/api/projects') && !path.startsWith('/api/memories')) return false;
  if (/[\\%#]/.test(path) || raw.split('?').length > 2) throw new Error();
  if (method === 'GET' && path === '/api/projects') {
    const params = new URLSearchParams(query); const seen = new Set<string>();
    for (const [key, value] of params) {
      if (seen.has(key) || !['cursor', 'limit', 'sortBy', 'sortDirection', 'search'].includes(key) || value.length > 1000) throw new Error();
      seen.add(key);
      if (key === 'limit' && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) throw new Error();
      if (key === 'sortBy' && !['name', 'createdAt', 'lastConversationAt'].includes(value)) throw new Error();
      if (key === 'sortDirection' && !['asc', 'desc'].includes(value)) throw new Error();
    }
    return true;
  }
  if (query) throw new Error();
  if (path === '/api/memories') {
    if (method === 'GET') return true;
    if (method === 'POST') { memory(body, true); return true; }
  }
  if (path === '/api/memories/preferences' && method === 'PATCH') {
    const input = object(body); keys(input, ['memories']); if (typeof input.memories !== 'boolean') throw new Error(); return true;
  }
  if (/^\/api\/memories\/(?:id\/[a-fA-F0-9]{24}|[a-z_]{1,1000})$/.test(path)) {
    if (method === 'PATCH') { memory(body); return true; }
    if (method === 'DELETE') return true;
  }
  if (path === '/api/projects' && method === 'POST' || /^\/api\/projects\/[a-fA-F0-9]{24}$/.test(path) && method === 'PATCH') {
    const input = object(body); keys(input, ['name', 'description']);
    if (method === 'POST' || input.name !== undefined) string(input.name, 256);
    if (input.description !== undefined) string(input.description, 10000, true);
    if (!Object.keys(input).length) throw new Error(); return true;
  }
  if (/^\/api\/projects\/[a-fA-F0-9]{24}$/.test(path) && ['GET', 'DELETE'].includes(method ?? '')) return true;
  if (/^\/api\/projects\/conversations\/[A-Za-z0-9_-]{1,256}$/.test(path) && method === 'PUT') {
    const input = object(body); keys(input, ['projectId']);
    if (input.projectId !== null && (typeof input.projectId !== 'string' || !ID.test(input.projectId))) throw new Error(); return true;
  }
  throw new Error();
}
