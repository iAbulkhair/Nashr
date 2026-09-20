import { Redis } from "@upstash/redis";

/**
 * Storage adapter. Upstash Redis in production; in-memory Map when no
 * credentials are present (local dev only — data is lost on restart).
 */
type Store = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  lpush(key: string, value: string): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Keep only the newest `keep` entries of a list written with lpush. */
  ltrim(key: string, keep: number): Promise<void>;
  /** Remove every occurrence of `value` from a list. Deleting the record a list points at does not shorten the list. */
  lrem(key: string, value: string): Promise<void>;
  hset(key: string, field: string, value: unknown): Promise<void>;
  hgetall<T = unknown>(key: string): Promise<Record<string, T>>;
  hdel(key: string, field: string): Promise<void>;
  sadd(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, member: string): Promise<void>;
  incrby(key: string, n: number): Promise<number>;
  /** SET NX with TTL. True when this caller won the lock. */
  lock(key: string, ttlSeconds: number): Promise<boolean>;
  unlock(key: string): Promise<void>;
};

function upstash(): Store | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = new Redis({ url, token });
  return {
    async get<T>(key: string) {
      return (await r.get<T>(key)) ?? null;
    },
    async set(key, value, ttl) {
      if (ttl) await r.set(key, value as never, { ex: ttl });
      else await r.set(key, value as never);
    },
    async del(key) {
      await r.del(key);
    },
    async lpush(key, value) {
      await r.lpush(key, value);
    },
    async lrange(key, a, b) {
      const rows = await r.lrange<string>(key, a, b);
      return rows.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    },
    async ltrim(key, keep) {
      await r.ltrim(key, 0, keep - 1);
    },
    async lrem(key, value) {
      await r.lrem(key, 0, value);
    },
    async hset(key, field, value) {
      await r.hset(key, { [field]: value });
    },
    async hgetall<T>(key: string) {
      return ((await r.hgetall<Record<string, T>>(key)) ?? {}) as Record<string, T>;
    },
    async hdel(key, field) {
      await r.hdel(key, field);
    },
    async sadd(key, m) {
      return await r.sadd(key, m);
    },
    async smembers(key) {
      return await r.smembers(key);
    },
    async srem(key, m) {
      await r.srem(key, m);
    },
    async incrby(key, n) {
      return await r.incrby(key, n);
    },
    async lock(key, ttl) {
      return (await r.set(key, "1", { nx: true, ex: ttl })) === "OK";
    },
    async unlock(key) {
      await r.del(key);
    },
  };
}

const mem = globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>>; hashes?: Map<string, Map<string, unknown>>; exp?: Map<string, number> } };
function memory(): Store {
  if (!mem.__nashrMem) mem.__nashrMem = { kv: new Map(), lists: new Map(), sets: new Map(), hashes: new Map() };
  const m = mem.__nashrMem;
  const hashes = (m.hashes ??= new Map<string, Map<string, unknown>>());
  // Expiry is honoured like Redis, so sessions, reset tokens and rate windows behave the same locally and in tests.
  const exp = (m.exp ??= new Map<string, number>());
  const live = (key: string) => { const at = exp.get(key); if (at !== undefined && at <= Date.now()) { exp.delete(key); m.kv.delete(key); } };
  return {
    async get<T>(key: string) {
      live(key);
      return (m.kv.get(key) as T) ?? null;
    },
    async set(key, value, ttl) {
      m.kv.set(key, value);
      if (ttl) exp.set(key, Date.now() + ttl * 1000);
      else exp.delete(key);
    },
    async del(key) {
      m.kv.delete(key);
      exp.delete(key);
      m.lists.delete(key);
      m.sets.delete(key);
      hashes.delete(key);
    },
    async lpush(key, value) {
      const l = m.lists.get(key) ?? [];
      l.unshift(value);
      m.lists.set(key, l);
    },
    async lrange(key, a, b) {
      const l = m.lists.get(key) ?? [];
      return l.slice(a, b === -1 ? undefined : b + 1);
    },
    async ltrim(key, keep) {
      const l = m.lists.get(key);
      if (l && l.length > keep) l.length = keep;
    },
    async lrem(key, value) {
      const l = m.lists.get(key);
      if (l) m.lists.set(key, l.filter((x) => x !== value));
    },
    async hset(key, field, value) {
      const h = hashes.get(key) ?? new Map<string, unknown>();
      h.set(field, structuredClone(value));
      hashes.set(key, h);
    },
    async hgetall<T>(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []) as Record<string, T>;
    },
    async hdel(key, field) {
      hashes.get(key)?.delete(field);
    },
    async sadd(key, member) {
      const s = m.sets.get(key) ?? new Set<string>();
      const isNew = s.has(member) ? 0 : 1;
      s.add(member);
      m.sets.set(key, s);
      return isNew;
    },
    async smembers(key) {
      return [...(m.sets.get(key) ?? [])];
    },
    async srem(key, member) {
      m.sets.get(key)?.delete(member);
    },
    async incrby(key, n) {
      live(key);
      const v = ((m.kv.get(key) as number) ?? 0) + n;
      m.kv.set(key, v);
      return v;
    },
    async lock(key, ttl) {
      const until = m.kv.get(key) as number | undefined;
      if (until && until > Date.now()) return false;
      m.kv.set(key, Date.now() + ttl * 1000);
      return true;
    },
    async unlock(key) {
      m.kv.delete(key);
    },
  };
}

export const db: Store = upstash() ?? memory();
export const usingPersistentStore = upstash() !== null;

/**
 * lpush for lists that only ever grow (chat threads, logs, tickets): keeps the newest `cap` entries. Both commands go out
 * together, so the list may hold cap + 1 for a moment, which is harmless.
 */
export async function pushCapped(key: string, value: string, cap: number) {
  await Promise.all([db.lpush(key, value), db.ltrim(key, cap)]);
}
/** Caps for the lists above. Reads never look past these, so trimming loses nothing a page shows. */
export const CAPS = { chat: 400, adminLog: 2000, tickets: 2000, feedback: 500, prefs: 100 } as const;
