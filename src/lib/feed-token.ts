import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";

/**
 * Per-login private calendar feed (Reem phase 3 B1). The link carries a random token; only its SHA-256 is stored, so a
 * store dump never yields a working link. One live link per login: `sec:feedof:{login}` names the current hash, and
 * renewing deletes the old record. Imports only ./db, ./parallel and node:crypto, so team.ts and account.ts can revoke.
 */

/** 32 random bytes in base64url: exactly 43 characters, no padding. */
export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const FEED_KEYS = {
  rec: (hash: string) => `sec:feed:${hash}`,
  of: (login: string) => `sec:feedof:${login}`,
};

export type FeedRecord = { login: string; scope: string; lang: "ar" | "en"; createdAt: string };

export const hashFeedToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const lockKey = (login: string) => `lock:feed:${login}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mint a new link for `login`, replacing any previous one. Returns the plain token (shown once, never stored), or
 * "busy" when another create or revoke for this login holds the lock.
 */
export async function createFeed(login: string, scope: string, lang: "ar" | "en"): Promise<string | "busy"> {
  const key = lockKey(login);
  const owner = await db.lockOwned(key, 10);
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

/** The record behind a link, or null. A token of the wrong shape is refused before any store read. */
export async function resolveFeed(token: string): Promise<{ hash: string; rec: FeedRecord } | null> {
  if (typeof token !== "string" || !FEED_TOKEN.test(token)) return null;
  const hash = hashFeedToken(token);
  const rec = await db.get<FeedRecord>(FEED_KEYS.rec(hash));
  return rec ? { hash, rec } : null;
}

/** Whether `login` has a live link, and when it was made. Never returns the token or its hash. */
export async function getFeedStatus(login: string): Promise<{ exists: boolean; createdAt: string | null }> {
  const hash = await db.get<string>(FEED_KEYS.of(login));
  const rec = hash ? await db.get<FeedRecord>(FEED_KEYS.rec(hash)) : null;
  return rec ? { exists: true, createdAt: rec.createdAt } : { exists: false, createdAt: null };
}

/**
 * Kill the login's link. Idempotent. Waits for the lock up to 20 tries 50 ms apart, then revokes anyway: a held lock
 * never keeps a link alive (B1-R10).
 */
export async function revokeFeed(login: string): Promise<void> {
  const key = lockKey(login);
  let owner: string | null = null;
  for (let i = 0; i < 20 && !owner; i++) {
    owner = await db.lockOwned(key, 10);
    if (!owner) await sleep(50);
  }
  try {
    const hash = await db.get<string>(FEED_KEYS.of(login));
    await Promise.all([hash ? db.del(FEED_KEYS.rec(hash)) : null, db.del(FEED_KEYS.of(login))]);
  } finally {
    if (owner) await db.unlockOwned(key, owner).catch(() => {});
  }
}

export const revokeFeeds = (logins: string[]) => pmap(logins, revokeFeed);
