import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";
import { personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "./keys";

/**
 * Private calendar feed (Reem phase 3 B1), per (person, account) from multi-workspace M1 (rules 2119, 2131, 2132). The
 * link carries a random token; only its SHA-256 is stored, so a store dump never yields a working link. One live link per
 * person per account: `sec:feedof:{pid}:{aid}` (`personKey.feedOf`) names the current hash, and renewing deletes the old
 * record. Imports only ./db, ./parallel, ./keys and node:crypto, so team.ts and account.ts can revoke.
 *
 * From M4 (contract, rule 2138) the legacy per-login pointer `sec:feedof:{login}` is never read or written: M1 to M3 wrote
 * it beside the new one for the person's home account and kept links made before M1 (records without `pid`) alive
 * through it. Such a record is dead now (`linkIds`); Script S2 counts them before the release (`preM1Links`). A record
 * M1 to M3 made with `home: true` stays live while its `(pid, aid)` pointer names it.
 *
 * Locks (rule 2139): `lock:feed:{pid}:{aid}` (`personKey.feedLock`) is a LEAF lock: it may be taken while any lock of the
 * order (inviteuse, team, login, person, member, user) is held, and nothing is taken while it is held.
 */

/** 32 random bytes in base64url: exactly 43 characters, no padding. */
export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const FEED_KEYS = {
  rec: (hash: string) => `sec:feed:${hash}`,
  /** LEGACY per-login pointer: never read or written by the app from M4; Script S2 reads it to count pre-M1 links. */
  of: (login: string) => `sec:feedof:${login}`,
};

/**
 * A link's record. `pid` and `aid` were an expand (rule 679), written from M1; from M4 a record without them is dead.
 * `login` is still written (the rate bucket's name, and an M3 build after a rollback reads it). `home` was written by M1
 * to M3 only and is ignored from M4.
 */
export type FeedRecord = { login: string; scope: string; lang: "ar" | "en"; createdAt: string; pid?: string; aid?: string; home?: true };

/**
 * Whom a link belongs to: the acting person and the ACTIVE account, both from the session (`linkOwner`,
 * src/lib/secretary-feed.ts). `login` is the acting address, written on the record only.
 */
export type LinkOwner = { pid: PersonId; aid: AccountId; login: string };
/** Which link a revoke ends: the (person, account) pair, from the session or from a record this app wrote. */
export type LinkIds = { pid: PersonId; aid: AccountId };

export const hashFeedToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_TTL = 10;

/**
 * The (person, account) a stored link record names, or null when it names none (a record made before M1, one id without
 * the other, or not strings): such a record is dead (rule 2138). The ids come from our own record, never from a request
 * (rule 2137).
 */
export function linkIds(rec: { pid?: unknown; aid?: unknown }): LinkIds | null {
  if (typeof rec.pid !== "string" || !rec.pid || typeof rec.aid !== "string" || !rec.aid) return null;
  return { pid: storedPersonId(rec.pid), aid: storedAccountId(rec.aid) };
}

/** Whether the record stored under `hash` is the live link: it names its ids and their pointer `mine` names it. */
export function linkLive(hash: string, rec: { pid?: unknown; aid?: unknown }, mine: unknown): boolean {
  return linkIds(rec) !== null && mine === hash;
}

/**
 * The (person, account) pairs a person's links can live under: every `orgs:{pid}` entry (a hint, rule 2136; revoking
 * under a stale entry deletes nothing that is not this person's). For the revokes that end a person's links everywhere:
 * a password reset, the account deletion.
 */
export async function linksOfPerson(pid: PersonId): Promise<LinkIds[]> {
  const entries = await db.smembers(personKey.orgs(pid));
  return entries.map((aid) => linkIds({ pid, aid })).filter((x): x is LinkIds => x !== null);
}

/**
 * Mint a new link, replacing any previous one. Returns the plain token (shown once, never stored), or "busy" when another
 * create or revoke of the same link holds the lock. Under `lock:feed:{pid}:{aid}`: writes the record (with `pid` and
 * `aid`), then `sec:feedof:{pid}:{aid}`, then deletes the record the old pointer named.
 */
export async function createFeed(who: LinkOwner, scope: string, lang: "ar" | "en"): Promise<string | "busy"> {
  const lock = personKey.feedLock(who.pid, who.aid);
  const owner = await db.lockOwned(lock, LOCK_TTL);
  if (!owner) return "busy";
  try {
    const token = randomBytes(32).toString("base64url");
    const hash = hashFeedToken(token);
    const ptrKey = personKey.feedOf(who.pid, who.aid);
    const old = await db.get<string>(ptrKey);
    const rec: FeedRecord = { login: who.login, scope, lang, createdAt: new Date().toISOString(), pid: who.pid, aid: who.aid };
    await db.set(FEED_KEYS.rec(hash), rec);
    await db.set(ptrKey, hash);
    if (old && old !== hash) await db.del(FEED_KEYS.rec(old));
    return token;
  } finally {
    await db.unlockOwned(lock, owner).catch(() => {});
  }
}

/**
 * The record behind a link, or null. A token of the wrong shape is refused before any store read. Then the record and
 * the pointer that can name it (`linkLive`): a record no pointer names is dead, so a revoke that gave up waiting for the
 * lock and raced a create still running never leaves the record that create wrote alive.
 */
export async function resolveFeed(token: string): Promise<{ hash: string; rec: FeedRecord } | null> {
  if (typeof token !== "string" || !FEED_TOKEN.test(token)) return null;
  const hash = hashFeedToken(token);
  const rec = await db.get<FeedRecord>(FEED_KEYS.rec(hash));
  if (!rec || typeof rec.login !== "string") return null;
  const ids = linkIds(rec);
  if (ids === null) return null;
  const mine = await db.get<string>(personKey.feedOf(ids.pid, ids.aid));
  return linkLive(hash, rec, mine) ? { hash, rec } : null;
}

/**
 * Whether there is a live link, and when it was made. Never returns the token or its hash. With `scope` (the caller's
 * own `sc(u)`), the answer also says whether the link was made in that brand (`sameBrand`; true when there is no link):
 * the record's own scope is compared here and never returned. Two rounds: the pointer, then its record.
 */
export async function getFeedStatus(who: LinkIds, scope?: string): Promise<{ exists: boolean; createdAt: string | null; sameBrand?: boolean }> {
  const hash = await db.get<string>(personKey.feedOf(who.pid, who.aid));
  const found = hash ? await db.get<FeedRecord>(FEED_KEYS.rec(hash)) : null;
  const ids = found ? linkIds(found) : null;
  // The pointer names it, so it is live when it names this person and account (`linkLive`).
  const rec = found && ids && ids.pid === who.pid && ids.aid === who.aid ? found : null;
  const base = rec ? { exists: true, createdAt: rec.createdAt } : { exists: false, createdAt: null };
  return scope === undefined ? base : { ...base, sameBrand: !rec || rec.scope === scope };
}

/**
 * Kill the link. Idempotent. Waits for the lock up to 20 tries 50 ms apart, then revokes anyway: a held lock never keeps
 * a link alive (B1-R10). Deletes `sec:feedof:{pid}:{aid}` and the record it names.
 */
export async function revokeFeed(who: LinkIds): Promise<void> {
  const lock = personKey.feedLock(who.pid, who.aid);
  let owner: string | null = null;
  try {
    // Sequential by design: each try only makes sense after the last one failed.
    for (let i = 0; i < 20 && !owner; i++) {
      owner = await db.lockOwned(lock, LOCK_TTL);
      if (!owner) await sleep(50);
    }
    const ptrKey = personKey.feedOf(who.pid, who.aid);
    const mine = await db.get<string>(ptrKey);
    await Promise.all([...(typeof mine === "string" && mine ? [db.del(FEED_KEYS.rec(mine))] : []), db.del(ptrKey)]);
  } finally {
    if (owner) await db.unlockOwned(lock, owner).catch(() => {});
  }
}

export const revokeFeeds = (whos: LinkIds[]) => pmap(whos, revokeFeed);
