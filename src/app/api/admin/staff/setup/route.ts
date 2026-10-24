import { NextResponse } from "next/server";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { allow, clientIp, giveBack, retryLater } from "@/lib/rate";
import { adminAudit } from "@/lib/admin-audit";
import { hashStaffPassword, passwordRefusal, peekSetupCode, saveStaff, staffEmail, takeSetupCode, withStaffLock } from "@/lib/staff";
import { clearStaffSetupCookie, endStaffSessions, openStaffPre, readStaffSetupCookie } from "@/lib/staff-session";
import { SETUP_PER_IP, SETUP_WINDOW, invalid } from "@/lib/staff-signin";

/**
 * Redeem a setup, reset or invite code (rules 1639, 1640, 1643, 3701, 3706). Public, with the code: 5 tries per IP per
 * 15 minutes.
 *
 * POST { email, code, password }: the code is typed into the form, read by the page from an invite link's fragment, or
 * (no `code` in the body) taken from the setup hand-off cookie the founder's bootstrap set (rule 3701); never a URL
 * query. A setup or reset code works once, within 30 minutes, an invite within 24 hours, and only for the address it
 * was issued for. The password is checked against the policy before the code is
 * spent (a refused password leaves the code usable). A reset code also removes the person's authenticator and recovery
 * codes, and every session and step-up of that person ends (`sessionsAfter`). Then the pre-auth step moves to `enrol`.
 * An unknown, spent or expired code, or one for another address, is the same 401 `invalid`.
 */
export async function POST(req: Request) {
  const foreign = consoleWriteRefusal(req);
  if (foreign) return foreign;
  const ipBucket = `staffsetup:ip:${clientIp(req)}`;
  if (!(await allow(ipBucket, SETUP_PER_IP, SETUP_WINDOW))) return retryLater({ ok: false, error: "slow_down" }, SETUP_WINDOW);
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; code?: unknown; password?: unknown };
  const email = staffEmail(b.email);
  const handoff = b.code === undefined || b.code === null || b.code === "";
  const code = handoff ? await readStaffSetupCookie() : b.code;
  const peek = email && code ? await peekSetupCode(code) : null;
  if (!email || !peek || peek.email !== email) return invalid();
  const refusal = await passwordRefusal(email, b.password);
  if (refusal) {
    await giveBack(ipBucket);
    return NextResponse.json({ ok: false, error: refusal }, { status: 400 });
  }
  const taken = await takeSetupCode(code as string);
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
  await Promise.all([giveBack(ipBucket), openStaffPre(email, "enrol"), handoff ? clearStaffSetupCookie() : Promise.resolve()]);
  await adminAudit({ actor: email, via: "staff", section: "system", action: "staff.password", target: email, what: `staff:password (${taken.kind} code)`, extra: { kind: taken.kind } });
  return NextResponse.json({ ok: true, next: "enrol" });
}
