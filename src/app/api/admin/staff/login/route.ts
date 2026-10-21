import { NextResponse, after } from "next/server";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { allow, clientIp, giveBack, retryLater } from "@/lib/rate";
import { adminAudit } from "@/lib/admin-audit";
import { westernDigits } from "@/lib/verify-client";
import { clearStaffFailures, countStaffFailure, getStaff, openStaffSecret, staffEmail, staffLocked, staffPasswordMatches } from "@/lib/staff";
import { resealStaffSecret, staffTotpOnce, staffTryAccepted, takeStaffTry } from "@/lib/staff-code";
import { destroyStaffSession, openStaffPre } from "@/lib/staff-session";
import { STAFF_LOGIN_PER_IP, STAFF_LOGIN_WINDOW, invalid, openAfterCode } from "@/lib/staff-signin";

/**
 * Staff sign-in, step 1 of 2 (rules 1631, 1632, 1644, docs/system/flows.md section 71).
 *
 * POST { email, password, code? }: public. 5 tries per IP per 15 minutes (a right password hands its hit back), and the
 * per-address lock: 10 failures for one address in 15 minutes lock it for 15 minutes. Every refusal is the same 401
 * `invalid` (unknown address, wrong password, a record with no password or no authenticator, disabled, locked), and one
 * bcrypt compare at cost 12 always runs (against a dummy hash when there is no record), so neither the answer nor the
 * time tells staff addresses apart. The `staff.locked` row is written after the answer (`after`), so the 10th failure
 * costs the same time as the others.
 *
 * A right password opens only the 5-minute pre-auth step at `code`. A record with no authenticator is refused like any
 * other: an authenticator is enrolled only after a setup or reset code (rule 1632), never after the password alone.
 *
 * While the address is locked, a password alone opens nothing, right or wrong: the same 401. The lock only blocks
 * password-only attempts, so the owner of the address is never locked out by someone else's failures: the password AND a
 * code from the person's own authenticator, sent together in `code`, open the session at once (answer `next: "done"`).
 * Any part wrong is the same 401, so a locked address still tells a guesser nothing about the password; the code's own
 * tries (5 per IP and per address per 15 minutes) apply. No email is ever sent from here (rule 1643).
 *
 * DELETE: sign out. Deletes the staff session record and both staff cookies.
 */
export async function POST(req: Request) {
  const foreign = consoleWriteRefusal(req);
  if (foreign) return foreign;
  const ipBucket = `stafflogin:ip:${clientIp(req)}`;
  if (!(await allow(ipBucket, STAFF_LOGIN_PER_IP, STAFF_LOGIN_WINDOW))) return retryLater({ ok: false, error: "slow_down" }, STAFF_LOGIN_WINDOW);
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown; code?: unknown };
  const email = staffEmail(b.email);
  const [staff, locked] = email ? await Promise.all([getStaff(email), staffLocked(email)]) : [null, false];
  const right = await staffPasswordMatches(staff, b.password);
  const usable = right && !!staff && !staff.disabled && !!staff.totp;
  // A wrong password counts toward the lock; a right one for a record that cannot sign in (no authenticator) does not.
  const counts = !right || !staff || !!staff.disabled;
  const fail = async (): Promise<NextResponse> => {
    if (email && counts && (await countStaffFailure(email)) && staff) {
      after(() => adminAudit({ actor: "system", section: "system", action: "staff.locked", target: email, what: "staff:locked (10 failed sign-ins in 15 minutes)" }));
    }
    return invalid();
  };

  if (locked) {
    const code = typeof b.code === "string" ? westernDigits(b.code).replace(/\s+/g, "") : "";
    if (!email || !/^\d{6}$/.test(code)) return fail();
    const slow = await takeStaffTry(req, email);
    if (slow) return slow;
    const opened = usable ? openStaffSecret(staff!.totp) : null;
    if (!opened || !(await staffTotpOnce(staff!.email, opened.secret, code))) return fail();
    await Promise.all([staffTryAccepted(req, staff!.email), giveBack(ipBucket)]);
    if (opened.stale) await resealStaffSecret(staff!.email, opened.secret);
    // The lock stays for its window: the failures were someone else's, and they keep getting the plain 401.
    await openAfterCode(staff!, "");
    await adminAudit({ actor: staff!.email, via: "staff", section: "system", action: "staff.signin", target: staff!.email, what: "staff:signin (password and code together, address locked)", extra: { locked: true } });
    return NextResponse.json({ ok: true, next: "done" });
  }

  if (!usable) return fail();
  await Promise.all([clearStaffFailures(staff!.email), giveBack(ipBucket)]);
  await openStaffPre(staff!.email, "code");
  return NextResponse.json({ ok: true, next: "code" });
}

export async function DELETE(req: Request) {
  const foreign = consoleWriteRefusal(req);
  if (foreign) return foreign;
  const email = await destroyStaffSession();
  if (email) await adminAudit({ actor: email, via: "staff", section: "system", action: "staff.signout", target: email, what: "staff:signout" });
  return NextResponse.json({ ok: true });
}
