import { randomBytes } from "crypto";
import { Redis } from "@upstash/redis";

/**
 * Storage adapter. Upstash Redis in production; in-memory Map when no
 * credentials are present (local dev, tests, CI only — data is lost on restart).
 * A production deployment without credentials refuses every call instead (`pickStore`).
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
  /** One membership test: a single command, where `smembers` would fetch the whole set. */
  sismember(key: string, member: string): Promise<boolean>;
  srem(key: string, member: string): Promise<void>;
  /** Sizes of many sets in ONE request (an Upstash pipeline), in the order of `keys`. For counters shown in a list. */
  scardMany(keys: string[]): Promise<number[]>;
  /** Many JSON values in ONE request (MGET), in the order of `keys`; null where a key is missing. Empty `keys` sends nothing. */
  mget<T = unknown>(keys: string[]): Promise<(T | null)[]>;
  /**
   * Sorted sets: add or re-score one member, remove one, count, and read the whole set ordered by score (then member).
   * `zadd` with `{ lt: true }` (ZADD LT) adds a new member, and re-scores an existing one only to a LOWER score.
   */
  zadd(key: string, score: number, member: string, opts?: { lt?: boolean }): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  zcard(key: string): Promise<number>;
  /** ZSCORE: the member's score, or null when it is not in the set. */
  zscore(key: string, member: string): Promise<number | null>;
  zrangeWithScores(key: string): Promise<{ member: string; score: number }[]>;
  /** Members with a score <= `max`, lowest score first (then member), at most `limit` (ZRANGE BYSCORE LIMIT). */
  zrangeByScore(key: string, max: number, limit: number): Promise<{ member: string; score: number }[]>;
  incrby(key: string, n: number): Promise<number>;
  /** TTL in whole seconds, as Redis answers it: -1 when the key has no expiry, -2 when it does not exist. */
  ttl(key: string): Promise<number>;
  /** EXPIRE NX: give a key a TTL only when it has none. Never touches the value or an expiry already set. */
  expireNx(key: string, ttlSeconds: number): Promise<void>;
  /** SET NX with TTL. True when this caller won the lock. */
  lock(key: string, ttlSeconds: number): Promise<boolean>;
  /**
   * SET key value NX EX ttl: stores the value only when the key is absent, in one command. True when this caller wrote
   * it, so of two overlapping writers exactly one wins (a "seen" marker claimed, not read then written).
   */
  setNx(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  /**
   * SET key value XX EX ttl: overwrites the value only while the key exists, in one command. True when it wrote. A writer
   * that read a record before someone deleted it cannot bring the record back (a handoff pushed off its capped index).
   */
  setXx(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  unlock(key: string): Promise<void>;
  /**
   * SET NX with TTL and an owner token: the token when this caller won the lock, null when someone holds it. Release it
   * with `unlockOwned`, which deletes the key only while it still holds this token, so a run whose lock expired can never
   * free the lock of the run that took it next (plain `unlock` deletes whatever is there).
   */
  lockOwned(key: string, ttlSeconds: number): Promise<string | null>;
  unlockOwned(key: string, token: string): Promise<void>;
  /**
   * GETDEL: read a value and delete it in one command, so of two overlapping readers exactly one gets it (a single-use
   * code or refresh token taken, not read then deleted). Null when the key is absent.
   */
  getdel<T = unknown>(key: string): Promise<T | null>;
  /** RENAME in one command, keeping the value and its TTL. False when `from` does not exist (someone deleted it first). */
  rename(from: string, to: string): Promise<boolean>;
  /** Compare-and-set for a string value, keeping its TTL: writes `next` only while the key still holds `expected`. */
  replaceIf(key: string, expected: string, next: string): Promise<boolean>;
};

/** A lock owner's token. Never valid JSON (the Upstash client parses what it reads back), never guessable. */
const lockToken = () => `lk_${randomBytes(12).toString("hex")}`;
/** Compare-and-delete in one step on the server: GET then DEL from here could delete a lock someone took in between. */
const UNLOCK_OWNED = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
/** Compare-and-set on the server, keeping the TTL. */
const REPLACE_IF = `if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[1], ARGV[2], "KEEPTTL") return 1 end return 0`;

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
    async sismember(key, m) {
      return (await r.sismember(key, m)) === 1;
    },
    async srem(key, m) {
      await r.srem(key, m);
    },
    async scardMany(keys) {
      if (!keys.length) return [];
      const p = r.pipeline();
      for (const k of keys) p.scard(k); // queued, not sent: exec() sends every command in one HTTP request
      return (await p.exec()).map((n) => Number(n) || 0);
    },
    async mget<T>(keys: string[]) {
      if (!keys.length) return [];
      return ((await r.mget<(T | null)[]>(...keys)) ?? []).map((v) => v ?? null);
    },
    async zadd(key, score, member, opts) {
      if (opts?.lt) await r.zadd(key, { lt: true }, { score, member });
      else await r.zadd(key, { score, member });
    },
    async zrem(key, member) {
      await r.zrem(key, member);
    },
    async zcard(key) {
      return await r.zcard(key);
    },
    async zscore(key, member) {
      const v = await r.zscore(key, member);
      return v === null || v === undefined ? null : Number(v);
    },
    async zrangeWithScores(key) {
      // [member, score, member, score, ...]. Members are stringified: the client parses anything that looks like JSON.
      const flat = await r.zrange<(string | number)[]>(key, 0, -1, { withScores: true });
      const out: { member: string; score: number }[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
      return out;
    },
    async zrangeByScore(key, max, limit) {
      if (limit <= 0) return [];
      const flat = await r.zrange<(string | number)[]>(key, "-inf", Number.isFinite(max) ? max : "+inf", { byScore: true, offset: 0, count: limit, withScores: true });
      const out: { member: string; score: number }[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
      return out;
    },
    async incrby(key, n) {
      return await r.incrby(key, n);
    },
    async ttl(key) {
      return await r.ttl(key);
    },
    async expireNx(key, ttl) {
      await r.expire(key, ttl, "NX");
    },
    async lock(key, ttl) {
      return (await r.set(key, "1", { nx: true, ex: ttl })) === "OK";
    },
    async setNx(key, value, ttl) {
      return (await r.set(key, value, { nx: true, ex: ttl })) === "OK";
    },
    async setXx(key, value, ttl) {
      return (await r.set(key, value, { xx: true, ex: ttl })) === "OK";
    },
    async unlock(key) {
      await r.del(key);
    },
    async lockOwned(key, ttl) {
      const token = lockToken();
      return (await r.set(key, token, { nx: true, ex: ttl })) === "OK" ? token : null;
    },
    async unlockOwned(key, token) {
      await r.eval(UNLOCK_OWNED, [key], [token]);
    },
    async getdel<T>(key: string) {
      return ((await r.getdel<T>(key)) ?? null) as T | null;
    },
    async rename(from, to) {
      try {
        await r.rename(from, to);
        return true;
      } catch (e) {
        if (/no such key/i.test(String((e as Error)?.message ?? e))) return false;
        throw e;
      }
    },
    async replaceIf(key, expected, next) {
      return Number(await r.eval(REPLACE_IF, [key], [expected, next])) === 1;
    },
  };
}

const mem = globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>>; hashes?: Map<string, Map<string, unknown>>; exp?: Map<string, number>; owners?: Map<string, string>; zsets?: Map<string, Map<string, number>> } };
function memory(): Store {
  if (!mem.__nashrMem) mem.__nashrMem = { kv: new Map(), lists: new Map(), sets: new Map(), hashes: new Map() };
  const m = mem.__nashrMem;
  const hashes = (m.hashes ??= new Map<string, Map<string, unknown>>());
  const zsets = (m.zsets ??= new Map<string, Map<string, number>>());
  // Expiry is honoured like Redis, so sessions, reset tokens and rate windows behave the same locally and in tests.
  const exp = (m.exp ??= new Map<string, number>());
  // Who holds each owned lock (`lockOwned`). Any other write to the key forgets its owner.
  const owners = (m.owners ??= new Map<string, string>());
  const live = (key: string) => { const at = exp.get(key); if (at !== undefined && at <= Date.now()) { exp.delete(key); m.kv.delete(key); } };
  /**
   * Copy on the way in and on the way out, because Upstash does.
   *
   * Over HTTP a value is serialised on write and parsed on read, so a caller can never hold a reference to what the
   * database holds. This store used to hand out the live object: `const u = await db.get(...); u.credits -= 10;`
   * silently updated the store even when the code forgot to save. That bug passes every test and loses the write in
   * production — the worst possible direction for a divergence to run. `hset` already cloned; `set` and `get` did not.
   */
  const copy = <T>(v: T): T => (v === null || typeof v !== "object" ? v : structuredClone(v));
  return {
    async get<T>(key: string) {
      live(key);
      const v = m.kv.get(key);
      return v === undefined ? null : copy(v as T);
    },
    async set(key, value, ttl) {
      m.kv.set(key, copy(value));
      owners.delete(key);
      if (ttl) exp.set(key, Date.now() + ttl * 1000);
      else exp.delete(key);
    },
    async del(key) {
      m.kv.delete(key);
      exp.delete(key);
      owners.delete(key);
      m.lists.delete(key);
      m.sets.delete(key);
      hashes.delete(key);
      zsets.delete(key);
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
      return copy(Object.fromEntries(hashes.get(key) ?? [])) as Record<string, T>;
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
    async sismember(key, member) {
      return m.sets.get(key)?.has(member) ?? false;
    },
    async srem(key, member) {
      m.sets.get(key)?.delete(member);
    },
    async scardMany(keys) {
      return keys.map((k) => m.sets.get(k)?.size ?? 0);
    },
    async mget<T>(keys: string[]) {
      return keys.map((k) => { live(k); const v = m.kv.get(k); return v === undefined ? null : copy(v as T); });
    },
    async zadd(key, score, member, opts) {
      const z = zsets.get(key) ?? new Map<string, number>();
      // LT: a new member is added; an existing one moves only to a lower score, as Redis does.
      const cur = z.get(member);
      if (!opts?.lt || cur === undefined || score < cur) z.set(member, score);
      zsets.set(key, z);
    },
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
    },
    async zcard(key) {
      return zsets.get(key)?.size ?? 0;
    },
    async zscore(key, member) {
      return zsets.get(key)?.get(member) ?? null;
    },
    async zrangeWithScores(key) {
      // Redis order: by score, then by member (binary), for equal scores.
      return [...(zsets.get(key) ?? new Map<string, number>())].map(([member, score]) => ({ member, score })).sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
    },
    async zrangeByScore(key, max, limit) {
      if (limit <= 0) return [];
      return [...(zsets.get(key) ?? new Map<string, number>())]
        .filter(([, score]) => score <= max)
        .map(([member, score]) => ({ member, score }))
        .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))
        .slice(0, limit);
    },
    async incrby(key, n) {
      live(key);
      const v = ((m.kv.get(key) as number) ?? 0) + n;
      m.kv.set(key, v);
      return v;
    },
    async ttl(key) {
      live(key);
      if (!(m.kv.has(key) || m.lists.has(key) || m.sets.has(key) || hashes.has(key) || zsets.has(key))) return -2;
      const at = exp.get(key);
      return at === undefined ? -1 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
    },
    async expireNx(key, ttl) {
      live(key);
      if (m.kv.has(key) && !exp.has(key)) exp.set(key, Date.now() + ttl * 1000);
    },
    async lock(key, ttl) {
      const until = m.kv.get(key) as number | undefined;
      if (until && until > Date.now()) return false;
      m.kv.set(key, Date.now() + ttl * 1000);
      // The expiry too, so `ttl` answers for a lock as Redis does (SET NX EX).
      exp.set(key, Date.now() + ttl * 1000);
      owners.delete(key);
      return true;
    },
    async setNx(key, value, ttl) {
      // Check and write with no await between them: one caller wins, as with Redis.
      live(key);
      if (m.kv.has(key)) return false;
      m.kv.set(key, copy(value));
      exp.set(key, Date.now() + ttl * 1000);
      return true;
    },
    async setXx(key, value, ttl) {
      // Check and write with no await between them, as with Redis.
      live(key);
      if (!m.kv.has(key)) return false;
      m.kv.set(key, copy(value));
      exp.set(key, Date.now() + ttl * 1000);
      return true;
    },
    async unlock(key) {
      m.kv.delete(key);
      exp.delete(key);
      owners.delete(key);
    },
    async lockOwned(key, ttl) {
      const until = m.kv.get(key) as number | undefined;
      if (until && until > Date.now()) return null;
      const token = lockToken();
      m.kv.set(key, Date.now() + ttl * 1000);
      exp.set(key, Date.now() + ttl * 1000);
      owners.set(key, token);
      return token;
    },
    async unlockOwned(key, token) {
      if (owners.get(key) !== token) return;
      m.kv.delete(key);
      exp.delete(key);
      owners.delete(key);
    },
    async getdel<T>(key: string) {
      // Read and delete with no await between them: one caller gets the value, as with Redis.
      live(key);
      const v = m.kv.get(key);
      if (v === undefined) return null;
      m.kv.delete(key);
      exp.delete(key);
      owners.delete(key);
      return copy(v as T);
    },
    async rename(from, to) {
      live(from);
      if (!m.kv.has(from)) return false;
      const at = exp.get(from);
      m.kv.set(to, m.kv.get(from));
      if (at !== undefined) exp.set(to, at);
      else exp.delete(to);
      owners.delete(to);
      m.kv.delete(from);
      exp.delete(from);
      owners.delete(from);
      return true;
    },
    async replaceIf(key, expected, next) {
      live(key);
      if (m.kv.get(key) !== expected) return false;
      m.kv.set(key, next);
      owners.delete(key);
      return true;
    },
  };
}

/** Thrown by every store call in a production deployment that has no Redis credentials. */
export class StoreNotConfigured extends Error {
  constructor() {
    super("store_not_configured: KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) are not set in this production deployment");
    this.name = "StoreNotConfigured";
  }
}

/**
 * A store that refuses every call. Used instead of the memory store in a production deployment without Redis
 * credentials: signups, credits and tasks would otherwise appear to save and vanish at the next cold start, differently
 * on every instance, with nobody told. It throws on first use rather than at import, so `next build` and any module that
 * merely imports `db` keep working; the first request that touches data fails loudly (a 500 and an error in the logs).
 */
function unconfigured(): Store {
  return new Proxy({} as Store, {
    get: (_t, prop) => (prop === "then" ? undefined : () => Promise.reject(new StoreNotConfigured())),
  });
}

/**
 * Upstash when its credentials are set. Without them: the memory store everywhere except a Vercel PRODUCTION deployment
 * (`VERCEL_ENV === "production"`), which gets `unconfigured()`. Local dev, vitest, CI and the e2e suite run with no
 * `VERCEL_ENV` and keep the memory store. Rule 430, tests/launch-security.test.ts.
 */
function pickStore(): Store {
  const u = upstash();
  if (u) return u;
  if (process.env.VERCEL_ENV === "production") {
    console.error("store_not_configured: Redis credentials are missing in production; every data call will fail");
    return unconfigured();
  }
  return memory();
}

export const db: Store = pickStore();
export const usingPersistentStore = upstash() !== null;

/**
 * lpush for lists that only ever grow (chat threads, logs, tickets): keeps the newest `cap` entries. Both commands go out
 * together, so the list may hold cap + 1 for a moment, which is harmless.
 */
export async function pushCapped(key: string, value: string, cap: number) {
  await Promise.all([db.lpush(key, value), db.ltrim(key, cap)]);
}
/** Caps for the lists above. Reads never look past these, so trimming loses nothing a page shows. */
export const CAPS = { chat: 400, adminLog: 2000, tickets: 2000, feedback: 500, prefs: 100, decisions: 500, wishSuggestions: 500, govHistory: 100, activity: 2000, secDone: 200, secAudit: 500, handoffs: 200 } as const;
