import { NextResponse } from "next/server";
import { db } from "./db";
import { actorInfo, type ActorInfo } from "./auth";
import { checkCode, secondFactorStatus } from "./admin-2fa";
import { westernDigits } from "./verify-client";
import { checkStaffCode } from "./staff-code";
import { activeOwner, getStaff, listStaff, type Staff } from "./staff";
import { log } from "./log";

/**
 * What the staff management routes share (rules 1636-1640, 1650): the fresh-code check, who may do what, the view of a
 * record the console shows, and the last-owner guard.
 */

const no = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

/** Answers that hand out a secret once (a setup code, recovery codes) are never stored by a cache. */
export const secretJson = (body: Record<string, unknown>) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

/** The request's console actor, as `adminActor` recorded it, when it is the same `who`. */
export function actorOf(req: Request, who: string): ActorInfo | null {
  const i = actorInfo(req);
  return i && i.who === who ? i : null;
}

/** A staff actor with the owner role (what creating, disabling, enabling, changing a role and the switch need). */
export const isStaffOwner = (i: ActorInfo | null): boolean => !!i && i.via === "staff" && i.role === "owner";

/**
 * A FRESH code for this request (rule 1636, the "sudo" pattern): never a live step-up. A staff actor types a code from
 * their own authenticator; the key session types the console code, and with no console code enrolled (`admin:2fa`) the
 * key session changes no staff login at all: 403 `console_code_required` (rule 1643), so the key alone never takes one
 * over. The code is `body.code` or `x-admin-otp`; when the write gate already accepted `x-admin-otp` for this request,
 * that was it. Six digits only: a recovery code is spent at sign-in, never as a side effect of a management action.
 * Null to go on; 403 `fresh_code` (staff) or `console_code_required` (key) without a code; the code check's own 400 or
 * 429 otherwise.
 */
export async function freshCodeRefusal(req: Request, info: ActorInfo, bodyCode: unknown): Promise<NextResponse | null> {
  if (info.via === "key" && !(await secondFactorStatus()).enrolled) return no("console_code_required", 403);
  if (info.fresh) return null;
  const raw = typeof bodyCode === "string" && bodyCode ? bodyCode : req.headers.get("x-admin-otp");
  const code = typeof raw === "string" ? westernDigits(raw).replace(/\s+/g, "") : null;
  if (info.via === "staff") {
    if (!code || !/^\d{6}$/.test(code)) return no("fresh_code", 403);
    const staff = await getStaff(info.who);
    if (!staff) return no("fresh_code", 403);
    const r = await checkStaffCode(req, staff, code);
    return r.ok ? null : r.res;
  }
  if (info.via === "key") {
    if (!code || !/^\d{6}$/.test(code)) return no("console_code_required", 403);
    const r = await checkCode(req, code);
    return r.ok ? null : r.res;
  }
  return no("staff_only", 403);
}

/** What the console shows of a staff record: never the password hash, the sealed secret or the recovery hashes. */
export type StaffView = {
  email: string;
  name: string;
  role: string;
  enrolled: boolean;
  passwordSet: boolean;
  recoveryLeft: number;
  disabled: boolean;
  createdAt: string;
  createdBy: string;
  lastSignInAt: string | null;
};
export const staffView = (s: Staff): StaffView => ({
  email: s.email,
  name: s.name,
  role: s.role,
  enrolled: !!s.totp,
  passwordSet: !!s.passHash,
  recoveryLeft: Array.isArray(s.rc) ? s.rc.length : 0,
  disabled: !!s.disabled,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
  lastSignInAt: s.lastSignInAt ?? null,
});

/**
 * Whether `email` is the only active owner left (enabled, password set, authenticator enrolled: `activeOwner`), so that
 * disabling it or changing its role would leave nobody able to manage staff. Run it under `OWNERS_LOCK`
 * together with the write it guards (rule 1659).
 */
export async function lastOwner(email: string): Promise<boolean> {
  const owners = (await listStaff()).filter(activeOwner);
  return owners.length === 1 && owners[0].email === email;
}

/** A display name: trimmed, control characters removed, 1 to 80 characters; null otherwise. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return n.length >= 1 && n.length <= 80 ? n : null;
}

/** Run `fn` under a named lock (the same retry loop as `withStaffLock`); `fn` runs alone across instances. */
export async function withNamedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await new Promise((r) => setTimeout(r, 50));
  }
  if (!got) throw new Error("staff_lock_timeout");
  try {
    return await fn();
  } finally {
    await db.unlock(key).catch((e) => log.error("staff lock release failed", e));
  }
}
