import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";
import { personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "./keys";

/**
 * Private calendar feed (Reem phase 3 B1), per (person, account) from multi-workspace M1 (rules 2119, 2131, 2132). The
 * link carries a random token; only its SHA-256 is stored, so a store dump never yields a working link. One live link per
 * person per account: `sec:feedof:{pid}:{aid}` (`personKey.feedOf`) names the current hash, and renewing deletes the old
 * record. For the person's HOME account (a legacy owner's own account, a legacy member's `memberOf`) the legacy per-login
 * pointer `sec:feedof:{login}` is written beside it, so a build rolled back to R1 still resolves and revokes the link, and
 * a link made before M1 (a record with no `pid`, named by the legacy pointer only) keeps working for the home account.
 * Imports only ./db, ./parallel, ./keys and node:crypto, so team.ts and account.ts can revoke.
 *
 * Locks (rule 2139): `lock:feed:{pid}:{aid}` (`personKey.feedLock`) and the legacy `lock:feed:{login}` are LEAF locks:
 * they may be taken while any lock of the order (inviteuse, team, login, person, member, user) is held, and nothing is
 * taken while they are held, except that a home link takes the new one first and the legacy one inside it.
 *
 * Every function also takes a plain login (`string`): the pre-M1 form, exactly as before (a record without `pid`, the
 * legacy pointer only), kept for the callers that still revoke by address (password reset, console suspension, account
 * deletion) and for the tests that pin R1's behaviour. Revoking by address also drops the `(pid, aid)` pointer of the
 * home record it names (while that pointer still names it), so it still ends the home link whole.
 */

/** 32 random bytes in base64url: exactly 43 characters, no padding. */
export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const FEED_KEYS = {
  rec: (hash: string) => `sec:feed:${hash}`,
  of: (login: string) => `sec:feedof:${login}`,
};

/**
 * A link's record. `pid`, `aid` and `home` are an expand (rule 679): written from M1, absent on a record made before it;
 * an older build ignores them. `login` is still written (the legacy pointer's key, and the rate bucket's name).
 */
export type FeedRecord = { login: string; scope: string; lang: "ar" | "en"; createdAt: string; pid?: string; aid?: string; home?: true };

/**
 * Whom a link belongs to: the acting person and the ACTIVE account, both from the session (`linkOwner`,
 * src/lib/secretary-feed.ts), or from a record this app wrote (`deleteMembership`). `login` is the acting address, used
 * only for the legacy pointer and lock when `home`.
 */
export type LinkOwner = { pid: PersonId; aid: AccountId; login: string; home: boolean };

export const hashFeedToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const lockKey = (login: string) => `lock:feed:${login}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_TTL = 10;

/**
 * The (person, account) a stored link record names: its ids for a record M1 wrote, "legacy" for a record made before M1
 * (neither field), and null for anything else (one without the other, or not strings): such a record is dead. The ids
 * come from our own record, never from a request (rule 2137).
 */
export function linkIds(rec: { pid?: unknown; aid?: unknown }): { pid: PersonId; aid: AccountId } | "legacy" | null {
  if (rec.pid === undefined && rec.aid === undefined) return "legacy";
  if (typeof rec.pid !== "string" || !rec.pid || typeof rec.aid !== "string" || !rec.aid) return null;
  return { pid: storedPersonId(rec.pid), aid: storedAccountId(rec.aid) };
}

/**
 * Whether the record stored under `hash` is the live link, given the pointers read for it: `mine` (the `(pid, aid)`
 * pointer) and `legacy` (the per-login one). A record made before M1 is live while the legacy pointer names it (as in
 * R1). A record M1 wrote is live while its `(pid, aid)` pointer names it and, for a home link, the legacy pointer too: a
 * revoke by address (the password reset, the console, an R1 build) that drops only the legacy pointer, even one that gave
 * up waiting for the lock while a create was still running, ends the home link. A malformed record is never live.
 */
export function linkLive(hash: string, rec: { pid?: unknown; aid?: unknown; home?: unknown }, ptr: { mine: unknown; legacy: unknown }): boolean {
  const ids = linkIds(rec);
  if (ids === null) return false;
  if (ids === "legacy") return ptr.legacy === hash;
  return ptr.mine === hash && (rec.home !== true || ptr.legacy === hash);
}

/** The record belongs to `who`: M1's record names the same person and account; a pre-M1 one counts for the home only. */
const belongsTo = (rec: FeedRecord, who: LinkOwner): boolean => {
  const ids = linkIds(rec);
  return ids === "legacy" ? who.home : ids !== null && ids.pid === who.pid && ids.aid === who.aid;
};

const distinct = (hashes: unknown[]): string[] => [...new Set(hashes.filter((h): h is string => typeof h === "string" && !!h))];

/**
 * Mint a new link, replacing any previous one. Returns the plain token (shown once, never stored), or "busy" when another
 * create or revoke of the same link holds a lock. `who` from M1: under `lock:feed:{pid}:{aid}`, and for the home account
 * also `lock:feed:{login}` inside it; writes the record (with `pid`, `aid`, and `home` for the home account), then
 * `sec:feedof:{pid}:{aid}` and for the home account `sec:feedof:{login}`, then deletes the records the old pointers
 * named (for the home account that includes a link made before M1). A plain login: the pre-M1 form.
 */
export async function createFeed(who: LinkOwner | string, scope: string, lang: "ar" | "en"): Promise<string | "busy"> {
  if (typeof who === "string") return createByLogin(who, scope, lang);
  const mineKey = personKey.feedLock(who.pid, who.aid);
  const mine = await db.lockOwned(mineKey, LOCK_TTL);
  if (!mine) return "busy";
  try {
    const legacy = who.home ? await db.lockOwned(lockKey(who.login), LOCK_TTL) : null;
    if (who.home && !legacy) return "busy";
    try {
      const token = randomBytes(32).toString("base64url");
      const hash = hashFeedToken(token);
      const ptrKey = personKey.feedOf(who.pid, who.aid);
      const [oldMine, oldLegacy] = await Promise.all([db.get<string>(ptrKey), who.home ? db.get<string>(FEED_KEYS.of(who.login)) : null]);
      const rec: FeedRecord = { login: who.login, scope, lang, createdAt: new Date().toISOString(), pid: who.pid, aid: who.aid, ...(who.home ? { home: true as const } : {}) };
      await db.set(FEED_KEYS.rec(hash), rec);
      await Promise.all([db.set(ptrKey, hash), who.home ? db.set(FEED_KEYS.of(who.login), hash) : null]);
      await Promise.all(distinct([oldMine, oldLegacy]).filter((h) => h !== hash).map((h) => db.del(FEED_KEYS.rec(h))));
      return token;
    } finally {
      if (legacy) await db.unlockOwned(lockKey(who.login), legacy).catch(() => {});
    }
  } finally {
    await db.unlockOwned(mineKey, mine).catch(() => {});
  }
}

/** The pre-M1 create, unchanged: one link per login, the record without `pid`, the legacy pointer only. */
async function createByLogin(login: string, scope: string, lang: "ar" | "en"): Promise<string | "busy"> {
  const key = lockKey(login);
  const owner = await db.lockOwned(key, LOCK_TTL);
  if (!owner) return "busy";
  try {
    const token = randomBytes(32).toString("base64url");
    const hash = hashFeedToken(token);
    const old = await db.get<string>(FEED_KEYS.of(login));
    const rec: FeedRecord = { login, scope, lang, createdAt: new Date().toISOString() };
    await db.set(FEED_KEYS.rec(hash), rec);
    await db.set(FEED_KEYS.of(login), hash);
    if (old && old !== hash) await db.del(FEED_KEYS.rec(old));
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
export async function resolveFeed(token: string): Promise<{ hash: string; rec: FeedRecord } | null> {
  if (typeof token !== "string" || !FEED_TOKEN.test(token)) return null;
  const hash = hashFeedToken(token);
  const rec = await db.get<FeedRecord>(FEED_KEYS.rec(hash));
  if (!rec || typeof rec.login !== "string") return null;
  const ids = linkIds(rec);
  if (ids === null) return null;
  const [mine, legacy] = await Promise.all([
    ids === "legacy" ? null : db.get<string>(personKey.feedOf(ids.pid, ids.aid)),
    ids === "legacy" || rec.home === true ? db.get<string>(FEED_KEYS.of(rec.login)) : null,
  ]);
  return linkLive(hash, rec, { mine, legacy }) ? { hash, rec } : null;
}

/**
 * Whether there is a live link, and when it was made. Never returns the token or its hash. With `scope` (the caller's
 * own `sc(u)`), the answer also says whether the link was made in that brand (`sameBrand`; true when there is no link):
 * the record's own scope is compared here and never returned. `who` from M1: the `(pid, aid)` link, else for the home
 * account the link the legacy pointer names (one made before M1). Two rounds: the pointers, then their records (three
 * when a home record is seen by an actor that is not home in it).
 */
export async function getFeedStatus(who: LinkOwner | string, scope?: string): Promise<{ exists: boolean; createdAt: string | null; sameBrand?: boolean }> {
  let rec: FeedRecord | null;
  if (typeof who === "string") {
    const hash = await db.get<string>(FEED_KEYS.of(who));
    rec = hash ? await db.get<FeedRecord>(FEED_KEYS.rec(hash)) : null;
  } else {
    const [mine, legacyOfWho] = await Promise.all([db.get<string>(personKey.feedOf(who.pid, who.aid)), who.home ? db.get<string>(FEED_KEYS.of(who.login)) : null]);
    const hashes = distinct([mine, legacyOfWho]);
    const recs = await Promise.all(hashes.map((h) => db.get<FeedRecord>(FEED_KEYS.rec(h))));
    // A home record seen by an actor that is not home in it (the home flag of this (pid, aid) flipped): read the legacy
    // pointer the record names, as `resolveFeed` does, so status and resolve agree. A third round in that case only.
    const first = recs[0];
    const legacy = !who.home && first?.home === true && typeof first.login === "string" ? await db.get<string>(FEED_KEYS.of(first.login)) : legacyOfWho;
    const at = hashes.findIndex((h, i) => !!recs[i] && belongsTo(recs[i]!, who) && linkLive(h, recs[i]!, { mine, legacy }));
    rec = at < 0 ? null : recs[at];
  }
  const base = rec ? { exists: true, createdAt: rec.createdAt } : { exists: false, createdAt: null };
  return scope === undefined ? base : { ...base, sameBrand: !rec || rec.scope === scope };
}

/**
 * Kill the link. Idempotent. Waits for each lock up to 20 tries 50 ms apart, then revokes anyway: a held lock never keeps
 * a link alive (B1-R10). `who` from M1: `lock:feed:{pid}:{aid}`, then for the home account `lock:feed:{login}`; deletes
 * both pointers and the records they name. A plain login (the pre-M1 form): `lock:feed:{login}`; deletes the legacy
 * pointer, the record it names, and that record's `(pid, aid)` pointer when M1 wrote it (the home link) and it still
 * names that record.
 */
export async function revokeFeed(who: LinkOwner | string): Promise<void> {
  const ids = typeof who === "string" ? null : who;
  const login = typeof who === "string" ? who : who.login;
  const home = typeof who === "string" || who.home;
  const locks = [...(ids ? [personKey.feedLock(ids.pid, ids.aid)] : []), ...(home ? [lockKey(login)] : [])];
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
    const [mine, legacy] = await Promise.all([ids ? db.get<string>(personKey.feedOf(ids.pid, ids.aid)) : null, home ? db.get<string>(FEED_KEYS.of(login)) : null]);
    // By address only: the home record M1 wrote is also named by its (pid, aid) pointer, which goes with it.
    const named = !ids && legacy ? await db.get<FeedRecord>(FEED_KEYS.rec(legacy)) : null;
    const theirs = named ? linkIds(named) : null;
    // That pointer goes only while it still names this record: a newer link of the same person stays (fail closed either
    // way). One more dependent read, on a revoke by address only.
    const theirKey = theirs && theirs !== "legacy" ? personKey.feedOf(theirs.pid, theirs.aid) : null;
    const theirPtr = theirKey ? await db.get<string>(theirKey) : null;
    const pointers = [
      ...(ids ? [personKey.feedOf(ids.pid, ids.aid)] : []),
      ...(home ? [FEED_KEYS.of(login)] : []),
      ...(theirKey && theirPtr === legacy ? [theirKey] : []),
    ];
    await Promise.all([...distinct([mine, legacy]).map((h) => db.del(FEED_KEYS.rec(h))), ...pointers.map((k) => db.del(k))]);
  } finally {
    await Promise.all(held.map(([key, owner]) => db.unlockOwned(key, owner).catch(() => {})));
  }
}

export const revokeFeeds = (logins: string[]) => pmap(logins, revokeFeed);
