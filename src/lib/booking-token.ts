import { createHash, createHmac, randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";

/**
 * Per-login, per-provider booking link (Reem phase 3 B2a). The link a booking tool calls carries a random token; only
 * its SHA-256 is stored, so a store dump never yields a working link. One live link per login per provider:
 * `sec:bookof:{login}:{provider}` names the current hash, and renewing deletes the old record. The webhook signing key
 * is derived from the hash and CONNECT_SECRET (`bookingKey`) and is never stored. Imports only ./db, ./parallel and
 * node:crypto, so team.ts and account.ts can revoke.
 */

/** 32 random bytes in base64url: exactly 43 characters, no padding. */
export const BOOK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const BOOK_PROVIDERS = ["calcom", "calendly"] as const;

export const BOOK_KEYS = {
  rec: (hash: string) => `sec:book:${hash}`,
  of: (login: string, provider: string) => `sec:bookof:${login}:${provider}`,
};

export type BookRecord = { login: string; scope: string; provider: (typeof BOOK_PROVIDERS)[number]; lang: "ar" | "en"; createdAt: string };

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

/**
 * Mint a new link for `login` and `provider`, replacing any previous one. Returns the plain token (shown once, never
 * stored), or "busy" when another create or revoke for this login and provider holds the lock.
 */
export async function createBook(login: string, scope: string, provider: BookRecord["provider"], lang: "ar" | "en"): Promise<string | "busy"> {
  const key = lockKey(login, provider);
  const owner = await db.lockOwned(key, 10);
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
 * The record behind a link, or null. A token of the wrong shape is refused before any store read. A record that
 * `sec:bookof:{login}:{provider}` does not name is dead: a revoke that gave up waiting for the lock can race a create
 * still running, and the record that create wrote must not outlive the revoke, named by nothing.
 */
export async function resolveBook(token: string): Promise<BookRecord | null> {
  if (typeof token !== "string" || !BOOK_TOKEN.test(token)) return null;
  const hash = hashBookToken(token);
  const rec = await db.get<BookRecord>(BOOK_KEYS.rec(hash));
  if (!rec) return null;
  const current = await db.get<string>(BOOK_KEYS.of(rec.login, rec.provider));
  return current === hash ? rec : null;
}

/**
 * The live links of `login`, one per provider, and when each was made. Never returns a token, a hash or a scope. With
 * `scope` (the caller's own `sc(u)`), each row also says whether the link was made in that brand (`sameBrand`): the
 * record's own scope is compared here and never returned. Without it, `sameBrand` is true.
 */
export async function getBookStatus(login: string, scope?: string): Promise<{ provider: BookRecord["provider"]; createdAt: string; sameBrand: boolean }[]> {
  const rows = await Promise.all(
    BOOK_PROVIDERS.map(async (provider) => {
      const hash = await db.get<string>(BOOK_KEYS.of(login, provider));
      const rec = hash ? await db.get<BookRecord>(BOOK_KEYS.rec(hash)) : null;
      return rec ? { provider, createdAt: rec.createdAt, sameBrand: scope === undefined || rec.scope === scope } : null;
    }),
  );
  return rows.filter((r) => r !== null);
}

/** Kill one provider's link for the login. Waits for the lock up to 20 tries 50 ms apart, then revokes anyway. */
async function revokeOne(login: string, provider: BookRecord["provider"]): Promise<void> {
  const key = lockKey(login, provider);
  let owner: string | null = null;
  for (let i = 0; i < 20 && !owner; i++) {
    owner = await db.lockOwned(key, 10);
    if (!owner) await sleep(50);
  }
  try {
    const hash = await db.get<string>(BOOK_KEYS.of(login, provider));
    await Promise.all([hash ? db.del(BOOK_KEYS.rec(hash)) : null, db.del(BOOK_KEYS.of(login, provider))]);
  } finally {
    if (owner) await db.unlockOwned(key, owner).catch(() => {});
  }
}

/**
 * Kill the login's link for `provider`, or for every provider without one. Idempotent. A held lock never keeps a link
 * alive: the lock wait gives up and the revoke goes ahead (as `revokeFeed`, B1-R10).
 */
export async function revokeBook(login: string, provider?: BookRecord["provider"]): Promise<void> {
  await pmap(provider ? [provider] : [...BOOK_PROVIDERS], (p) => revokeOne(login, p));
}

export const revokeBooks = (logins: string[]) => pmap(logins, (l) => revokeBook(l)).then(() => {});
