import { NextResponse } from "next/server";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { adminAudit } from "@/lib/admin-audit";
import { openStepUp } from "@/lib/admin-2fa";
import { countStaffFailure, hashStaffPassword, newRecoveryCodes, passwordRefusal, saveStaff, staffLocked, staffPasswordMatches, withStaffLock } from "@/lib/staff";
import { allow, clientIp, giveBack, retryLater } from "@/lib/rate";
import { STAFF_LOGIN_PER_IP, STAFF_LOGIN_WINDOW } from "@/lib/staff-signin";
import { destroyStaffSession, endStaffSessions, openStaffSession, readStaffSession } from "@/lib/staff-session";
import { freshCodeRefusal, secretJson } from "@/lib/staff-admin";

export const dynamic = "force-dynamic";

/**
 * The signed-in staff member's own credentials (rules 1636, 1641, 1642). A staff session only (any role: a person can
 * always change their own password), never the key or the founder's customer session. Both actions need a FRESH code
 * from the person's own authenticator, never a live step-up.
 *
 * POST { action: "password", current, password, code }: the current password too (5 tries per IP per 15 minutes, refused
 *   while the address is locked, a wrong one counts toward the lock); the new one passes the policy.
 *   Every other session and step-up of this person ends (`sessionsAfter`), and this browser gets a fresh session.
 * POST { action: "recovery", code }: 8 new recovery codes, shown once; the old ones stop working.
 *
 * This route runs the console write check (rule 1647) and the fresh code but not the role check of the write gate: it
 * changes nothing in the product, only the caller's own way in.
 */
export async function POST(req: Request) {
  const foreign = consoleWriteRefusal(req);
  if (foreign) return foreign;
  const me = await readStaffSession();
  if (!me) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; current?: unknown; password?: unknown; code?: unknown };
  if (b.action !== "password" && b.action !== "recovery") return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
  const info = { who: me.email, via: "staff" as const };

  if (b.action === "password") {
    // The current-password check is a password guess like the sign-in's (rule 1644): 5 per IP per 15 minutes (a right
    // one hands its hit back), refused while the address is locked, and a wrong one counts toward the lock.
    const ipBucket = `staffme:ip:${clientIp(req)}`;
    if (!(await allow(ipBucket, STAFF_LOGIN_PER_IP, STAFF_LOGIN_WINDOW))) return retryLater({ ok: false, error: "slow_down" }, STAFF_LOGIN_WINDOW);
    const [locked, right] = await Promise.all([staffLocked(me.email), staffPasswordMatches(me.staff, b.current)]);
    if (locked || !right) {
      if (!right) await countStaffFailure(me.email);
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
    }
    await giveBack(ipBucket);
    const refusal = await passwordRefusal(me.email, b.password);
    if (refusal) return NextResponse.json({ ok: false, error: refusal }, { status: 400 });
    const notFresh = await freshCodeRefusal(req, info, b.code);
    if (notFresh) return notFresh;
    const passHash = await hashStaffPassword(b.password as string);
    const done = await withStaffLock(me.email, async (s) => {
      if (!s || s.disabled) return false;
      s.passHash = passHash;
      endStaffSessions(s);
      await saveStaff(s);
      return true;
    });
    if (!done) return NextResponse.json({ ok: false }, { status: 401 });
    // The old session is void now (`sessionsAfter`); its record goes, and this browser gets a new one with a step-up.
    await destroyStaffSession();
    const { id } = await openStaffSession(me.email);
    await openStepUp(me.email, id);
    await adminAudit({ actor: me.email, via: "staff", section: "system", action: "staff.password", target: me.email, what: "staff:password (changed by the person)", extra: { kind: "change" } });
    return NextResponse.json({ ok: true });
  }

  const notFresh = await freshCodeRefusal(req, info, b.code);
  if (notFresh) return notFresh;
  const { codes, rc } = newRecoveryCodes();
  const done = await withStaffLock(me.email, async (s) => {
    if (!s || s.disabled) return false;
    s.rc = rc;
    await saveStaff(s);
    return true;
  });
  if (!done) return NextResponse.json({ ok: false }, { status: 401 });
  await adminAudit({ actor: me.email, via: "staff", section: "system", action: "staff.recovery", target: me.email, what: "staff:recovery codes regenerated", extra: { kind: "regenerate" } });
  return secretJson({ ok: true, recovery: codes });
}
