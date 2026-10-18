import { createHash } from "crypto";
import { headers } from "next/headers";
import { db } from "./db";
import { normalizeEmail } from "./auth";
import { clientIp } from "./rate";

/**
 * The device list (rules 1938-1941, docs/system/flows.md "Signed-in devices"). Sessions live as unindexed
 * `session:h:{sha256(token)}` keys (rule 1345); this adds one index per login, `devs:{login}`, a hash whose fields are
 * short ids and whose values say which session key, which browser, from which address and when. It is written at
 * sign-in (`createSession`, never for a founder's impersonation) and read only for the login itself, so nobody can list
 * or end another login's devices: the id from the request is looked up inside the caller's own hash, and the session
 * key comes from the stored entry, never from the request.
 *
 * A new key only (rule 679 expand): sessions created before this release are simply not listed, and "sign out other
 * devices" still ends them. Entries whose session is gone, expired or revoked (a password change, "sign out other
 * devices") are dropped the next time the list is read.
 */
export const DEVICES_TTL = 60 * 60 * 24 * 30;
/** The most entries one login keeps; the oldest go first. */
export const DEVICES_MAX = 50;
/** The longest browser string kept: enough to name the browser and system, never the whole header. */
export const UA_MAX = 300;

type Entry = { k: string; ua: string; ip: string; at: number };
export type Device = { id: string; ua: string; ip: string; at: number; current: boolean };

export const devicesKey = (login: string) => `devs:${normalizeEmail(login)}`;
/** A short, stable id for a session key; it says nothing about the token. */
export const deviceId = (sessionKey: string) => createHash("sha256").update(`nashr-device:${sessionKey}`).digest("hex").slice(0, 20);

const isEntry = (v: unknown): v is Entry => !!v && typeof v === "object" && typeof (v as Entry).k === "string" && (v as Entry).k.startsWith("session:h:");

/** Index a new session of `login` with this request's browser and address. Best effort: a failure never blocks a sign-in. */
export async function recordDevice(login: string, sessionKey: string): Promise<void> {
  const h = await headers();
  const ua = (h.get("user-agent") ?? "").slice(0, UA_MAX);
  // The address the rate limits use (src/lib/rate.ts stays the only file that names an address header, rule 773).
  const ip = clientIp({ headers: h } as unknown as Request);
  const key = devicesKey(login);
  await db.hset(key, deviceId(sessionKey), { k: sessionKey, ua, ip: ip === "unknown" ? "" : ip, at: Date.now() } satisfies Entry);
  await db.expire(key, DEVICES_TTL);
}

/** Forget one session's entry (signing out on this device). */
export async function forgetDevice(login: string, sessionKey: string): Promise<void> {
  await db.hdel(devicesKey(login), deviceId(sessionKey));
}

type SessionLike = string | { email?: string; at?: number } | null;
const issuedAt = (rec: SessionLike) => (!rec ? -1 : typeof rec === "string" ? 0 : Number(rec.at) || 0);
const sessionEmail = (rec: SessionLike) => (!rec ? "" : typeof rec === "string" ? rec : String(rec.email ?? ""));

/**
 * The login's live devices, newest first, with the one making this request marked `current`. `after` is the newest
 * revocation stamp that applies (`sessionsAfter`, `devicesAfter`): a session issued before it no longer works and is
 * not listed. Dead entries are removed in one parallel pass.
 */
export async function listDevices(login: string, currentKey: string | null, after: (string | undefined)[]): Promise<Device[]> {
  const key = devicesKey(login);
  const all = await db.hgetall<Entry>(key);
  const entries = Object.entries(all).filter((e): e is [string, Entry] => isEntry(e[1]));
  const recs = entries.length ? await db.mget<SessionLike>(entries.map(([, e]) => e.k)) : [];
  const stamp = Math.max(0, ...after.map((s) => (s ? new Date(s).getTime() : 0)).filter(Number.isFinite));
  const me = normalizeEmail(login);
  const live: Device[] = [];
  const dead: string[] = Object.keys(all).filter((id) => !isEntry(all[id]));
  entries.forEach(([id, e], i) => {
    const rec = recs[i];
    if (!rec || sessionEmail(rec) !== me || issuedAt(rec) < stamp) return void dead.push(id);
    live.push({ id, ua: e.ua, ip: e.ip, at: Number(e.at) || 0, current: e.k === currentKey });
  });
  live.sort((a, b) => b.at - a.at);
  const over = live.slice(DEVICES_MAX).filter((d) => !d.current).map((d) => d.id);
  if (dead.length || over.length) await Promise.all([...dead, ...over].map((id) => db.hdel(key, id))).catch(() => {});
  return live.filter((d) => !over.includes(d.id));
}

/**
 * When `login` last signed in, as epoch ms, or null when no sign-in is indexed (none in the last 30 days, or every one
 * before this index existed). Reading only, for the founder console's workspace view (rule 2080): it never drops an
 * entry, and it says nothing about the browser or the address.
 */
export async function lastSignIn(login: string): Promise<number | null> {
  const all = (await db.hgetall<Entry>(devicesKey(login))) ?? {};
  const ats = Object.values(all).filter(isEntry).map((e) => Number(e.at) || 0).filter((n) => n > 0);
  return ats.length ? Math.max(...ats) : null;
}

/**
 * End one session of `login` by its id: the entry is looked up in the login's own index and its stored session key
 * deleted. False when the id is not one of this login's devices. Never the current session: that is signing out.
 */
export async function revokeDevice(login: string, id: string, currentKey: string | null): Promise<"ok" | "unknown" | "current"> {
  if (!/^[0-9a-f]{20}$/.test(id)) return "unknown";
  const key = devicesKey(login);
  const all = await db.hgetall<Entry>(key);
  const e = all[id];
  if (!isEntry(e)) return "unknown";
  if (e.k === currentKey) return "current";
  await Promise.all([db.del(e.k), db.hdel(key, id)]);
  return "ok";
}

/**
 * End every listed session of `login` (an address change ends them all) and drop the index. Sessions not listed
 * (created before this release) are ended by the caller's stamp.
 */
export async function revokeAllDevices(login: string): Promise<void> {
  const key = devicesKey(login);
  const all = await db.hgetall<Entry>(key);
  await Promise.all([...Object.values(all).filter(isEntry).map((e) => db.del(e.k)), db.del(key)]);
}
