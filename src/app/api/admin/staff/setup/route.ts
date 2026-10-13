import { NextResponse } from "next/server";
import { allow, clientIp, giveBack, retryLater } from "@/lib/rate";
import { adminAudit } from "@/lib/admin-audit";
import { hashStaffPassword, passwordRefusal, peekSetupCode, saveStaff, staffEmail, takeSetupCode, withStaffLock } from "@/lib/staff";
import { endStaffSessions, openStaffPre } from "@/lib/staff-session";
import { SETUP_PER_IP, SETUP_WINDOW, invalid } from "@/lib/staff-signin";

/**
 * Redeem a setup or reset code (rules 1639, 1640, 1643). Public, with the code: 5 tries per IP per 15 minutes.
 *
 * POST { email, code, password }: the code is typed into the form, never put in a URL. It works once, within 30
 * minutes, and only for the address it was issued for. The password is checked against the policy before the code is
 * spent (a refused password leaves the code usable). A reset code also removes the person's authenticator and recovery
 * codes, and every session and step-up of that person ends (`sessionsAfter`). Then the pre-auth step moves to `enrol`.
 * An unknown, spent or expired code, or one for another address, is the same 401 `invalid`.
 */
export async function POST(req: Request) {
  const ipBucket = `staffsetup:ip:${clientIp(req)}`;
  if (!(await allow(ipBucket, SETUP_PER_IP, SETUP_WINDOW))) return retryLater({ ok: false, error: "slow_down" }, SETUP_WINDOW);
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; code?: unknown; password?: unknown };
  const email = staffEmail(b.email);
  const peek = email ? await peekSetupCode(b.code) : null;
  if (!email || !peek || peek.email !== email) return invalid();
  const refusal = await passwordRefusal(email, b.password);
  if (refusal) {
    await giveBack(ipBucket);
    return NextResponse.json({ ok: false, error: refusal }, { status: 400 });
  }
  const taken = await takeSetupCode(b.code as string);
  if (!taken || taken.email !== email) return invalid();
  const passHash = await hashStaffPassword(b.password as string);
  const done = await withStaffLock(email, async (s) => {
    if (!s || s.disabled) return false;
    s.passHash = passHash;
    if (taken.kind === "reset") { delete s.totp; delete s.rc; }
    endStaffSessions(s);
    await saveStaff(s);
    return true;
  });
  if (!done) return invalid();
  await Promise.all([giveBack(ipBucket), openStaffPre(email, "enrol")]);
  await adminAudit({ actor: email, via: "staff", section: "system", action: "staff.password", target: email, what: `staff:password (${taken.kind} code)`, extra: { kind: taken.kind } });
  return NextResponse.json({ ok: true, next: "enrol" });
}
