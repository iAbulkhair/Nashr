import { NextResponse } from "next/server";
import { db } from "./db";
import { adminAudit } from "./admin-audit";
import { openStepUp } from "./admin-2fa";
import { newTotpSecret, otpauthUri } from "./totp";
import { newRecoveryCodes, openStaffSecret, saveStaff, sealStaffSecret, sha, withStaffLock, type Staff } from "./staff";
import { dropStaffPre, endStaffSessions, openStaffSession, type StaffPre } from "./staff-session";
import { checkStaffCode, staffTotpOnce, staffTryAccepted, takeStaffTry, badCode } from "./staff-code";

/**
 * What the sign-in routes share (rules 1631, 1632, 1642): the generic refusal, opening the session after a code, and
 * the enrolment of a new authenticator. No staff session ever opens without a code just checked (rule 1632).
 */

/** Sign-in tries per IP per window (a right password hands its hit back), and setup-code tries per IP. */
export const STAFF_LOGIN_PER_IP = 5, STAFF_LOGIN_WINDOW = 15 * 60;
export const SETUP_PER_IP = 5, SETUP_WINDOW = 15 * 60;
/**
 * The pre-auth steps (code, enrol) per IP per window, on top of the code tries: bounds how often one address can start
 * an enrolment or post to these routes at all, whatever the body says.
 */
export const STAFF_STEP_PER_IP = 30, STAFF_STEP_WINDOW = 15 * 60;

/** The one refusal of the sign-in: unknown address, wrong password, disabled, locked, all alike (rule 1631). */
export const invalid = () => NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
/** The pre-auth step is missing, expired or at another stage: start from the password again. */
export const startAgain = () => NextResponse.json({ ok: false, error: "start_again" }, { status: 401 });

/**
 * A code was just accepted: open the staff session and a step-up tied to it (sign-in counts as a step-up, spec
 * "Sign-in" item 5), drop the pre-auth step, stamp `lastSignInAt`.
 */
export async function openAfterCode(staff: Staff, preHash: string): Promise<void> {
  const { id } = await openStaffSession(staff.email);
  await Promise.all([
    openStepUp(staff.email, id),
    dropStaffPre(preHash),
    withStaffLock(staff.email, async (s) => {
      if (!s) return;
      s.lastSignInAt = new Date().toISOString();
      await saveStaff(s);
    }).catch(() => {}),
  ]);
}

/** The code step: 6 digits from the person's authenticator. */
export async function signInWithTotp(req: Request, staff: Staff, pre: StaffPre & { hash: string }, code: unknown): Promise<NextResponse> {
  const r = await checkStaffCode(req, staff, code);
  if (!r.ok) return r.res;
  await openAfterCode(staff, pre.hash);
  await adminAudit({ actor: staff.email, via: "staff", section: "system", action: "staff.signin", target: staff.email, what: "staff:signin" });
  return NextResponse.json({ ok: true });
}

/** Pending enrolment, 15 minutes, tied to the pre-auth step that started it. */
export const ENROL_TTL = 15 * 60;
type PendingEnrol = { enc: string; kid: string; at: string; pre: string };
const enrolKey = (email: string) => `staffenrol:${sha(email)}`;

/** Start enrolment: a new secret, kept sealed until a code from it confirms it. */
export async function startStaffEnrol(email: string, preHash: string): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  await db.set(enrolKey(email), { ...sealStaffSecret(secret), at: new Date().toISOString(), pre: preHash } satisfies PendingEnrol, ENROL_TTL);
  return { secret, uri: otpauthUri(secret, email) };
}

/**
 * Confirm enrolment with a code from the new secret: store it with 8 new recovery codes, end every earlier session of
 * this person when an authenticator is being replaced (rule 1635), open the session and its step-up. Answers the codes,
 * shown this once.
 */
export async function confirmStaffEnrol(req: Request, staff: Staff, pre: StaffPre & { hash: string }, code: unknown): Promise<NextResponse> {
  if (typeof code !== "string" || code.length > 64) return badCode();
  const slow = await takeStaffTry(req, staff.email);
  if (slow) return slow;
  const p = await db.get<PendingEnrol>(enrolKey(staff.email));
  if (!p || typeof p.enc !== "string" || p.pre !== pre.hash) return NextResponse.json({ ok: false, error: "no_setup" }, { status: 409 });
  const opened = openStaffSecret(p);
  if (!opened || !(await staffTotpOnce(staff.email, opened.secret, code))) return badCode();
  const { codes, rc } = newRecoveryCodes();
  const saved = await withStaffLock(staff.email, async (s) => {
    if (!s || s.disabled || !s.passHash) return false;
    if (s.totp) endStaffSessions(s);
    s.totp = { enc: p.enc, kid: p.kid, at: new Date().toISOString() };
    s.rc = rc;
    await saveStaff(s);
    return true;
  });
  if (!saved) return startAgain();
  await Promise.all([db.del(enrolKey(staff.email)), staffTryAccepted(req, staff.email)]);
  await openAfterCode(staff, pre.hash);
  await adminAudit({ actor: staff.email, via: "staff", section: "system", action: "staff.enrol", target: staff.email, what: "staff:enrol" });
  return NextResponse.json({ ok: true, codes });
}
