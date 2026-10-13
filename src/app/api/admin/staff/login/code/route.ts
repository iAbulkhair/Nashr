import { NextResponse } from "next/server";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { adminAudit } from "@/lib/admin-audit";
import { getStaff, issuedBeforeStaff, looksLikeStaffCode, recoveryIndex, saveStaff, withStaffLock } from "@/lib/staff";
import { dropStaffPre, readStaffPre, setStaffPreStage } from "@/lib/staff-session";
import { badCode, staffTryAccepted, takeStaffTry } from "@/lib/staff-code";
import { signInWithTotp, startAgain } from "@/lib/staff-signin";

/**
 * Staff sign-in, step 2 of 2 (rules 1632, 1642). Needs the pre-auth cookie at stage `code` (a right password within the
 * last 5 minutes).
 *
 * POST { code }: the 6 digits from the person's own authenticator (tries limited per IP and per address, the step
 * burned), which opens the staff session; or one of the person's recovery codes, which is spent and moves the
 * pre-auth step to `enrol`: a new authenticator must be set up before any session opens. The old authenticator stays
 * until the new one is confirmed, so the password alone can never enrol one.
 */
export async function POST(req: Request) {
  const foreign = consoleWriteRefusal(req);
  if (foreign) return foreign;
  const pre = await readStaffPre();
  if (!pre || pre.stage !== "code") return startAgain();
  const staff = await getStaff(pre.email);
  if (!staff || staff.disabled || !staff.totp || issuedBeforeStaff(staff, pre.at)) {
    await dropStaffPre(pre.hash);
    return startAgain();
  }
  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (looksLikeStaffCode(code)) {
    const slow = await takeStaffTry(req, staff.email);
    if (slow) return slow;
    const spent = await withStaffLock(staff.email, async (s) => {
      const i = s ? recoveryIndex(s.rc, code) : -1;
      if (!s || i < 0) return false;
      s.rc = s.rc!.filter((_, j) => j !== i);
      await saveStaff(s);
      return true;
    });
    if (!spent || !(await setStaffPreStage(pre, "enrol"))) return spent ? startAgain() : badCode();
    await staffTryAccepted(req, staff.email);
    await adminAudit({ actor: staff.email, via: "staff", section: "system", action: "staff.recovery", target: staff.email, what: "staff:recovery (a new authenticator must be set up)" });
    return NextResponse.json({ ok: true, next: "enrol" });
  }
  return signInWithTotp(req, staff, pre, code);
}
