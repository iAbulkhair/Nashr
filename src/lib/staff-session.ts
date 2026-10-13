import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { db } from "./db";
import { loopbackHttp } from "./auth";
import { idleInTime, renewIdle, type IdleLimits } from "./idle-session";
import { getStaff, issuedBeforeStaff, sha, type Staff } from "./staff";

/**
 * The staff session (rules 1633-1635, docs/specs/2026-10-13-staff-identity.md "Sign-in").
 *
 * Cookie `__Host-thakeen_staff` holds a random 32-byte id: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no
 * `Domain`, so no sibling host (staging, a future subdomain) can set or read it. The server keeps
 * `staffsession:{sha256(id)}` = `{ email, at, seen }`, so a read of the store hands out no live cookie. The session ends
 * after 15 idle minutes and 12 hours at most, renewed at most once a minute with `SET XX` (the key session's logic in
 * src/lib/idle-session.ts, shared, not copied), and both limits are checked in code. The staff record is read on every
 * request: a disabled record, a record without an authenticator, and a session issued before `sessionsAfter` (password
 * or authenticator reset, disable, role change) are refused.
 *
 * On plain http to the loopback host only (local development) the cookies are named without the prefix, because a
 * browser refuses a `__Host-` cookie without `Secure`: the same exception `sessionCookie` makes. Anywhere else only the
 * prefixed name is read, so a cookie planted by a sibling host under the dev name is never looked at.
 *
 * Between the password and the code the browser holds `__Host-thakeen_staff_pre` for 5 minutes: `staffpre:{sha256(id)}`
 * = `{ email, stage, at }`, stage `code` or `enrol`. It opens nothing in the console.
 */
export const STAFF_COOKIE = "__Host-thakeen_staff";
export const STAFF_COOKIE_DEV = "thakeen_staff_dev";
export const STAFF_PRE_COOKIE = "__Host-thakeen_staff_pre";
export const STAFF_PRE_COOKIE_DEV = "thakeen_staff_pre_dev";
/** Idle limit, absolute limit and renewal spacing, seconds. The same numbers as the key session. */
export const STAFF_SESSION_IDLE = 15 * 60;
export const STAFF_SESSION_MAX = 12 * 60 * 60;
export const STAFF_SESSION_RENEW = 60;
export const STAFF_LIMITS: IdleLimits = { idle: STAFF_SESSION_IDLE, max: STAFF_SESSION_MAX, renew: STAFF_SESSION_RENEW };
/** Seconds between the password and the code (or the enrolment). */
export const STAFF_PRE_TTL = 5 * 60;

export type StaffSessionRec = { email: string; at: number; seen?: number };
export type StaffPreStage = "code" | "enrol";
export type StaffPre = { email: string; stage: StaffPreStage; at: number };
export const staffSessionKey = (hash: string) => `staffsession:${hash}`;
const preKey = (hash: string) => `staffpre:${hash}`;
const ID = /^[0-9a-f]{64}$/;
export const isStaffHash = (h: unknown): h is string => typeof h === "string" && ID.test(h);

/** The two cookie names for this transport (rule 1633). */
export async function staffCookieNames(): Promise<{ session: string; pre: string }> {
  return (await loopbackHttp()) ? { session: STAFF_COOKIE_DEV, pre: STAFF_PRE_COOKIE_DEV } : { session: STAFF_COOKIE, pre: STAFF_PRE_COOKIE };
}

/** Every staff cookie's attributes (rule 1633). No `domain`: host-only, as the `__Host-` prefix requires. */
export async function staffCookieOptions(maxAge: number) {
  return { httpOnly: true, secure: !(await loopbackHttp()), sameSite: "strict", path: "/", maxAge } as const;
}

/** Clear a cookie with the same attributes it was set with (a `__Host-` cookie is only replaced by a `Secure` one). */
async function clearCookie(name: string): Promise<void> {
  (await cookies()).set(name, "", await staffCookieOptions(0));
}

/** The raw cookie value of the staff session, or null. What a staff step-up is tied to. */
export async function staffCookieValue(): Promise<string | null> {
  const id = (await cookies()).get((await staffCookieNames()).session)?.value;
  return id && ID.test(id) ? id : null;
}

/** Open a staff session for `email` and set its cookie. The caller has checked the password and a code. */
export async function openStaffSession(email: string): Promise<{ id: string; hash: string }> {
  const id = randomBytes(32).toString("hex");
  const hash = sha(id);
  const now = Date.now();
  await db.set(staffSessionKey(hash), { email, at: now, seen: now } satisfies StaffSessionRec, STAFF_SESSION_IDLE);
  (await cookies()).set((await staffCookieNames()).session, id, await staffCookieOptions(STAFF_SESSION_MAX));
  return { id, hash };
}

/** Whether a staff record may hold a session that began at `atMs`: enabled, enrolled, with a password, not revoked. */
export const staffMayHold = (s: Staff | null, atMs: number): s is Staff =>
  !!s && !s.disabled && !!s.passHash && !!s.totp && !issuedBeforeStaff(s, atMs);

/** The live session stored under `hash`, renewed, with its staff record; null when it is over for any reason. */
async function liveByHash(hash: string): Promise<{ rec: StaffSessionRec; staff: Staff } | null> {
  const k = staffSessionKey(hash);
  const rec = await db.get<StaffSessionRec>(k);
  if (!rec || typeof rec.email !== "string") return null;
  const now = Date.now();
  if (!idleInTime(rec, now, STAFF_LIMITS)) return null;
  const staff = await getStaff(rec.email);
  if (!staffMayHold(staff, rec.at) || staff.email !== rec.email) return null;
  await renewIdle(k, { email: rec.email, at: rec.at, ...(typeof rec.seen === "number" ? { seen: rec.seen } : {}) } satisfies StaffSessionRec, now, STAFF_LIMITS);
  return { rec, staff };
}

/** `cookie`: the raw cookie value, what a staff step-up is tied to (never stored, never logged). */
export type StaffSession = { email: string; staff: Staff; hash: string; at: number; cookie: string };

/** The caller's live staff session, renewed; null without one. */
export async function readStaffSession(): Promise<StaffSession | null> {
  const id = await staffCookieValue();
  if (!id) return null;
  const hash = sha(id);
  const live = await liveByHash(hash);
  return live ? { email: live.staff.email, staff: live.staff, hash, at: live.rec.at, cookie: id } : null;
}

/**
 * Whether the staff session stored under `hash` is still live for `email`, renewing it (rule 1648): a customer view
 * opened from a staff session lives only as long as that session, and working in it keeps the session from going idle.
 */
export async function staffSessionLive(hash: unknown, email: string): Promise<boolean> {
  if (!isStaffHash(hash)) return false;
  const live = await liveByHash(hash);
  return !!live && live.staff.email === email;
}

/** Sign out: the record goes, so the same cookie never works again, and both staff cookies are cleared. */
export async function destroyStaffSession(): Promise<string | null> {
  const names = await staffCookieNames();
  const jar = await cookies();
  const id = jar.get(names.session)?.value;
  let email: string | null = null;
  if (id && ID.test(id)) {
    const k = staffSessionKey(sha(id));
    email = (await db.getdel<StaffSessionRec>(k))?.email ?? null;
  }
  const pre = jar.get(names.pre)?.value;
  await Promise.all([pre && ID.test(pre) ? db.del(preKey(sha(pre))) : Promise.resolve(), clearCookie(names.session), clearCookie(names.pre)]);
  return email;
}

/** Mark every session and step-up of this person void (rule 1635). Only marks the record: the caller saves it. */
export function endStaffSessions(s: Staff): void {
  s.sessionsAfter = new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------------------------------
// The pre-auth step between the password and the code

/** After a right password: the pre-auth record and its 5-minute cookie. */
export async function openStaffPre(email: string, stage: StaffPreStage): Promise<void> {
  const id = randomBytes(32).toString("hex");
  await db.set(preKey(sha(id)), { email, stage, at: Date.now() } satisfies StaffPre, STAFF_PRE_TTL);
  (await cookies()).set((await staffCookieNames()).pre, id, await staffCookieOptions(STAFF_PRE_TTL));
}

/** The caller's pre-auth record, or null (none, expired, damaged). */
export async function readStaffPre(): Promise<(StaffPre & { hash: string }) | null> {
  const id = (await cookies()).get((await staffCookieNames()).pre)?.value;
  if (!id || !ID.test(id)) return null;
  const hash = sha(id);
  const p = await db.get<StaffPre>(preKey(hash));
  if (!p || typeof p.email !== "string" || (p.stage !== "code" && p.stage !== "enrol") || typeof p.at !== "number") return null;
  if (Date.now() - p.at >= STAFF_PRE_TTL * 1000) return null;
  return { email: p.email, stage: p.stage, at: p.at, hash };
}

/** Move a pre-auth record to `stage`, keeping its end. False when it is gone. */
export async function setStaffPreStage(p: StaffPre & { hash: string }, stage: StaffPreStage): Promise<boolean> {
  const ttl = Math.floor((p.at + STAFF_PRE_TTL * 1000 - Date.now()) / 1000);
  if (ttl <= 0) return false;
  return db.setXx(preKey(p.hash), { email: p.email, stage, at: p.at } satisfies StaffPre, ttl);
}

/** Drop the pre-auth record and its cookie. */
export async function dropStaffPre(hash?: string): Promise<void> {
  const names = await staffCookieNames();
  await Promise.all([hash ? db.del(preKey(hash)) : Promise.resolve(), clearCookie(names.pre)]);
}
