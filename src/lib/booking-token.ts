import { createHash, createHmac, randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";
import { personKey } from "./keys";
import { linkIds, linkLive, type LinkOwner } from "./feed-token";

/**
 * Booking link per provider (Reem phase 3 B2a), per (person, account) from multi-workspace M1 (rules 2119, 2131, 2132).
 * The link a booking tool calls carries a random token; only its SHA-256 is stored, so a store dump never yields a
 * working link. One live link per person per account per provider: `sec:bookof:{pid}:{aid}:{provider}`
 * (`personKey.bookOf`) names the current hash, and renewing deletes the old record. For the person's HOME account the
 * legacy per-login pointer `sec:bookof:{login}:{provider}` is written beside it (an R1 build still resolves and revokes
 * the link; a link made before M1, named by that pointer only, keeps working for the home account). The liveness rule is
 * the feed's (`linkLive`, src/lib/feed-token.ts). The webhook signing key is derived from the hash and CONNECT_SECRET
 * (`bookingKey`) and is never stored. Imports only ./db, ./parallel, ./keys, ./feed-token and node:crypto, so team.ts and
 * account.ts can revoke.
 *
 * Locks (rule 2139): `lock:book:{pid}:{aid}:{provider}` (`personKey.bookLock`) and the legacy
 * `lock:book:{login}:{provider}` are LEAF locks, as the feed's: new first, legacy inside it, nothing else while held.
 * Every function also takes a plain login, the pre-M1 form, exactly as before (see src/lib/feed-token.ts).
 */

/** 32 random bytes in base64url: exactly 43 characters, no padding. */
export const BOOK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const BOOK_PROVIDERS = ["calcom", "calendly"] as const;

export const BOOK_KEYS = {
  rec: (hash: string) => `sec:book:${hash}`,
  of: (login: string, provider: string) => `sec:bookof:${login}:${provider}`,
};

/** A link's record. `pid`, `aid` and `home` are an expand (rule 679), as in `FeedRecord`; `login` is still written. */
export type BookRecord = {
  login: string;
  scope: string;
  provider: (typeof BOOK_PROVIDERS)[number];
  lang: "ar" | "en";
  createdAt: string;
  pid?: string;
  aid?: string;
  home?: true;
};

export const hashBookToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Same source and dev fallback as src/lib/connectors/store.ts; production must set its own CONNECT_SECRET. */
function connectSecret(): string {
  const v = process.env.CONNECT_SECRET;
  if (v) return v;
  if (process.env.NODE_ENV === "production") throw new Error("CONNECT_SECRET is not set");
  return process.env.WAITLIST_ADMIN_KEY ?? "dev-only-insecure";
}

/**
 * The key a booking tool signs its webhook with for the link whose token hashes to `hash`: HMAC-SHA256 of
 * `booking:v1:{hash}` under CONNECT_SECRET, hex. Never stored; renewing or revoking the link changes or kills it.
 */
export function bookingKey(hash: string): string {
  return createHmac("sha256", connectSecret()).update(`booking:v1:${hash}`).digest("hex");
}

const lockKey = (login: string, provider: string) => `lock:book:${login}:${provider}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_TTL = 10;
const distinct = (hashes: unknown[]): string[] => [...new Set(hashes.filter((h): h is string => typeof h === "string" && !!h))];

/** The record belongs to `who`: M1's record names the same person and account; a pre-M1 one counts for the home only. */
const belongsTo = (rec: BookRecord, who: LinkOwner): boolean => {
  const ids = linkIds(rec);
  return ids === "legacy" ? who.home : ids !== null && ids.pid === who.pid && ids.aid === who.aid;
};

/**
 * Mint a new link for `provider`, replacing any previous one. Returns the plain token (shown once, never stored), or
 * "busy" when another create or revoke of the same link holds a lock. `who` from M1: the feed's steps (`createFeed`) with
 * the provider in every key. A plain login: the pre-M1 form.
 */
export async function createBook(who: LinkOwner | string, scope: string, provider: BookRecord["provider"], lang: "ar" | "en"): Promise<string | "busy"> {
  if (typeof who === "string") return createByLogin(who, scope, provider, lang);
  const mineKey = personKey.bookLock(who.pid, who.aid, provider);
  const mine = await db.lockOwned(mineKey, LOCK_TTL);
  if (!mine) return "busy";
  try {
    const legacy = who.home ? await db.lockOwned(lockKey(who.login, provider), LOCK_TTL) : null;
    if (who.home && !legacy) return "busy";
    try {
      const token = randomBytes(32).toString("base64url");
      const hash = hashBookToken(token);
      const ptrKey = personKey.bookOf(who.pid, who.aid, provider);
      const [oldMine, oldLegacy] = await Promise.all([db.get<string>(ptrKey), who.home ? db.get<string>(BOOK_KEYS.of(who.login, provider)) : null]);
      const rec: BookRecord = {
        login: who.login,
        scope,
        provider,
        lang,
        createdAt: new Date().toISOString(),
        pid: who.pid,
        aid: who.aid,
        ...(who.home ? { home: true as const } : {}),
      };
      await db.set(BOOK_KEYS.rec(hash), rec);
      await Promise.all([db.set(ptrKey, hash), who.home ? db.set(BOOK_KEYS.of(who.login, provider), hash) : null]);
      await Promise.all(distinct([oldMine, oldLegacy]).filter((h) => h !== hash).map((h) => db.del(BOOK_KEYS.rec(h))));
      return token;
    } finally {
      if (legacy) await db.unlockOwned(lockKey(who.login, provider), legacy).catch(() => {});
    }
  } finally {
    await db.unlockOwned(mineKey, mine).catch(() => {});
  }
}

/** The pre-M1 create, unchanged: one link per login and provider, the record without `pid`, the legacy pointer only. */
async function createByLogin(login: string, scope: string, provider: BookRecord["provider"], lang: "ar" | "en"): Promise<string | "busy"> {
  const key = lockKey(login, provider);
  const owner = await db.lockOwned(key, LOCK_TTL);
  if (!owner) return "busy";
  try {
    const token = randomBytes(32).toString("base64url");
    const hash = hashBookToken(token);
    const old = await db.get<string>(BOOK_KEYS.of(login, provider));
    const rec: BookRecord = { login, scope, provider, lang, createdAt: new Date().toISOString() };
    await db.set(BOOK_KEYS.rec(hash), rec);
    await db.set(BOOK_KEYS.of(login, provider), hash);
    if (old && old !== hash) await db.del(BOOK_KEYS.rec(old));
    return token;
  } finally {
    await db.unlockOwned(key, owner).catch(() => {});
  }
}

/**
 * The record behind a link, or null. A token of the wrong shape is refused before any store read. Then the record, and
 * in ONE round the pointers that can name it (`linkLive`): a record no pointer names is dead, so a revoke that gave up
 * waiting for the lock and raced a create still running never leaves the record that create wrote alive.
 */
export async function resolveBook(token: string): Promise<BookRecord | null> {
  if (typeof token !== "string" || !BOOK_TOKEN.test(token)) return null;
  const hash = hashBookToken(token);
  const rec = await db.get<BookRecord>(BOOK_KEYS.rec(hash));
  if (!rec || typeof rec.login !== "string") return null;
  const ids = linkIds(rec);
  if (ids === null) return null;
  const [mine, legacy] = await Promise.all([
    ids === "legacy" ? null : db.get<string>(personKey.bookOf(ids.pid, ids.aid, rec.provider)),
    ids === "legacy" || rec.home === true ? db.get<string>(BOOK_KEYS.of(rec.login, rec.provider)) : null,
  ]);
  return linkLive(hash, rec, { mine, legacy }) ? rec : null;
}

/**
 * The live links, one per provider, and when each was made. Never returns a token, a hash or a scope. With `scope` (the
 * caller's own `sc(u)`), each row also says whether the link was made in that brand (`sameBrand`): the record's own
 * scope is compared here and never returned. Without it, `sameBrand` is true. `who` from M1: the `(pid, aid)` link of
 * each provider, else for the home account the link the legacy pointer names. Two rounds: every pointer, then every record
 * (three when a home record is seen by an actor that is not home in it).
 */
export async function getBookStatus(who: LinkOwner | string, scope?: string): Promise<{ provider: BookRecord["provider"]; createdAt: string; sameBrand: boolean }[]> {
  const row = (provider: BookRecord["provider"], rec: BookRecord | null) => (rec ? { provider, createdAt: rec.createdAt, sameBrand: scope === undefined || rec.scope === scope } : null);
  if (typeof who === "string") {
    const rows = await Promise.all(
      BOOK_PROVIDERS.map(async (provider) => {
        const hash = await db.get<string>(BOOK_KEYS.of(who, provider));
        return row(provider, hash ? await db.get<BookRecord>(BOOK_KEYS.rec(hash)) : null);
      }),
    );
    return rows.filter((r) => r !== null);
  }
  const ptrs = await Promise.all(
    BOOK_PROVIDERS.map((p) => Promise.all([db.get<string>(personKey.bookOf(who.pid, who.aid, p)), who.home ? db.get<string>(BOOK_KEYS.of(who.login, p)) : null])),
  );
  const hashes = distinct(ptrs.flat());
  const recs = await Promise.all(hashes.map((h) => db.get<BookRecord>(BOOK_KEYS.rec(h))));
  const byHash = new Map(hashes.map((h, i) => [h, recs[i]] as const));
  // A home record seen by an actor that is not home in it: read the legacy pointers those records name, as
  // `resolveBook` does, so status and resolve agree (one more round, in that case only).
  const homeOf = (i: number) => (who.home ? null : (byHash.get(ptrs[i][0] ?? "") ?? null));
  const flipped = BOOK_PROVIDERS.some((_, i) => homeOf(i)?.home === true);
  const legacies = flipped
    ? await Promise.all(BOOK_PROVIDERS.map((p, i) => { const r = homeOf(i); return r?.home === true && typeof r.login === "string" ? db.get<string>(BOOK_KEYS.of(r.login, p)) : Promise.resolve(null); }))
    : ptrs.map(([, l]) => l);
  const rows = BOOK_PROVIDERS.map((provider, i) => {
    const [mine] = ptrs[i];
    const legacy = legacies[i];
    const live = distinct([mine, legacy])
      .map((h) => [h, byHash.get(h) ?? null] as const)
      .find(([h, rec]) => !!rec && rec.provider === provider && belongsTo(rec, who) && linkLive(h, rec, { mine, legacy }));
    return row(provider, live ? live[1] : null);
  });
  return rows.filter((r) => r !== null);
}

/**
 * Kill one provider's link. Waits for each lock up to 20 tries 50 ms apart, then revokes anyway. `who` from M1: the new
 * lock, then for the home account the legacy one; both pointers and the records they name. A plain login: the legacy
 * lock, pointer and record, and that record's `(pid, aid)` pointer when M1 wrote it (the home link) and it still names it.
 */
async function revokeOne(who: LinkOwner | string, provider: BookRecord["provider"]): Promise<void> {
  const ids = typeof who === "string" ? null : who;
  const login = typeof who === "string" ? who : who.login;
  const home = typeof who === "string" || who.home;
  const locks = [...(ids ? [personKey.bookLock(ids.pid, ids.aid, provider)] : []), ...(home ? [lockKey(login, provider)] : [])];
  const held: [string, string][] = [];
  try {
    // New before legacy (rule 2139). Sequential by design: each try only makes sense after the last one failed.
    for (const key of locks) {
      let owner: string | null = null;
      for (let i = 0; i < 20 && !owner; i++) {
        owner = await db.lockOwned(key, LOCK_TTL);
        if (!owner) await sleep(50);
      }
      if (owner) held.push([key, owner]);
    }
    const [mine, legacy] = await Promise.all([ids ? db.get<string>(personKey.bookOf(ids.pid, ids.aid, provider)) : null, home ? db.get<string>(BOOK_KEYS.of(login, provider)) : null]);
    const named = !ids && legacy ? await db.get<BookRecord>(BOOK_KEYS.rec(legacy)) : null;
    const theirs = named ? linkIds(named) : null;
    // Only while it still names this record (as `revokeFeed`): a newer link of the same person stays.
    const theirKey = theirs && theirs !== "legacy" ? personKey.bookOf(theirs.pid, theirs.aid, provider) : null;
    const theirPtr = theirKey ? await db.get<string>(theirKey) : null;
    const pointers = [
      ...(ids ? [personKey.bookOf(ids.pid, ids.aid, provider)] : []),
      ...(home ? [BOOK_KEYS.of(login, provider)] : []),
      ...(theirKey && theirPtr === legacy ? [theirKey] : []),
    ];
    await Promise.all([...distinct([mine, legacy]).map((h) => db.del(BOOK_KEYS.rec(h))), ...pointers.map((k) => db.del(k))]);
  } finally {
    await Promise.all(held.map(([key, owner]) => db.unlockOwned(key, owner).catch(() => {})));
  }
}

/**
 * Kill the link for `provider`, or for every provider without one. Idempotent. A held lock never keeps a link alive: the
 * lock wait gives up and the revoke goes ahead (as `revokeFeed`, B1-R10).
 */
export async function revokeBook(who: LinkOwner | string, provider?: BookRecord["provider"]): Promise<void> {
  await pmap(provider ? [provider] : [...BOOK_PROVIDERS], (p) => revokeOne(who, p));
}

export const revokeBooks = (logins: string[]) => pmap(logins, (l) => revokeBook(l)).then(() => {});
