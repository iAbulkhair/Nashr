import { DUMMY_HASH, saveStaff, sealStaffSecret, type Staff } from "@/lib/staff";
import { fromBase32, hotp, newTotpSecret, totpStep } from "@/lib/totp";
import * as loginRoute from "@/app/api/admin/staff/login/route";
import * as codeRoute from "@/app/api/admin/staff/login/code/route";
import * as enrolRoute from "@/app/api/admin/staff/login/enrol/route";
import * as setupRoute from "@/app/api/admin/staff/setup/route";
import { json } from "./session";

let n = 0;
/** A fresh staff address, never a customer's. */
export const staffAddress = (p = "staff") => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@staff.example`;
/** A staff record written straight to the store (no setup code, no password unless given). */
export async function makeStaff(over: Partial<Staff> = {}): Promise<Staff> {
  const s: Staff = { email: staffAddress(), name: "Staff", role: "owner", passHash: "", createdAt: new Date().toISOString(), createdBy: "key", ...over };
  await saveStaff(s);
  return s;
}

/** The 6-digit code of `secret` at `ms`. */
export const codeAt = (secret: string, ms = Date.now()) => hotp(fromBase32(secret)!, totpStep(ms));

/**
 * A staff record that can hold a session: an authenticator sealed with the current CONNECT_SECRET and a password hash.
 * `passHash` defaults to a cost-12 hash of a password nobody knows, so tests that never type it stay fast.
 */
export async function enrolledStaff(over: Partial<Staff> = {}): Promise<{ staff: Staff; secret: string }> {
  const secret = newTotpSecret();
  const staff = await makeStaff({ passHash: DUMMY_HASH, totp: { ...sealStaffSecret(secret), at: new Date().toISOString() }, ...over });
  return { staff, secret };
}


let ipN = 0;
/** A fresh client address, so one test's per-IP budget never leaks into the next. */
export const freshIp = () => `203.0.113.${(++ipN % 250) + 1}`;
const h = (ip: string) => ({ "x-forwarded-for": ip });
export const staffLogin = (email: unknown, password: unknown, ip = freshIp()) => loginRoute.POST(json("/api/admin/staff/login", "POST", { email, password }, h(ip)));
export const staffCode = (code: unknown, ip = freshIp()) => codeRoute.POST(json("/api/admin/staff/login/code", "POST", { code }, h(ip)));
export const staffEnrol = (body: Record<string, unknown>, ip = freshIp()) => enrolRoute.POST(json("/api/admin/staff/login/enrol", "POST", body, h(ip)));
export const staffSetup = (body: Record<string, unknown>, ip = freshIp()) => setupRoute.POST(json("/api/admin/staff/setup", "POST", body, h(ip)));
export const staffSignOut = () => loginRoute.DELETE(new Request("https://nashr.test/api/admin/staff/login", { method: "DELETE" }));

/** Sign `staff` in through the real routes (password, then a code from `secret`); leaves the staff cookie in the jar. */
export async function staffSignIn(email: string, password: string, secret: string): Promise<void> {
  const a = await (await staffLogin(email, password)).json();
  if (a.next !== "code") throw new Error(`sign-in did not reach the code step: ${JSON.stringify(a)}`);
  const b = await (await staffCode(codeAt(secret))).json();
  if (!b.ok) throw new Error(`code refused: ${JSON.stringify(b)}`);
}
