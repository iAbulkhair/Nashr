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
  sadd(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  incrby(key: string, n: number): Promise<number>;
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
    async sadd(key, m) {
      return await r.sadd(key, m);
    },
    async smembers(key) {
      return await r.smembers(key);
    },
    async incrby(key, n) {
      return await r.incrby(key, n);
    },
  };
}

const mem = globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>> } };
function memory(): Store {
  if (!mem.__nashrMem) mem.__nashrMem = { kv: new Map(), lists: new Map(), sets: new Map() };
  const m = mem.__nashrMem;
  return {
    async get<T>(key: string) {
      return (m.kv.get(key) as T) ?? null;
    },
    async set(key, value) {
      m.kv.set(key, value);
    },
    async del(key) {
      m.kv.delete(key);
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
    async incrby(key, n) {
      const v = ((m.kv.get(key) as number) ?? 0) + n;
      m.kv.set(key, v);
      return v;
    },
  };
}

export const db: Store = upstash() ?? memory();
export const usingPersistentStore = upstash() !== null;
