import { createHash, createHmac, randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";
import { personKey } from "./keys";
import { linkIds, linkLive, type LinkIds, type LinkOwner } from "./feed-token";

/**
 * Booking link per provider (Reem phase 3 B2a), per (person, account) from multi-workspace M1 (rules 2119, 2131, 2132).
 * The link a booking tool calls carries a random token; only its SHA-256 is stored, so a store dump never yields a
 * working link. One live link per person per account per provider: `sec:bookof:{pid}:{aid}:{provider}`
 * (`personKey.bookOf`) names the current hash, and renewing deletes the old record. The liveness rule is the feed's
 * (`linkLive`, src/lib/feed-token.ts). From M4 (rule 2138) the legacy per-login pointer `sec:bookof:{login}:{provider}`
 * is never read or written, and a record made before M1 (no `pid`) is dead. The webhook signing key is derived from the
 * hash and CONNECT_SECRET (`bookingKey`) and is never stored. Imports only ./db, ./parallel, ./keys, ./feed-token and
 * node:crypto, so team.ts and account.ts can revoke.
 *
 * Locks (rule 2139): `lock:book:{pid}:{aid}:{provider}` (`personKey.bookLock`) is a LEAF lock, as the feed's.
 */

/** 32 random bytes in base64url: exactly 43 characters, no padding. */
export const BOOK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const BOOK_PROVIDERS = ["calcom", "calendly"] as const;

export const BOOK_KEYS = {
  rec: (hash: string) => `sec:book:${hash}`,
  /** LEGACY per-login pointer: never read or written by the app from M4; Script S2 reads it to count pre-M1 links. */
  of: (login: string, provider: string) => `sec:bookof:${login}:${provider}`,
};

/** A link's record, as `FeedRecord`: `pid` and `aid` name its owner (a record without them is dead from M4). */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_TTL = 10;

/**
 * Mint a new link for `provider`, replacing any previous one. Returns the plain token (shown once, never stored), or
 * "busy" when another create or revoke of the same link holds the lock. The feed's steps (`createFeed`) with the
 * provider in every key.
 */
export async function createBook(who: LinkOwner, scope: string, provider: BookRecord["provider"], lang: "ar" | "en"): Promise<string | "busy"> {
  const lock = personKey.bookLock(who.pid, who.aid, provider);
  const owner = await db.lockOwned(lock, LOCK_TTL);
  if (!owner) return "busy";
  try {
    const token = randomBytes(32).toString("base64url");
    const hash = hashBookToken(token);
    const ptrKey = personKey.bookOf(who.pid, who.aid, provider);
    const old = await db.get<string>(ptrKey);
    const rec: BookRecord = { login: who.login, scope, provider, lang, createdAt: new Date().toISOString(), pid: who.pid, aid: who.aid };
    await db.set(BOOK_KEYS.rec(hash), rec);
    await db.set(ptrKey, hash);
    if (old && old !== hash) await db.del(BOOK_KEYS.rec(old));
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
export async function resolveBook(token: string): Promise<BookRecord | null> {
  if (typeof token !== "string" || !BOOK_TOKEN.test(token)) return null;
  const hash = hashBookToken(token);
  const rec = await db.get<BookRecord>(BOOK_KEYS.rec(hash));
  if (!rec || typeof rec.login !== "string") return null;
  const ids = linkIds(rec);
  if (ids === null) return null;
  const mine = await db.get<string>(personKey.bookOf(ids.pid, ids.aid, rec.provider));
  return linkLive(hash, rec, mine) ? rec : null;
}

/**
 * The live links, one per provider, and when each was made. Never returns a token, a hash or a scope. With `scope` (the
 * caller's own `sc(u)`), each row also says whether the link was made in that brand (`sameBrand`): the record's own
 * scope is compared here and never returned. Without it, `sameBrand` is true. Two rounds: every pointer, then every
 * record.
 */
export async function getBookStatus(who: LinkIds, scope?: string): Promise<{ provider: BookRecord["provider"]; createdAt: string; sameBrand: boolean }[]> {
  const ptrs = await Promise.all(BOOK_PROVIDERS.map((p) => db.get<string>(personKey.bookOf(who.pid, who.aid, p))));
  const recs = await Promise.all(ptrs.map((h) => (typeof h === "string" && h ? db.get<BookRecord>(BOOK_KEYS.rec(h)) : Promise.resolve(null))));
  const rows = BOOK_PROVIDERS.map((provider, i) => {
    const rec = recs[i];
    const ids = rec ? linkIds(rec) : null;
    if (!rec || !ids || ids.pid !== who.pid || ids.aid !== who.aid || rec.provider !== provider) return null;
    return { provider, createdAt: rec.createdAt, sameBrand: scope === undefined || rec.scope === scope };
  });
  return rows.filter((r) => r !== null);
}

/**
 * Kill one provider's link. Waits for the lock up to 20 tries 50 ms apart, then revokes anyway. Deletes
 * `sec:bookof:{pid}:{aid}:{provider}` and the record it names.
 */
async function revokeOne(who: LinkIds, provider: BookRecord["provider"]): Promise<void> {
  const lock = personKey.bookLock(who.pid, who.aid, provider);
  let owner: string | null = null;
  try {
    // Sequential by design: each try only makes sense after the last one failed.
    for (let i = 0; i < 20 && !owner; i++) {
      owner = await db.lockOwned(lock, LOCK_TTL);
      if (!owner) await sleep(50);
    }
    const ptrKey = personKey.bookOf(who.pid, who.aid, provider);
    const mine = await db.get<string>(ptrKey);
    await Promise.all([...(typeof mine === "string" && mine ? [db.del(BOOK_KEYS.rec(mine))] : []), db.del(ptrKey)]);
  } finally {
    if (owner) await db.unlockOwned(lock, owner).catch(() => {});
  }
}

/**
 * Kill the link for `provider`, or for every provider without one. Idempotent. A held lock never keeps a link alive: the
 * lock wait gives up and the revoke goes ahead (as `revokeFeed`, B1-R10).
 */
export async function revokeBook(who: LinkIds, provider?: BookRecord["provider"]): Promise<void> {
  await pmap(provider ? [provider] : [...BOOK_PROVIDERS], (p) => revokeOne(who, p));
}

export const revokeBooks = (whos: LinkIds[]) => pmap(whos, (w) => revokeBook(w)).then(() => {});