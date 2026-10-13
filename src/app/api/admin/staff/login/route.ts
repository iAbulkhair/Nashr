import { NextResponse } from "next/server";
import { allow, clientIp, giveBack, retryLater } from "@/lib/rate";
import { adminAudit } from "@/lib/admin-audit";
import { clearStaffFailures, countStaffFailure, getStaff, staffEmail, staffLocked, staffPasswordMatches } from "@/lib/staff";
import { destroyStaffSession, openStaffPre } from "@/lib/staff-session";
import { STAFF_LOGIN_PER_IP, STAFF_LOGIN_WINDOW, invalid } from "@/lib/staff-signin";

/**
 * Staff sign-in, step 1 of 2 (rules 1631, 1644, docs/system/flows.md section 71).
 *
 * POST { email, password }: public. 5 tries per IP per 15 minutes (a right password hands its hit back), and the
 * per-address lock: 10 failures for one address in 15 minutes lock it for 15 minutes. Every refusal is the same 401
 * `invalid` (unknown address, wrong password, a record with no password yet, disabled, locked), and one bcrypt compare at
 * cost 12 always runs (against a dummy hash when there is no record), so neither the answer nor the time tells staff
 * addresses apart. A right password opens only the 5-minute pre-auth step: `next: "code"`, or `"enrol"` when the person
 * has no authenticator yet. No email is ever sent from here (rule 1643).
 *
 * DELETE: sign out. Deletes the staff session record and both staff cookies.
 */
export async function POST(req: Request) {
  const ipBucket = `stafflogin:ip:${clientIp(req)}`;
  if (!(await allow(ipBucket, STAFF_LOGIN_PER_IP, STAFF_LOGIN_WINDOW))) return retryLater({ ok: false, error: "slow_down" }, STAFF_LOGIN_WINDOW);
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = staffEmail(b.email);
  const [staff, locked] = email ? await Promise.all([getStaff(email), staffLocked(email)]) : [null, false];
  const right = await staffPasswordMatches(staff, b.password);
  if (!right || locked || !staff || staff.disabled) {
    if (email && (await countStaffFailure(email)) && staff) {
      await adminAudit({ actor: "system", section: "system", action: "staff.locked", target: email, what: "staff:locked (10 failed sign-ins in 15 minutes)" });
    }
    return invalid();
  }
  await Promise.all([clearStaffFailures(staff.email), giveBack(ipBucket)]);
  const next = staff.totp ? "code" : "enrol";
  await openStaffPre(staff.email, next);
  return NextResponse.json({ ok: true, next });
}

export async function DELETE() {
  const email = await destroyStaffSession();
  if (email) await adminAudit({ actor: email, via: "staff", section: "system", action: "staff.signout", target: email, what: "staff:signout" });
  return NextResponse.json({ ok: true });
}
