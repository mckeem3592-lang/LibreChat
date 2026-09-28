/** Private, one-shot owner provisioning. This module has no HTTP route or logging. */
type Awaitable<T> = T | Promise<T>;
type Environment = Readonly<Record<string, string | undefined>>;
interface Owner {
  id: string;
  email: string;
  password: string;
  provider: string;
  role: string;
  emailVerified: boolean;
  expiresAt?: unknown;
  tenantId?: unknown;
}
interface Claim {
  version?: number;
  ownerId?: string;
  email?: string;
}
interface OwnerDocument extends Owner {
  name: string;
  username: string;
  avatar: null;
}
interface Transaction {
  /** Upsert/write the fixed singleton in this transaction before reading users. */
  lockSingleton(): Promise<Claim>;
  countUsers(): Promise<number>;
  findOwner(id: string): Promise<Owner | null>;
  createOwner(owner: OwnerDocument): Promise<void>;
  finishClaim(claim: Required<Claim> & { createdAt: Date }): Promise<void>;
}
interface Dependencies {
  env: Environment;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  hashPassword(password: string): Awaitable<string>;
  comparePassword(password: string, hash: string): Awaitable<boolean>;
  randomId(): string;
  now(): Date;
}

function refuse(code: string): never { throw new Error(code); }
function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^\$2[aby]\$(1[0-9]|2[0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(value);
}

function credentials(env: Environment): { email: string; password: string } {
  if (env.MISSION_AI_BOOTSTRAP_OWNER !== 'true') refuse('owner_bootstrap_disabled');
  if (env.ALLOW_REGISTRATION !== 'false' || env.ALLOW_SOCIAL_REGISTRATION !== 'false') {
    refuse('owner_bootstrap_registration_enabled');
  }
  try {
    const uri = new URL(env.MONGO_URI ?? '');
    const options = new Set(['retryWrites', 'w', 'appName', 'authSource', 'tls']);
    const seen = new Set<string>();
    if (uri.protocol !== 'mongodb+srv:' || !uri.hostname.endsWith('.mongodb.net') ||
        uri.port || uri.hash || uri.pathname !== '/MissionAIChatTest' ||
        decodeURIComponent(uri.username) !== 'mission_ai_chat_test' || !decodeURIComponent(uri.password)) {
      refuse('owner_bootstrap_wrong_database');
    }
    uri.searchParams.forEach((value, key) => {
      if (!options.has(key) || seen.has(key) ||
          ((key === 'retryWrites' || key === 'tls') && value !== 'true') ||
          (key === 'w' && value !== 'majority') || (key === 'authSource' && value !== 'admin')) {
        refuse('owner_bootstrap_wrong_database');
      }
      seen.add(key);
    });
  } catch { refuse('owner_bootstrap_wrong_database'); }
  const email = env.MISSION_AI_OWNER_EMAIL?.trim().toLowerCase();
  const password = env.MISSION_AI_OWNER_PASSWORD;
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    refuse('owner_bootstrap_invalid_email');
  }
  if (typeof password !== 'string' || [...password].length < 12 ||
      new TextEncoder().encode(password).length > 72 || !password.trim() || /[\x00-\x1f\x7f]/.test(password)) {
    refuse('owner_bootstrap_invalid_password');
  }
  return { email, password };
}

export async function bootstrapMissionAiOwner(deps: Dependencies): Promise<{ status: 'created' | 'already_initialized' }> {
  const { email, password } = credentials(deps.env);
  const id = deps.randomId();
  const createdAt = deps.now();
  if (!/^[a-f0-9]{24}$/.test(id) || !(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
    refuse('owner_bootstrap_invalid_dependencies');
  }
  // Hash before a database transaction; only the hash crosses the storage boundary.
  const hash = await deps.hashPassword(password);
  if (!isHash(hash)) refuse('owner_bootstrap_invalid_hash');
  return deps.transaction(async (tx) => {
    const claim = await tx.lockSingleton();
    const count = await tx.countUsers();
    if (!Number.isSafeInteger(count) || count < 0) refuse('owner_bootstrap_invalid_state');
    if (claim.ownerId !== undefined || claim.email !== undefined) {
      if (claim.version !== 1 || claim.email !== email ||
          typeof claim.ownerId !== 'string' || !/^[a-f0-9]{24}$/.test(claim.ownerId) || count !== 1) {
        refuse('owner_bootstrap_identity_conflict');
      }
      const owner = await tx.findOwner(claim.ownerId);
      if (!owner || owner.id !== claim.ownerId || owner.email !== email || owner.provider !== 'local' ||
          owner.role !== 'ADMIN' || owner.emailVerified !== true || owner.expiresAt != null ||
          owner.tenantId != null || !isHash(owner.password) ||
          await deps.comparePassword(password, owner.password) !== true) {
        refuse('owner_bootstrap_identity_conflict');
      }
      return { status: 'already_initialized' };
    }
    if (count !== 0 || (claim.version !== undefined && claim.version !== 1)) {
      refuse('owner_bootstrap_not_empty');
    }
    await tx.createOwner({ id, email, password: hash, provider: 'local', role: 'ADMIN',
      emailVerified: true, name: 'Mission AI Owner', username: 'mission-ai-owner', avatar: null });
    await tx.finishClaim({ version: 1, ownerId: id, email, createdAt });
    return { status: 'created' };
  });
}
