import { NextResponse } from "next/server";
import { createSession, currentUser, normalizeEmail, validEmail, type User } from "@/lib/auth";
import { revokeAllDevices } from "@/lib/devices";
import { confirmEmailChange, pendingEmailChange, startEmailChange } from "@/lib/email-change";
import { actingLogin, ownPasswordMatches } from "@/lib/own-password";
import { allow, giveBack, retryLater, WINDOW } from "@/lib/rate";
import { isPersonLockTimeout } from "@/lib/person";
import { isTeamLockTimeout } from "@/lib/team";
import { forbid } from "@/lib/roles";
import { verifySendRefusal } from "@/lib/verify-email";
import { OPAQUE_IDS } from "@/lib/account-id";
import { checkMfaCode, mfaActive } from "@/lib/mfa";

/** Wrong passwords per login and hour on this route (as the two-step and device routes). */
const PASSWORD_TRIES_PER_HOUR = 10;
/** Codes asked per login and hour, whatever the address: each one is a mail and five guesses. */
const STARTS_PER_HOUR = 5;

/**
 * Change the sign-in address of the acting login (rules 1942-1945, docs/system/flows.md "Changing the sign-in address").
 * GET: the address waiting for its code, if any.
 * POST {action}:
 *   start {password, email}: checks the password and the new address, and mails a code to the new address.
 *   confirm {code}: the code moves the login; every session ends, this device gets a new one, the old address a notice.
 *
 * Owner or member, each for their OWN login (`actingLogin`); refused while a founder impersonates (`email.change`).
 * Starting needs the login's password, so a stolen cookie alone cannot take the account to the thief's mailbox. The
 * new address also passes the code-send limits every verification mail does (`verifySendRefusal`).
 *
 * Account-id R2, D2 (rule 2745, `OPAQUE_IDS` on): a login with two-step sign-in on also gives its authenticator code (or
 * a recovery code) to start, `mfaCode`; without it the answer is 401 `mfa_required`. The move in place carries the whole
 * account, so a stolen password alone must not start it.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "email.change");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, email: me.email, pending: await pendingEmailChange(me.email) });
}

async function passwordRefusal(u: User, login: string, password: unknown): Promise<NextResponse | null> {
  const bucket = `emailpw:${login}`;
  if (!(await allow(bucket, PASSWORD_TRIES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (!(await ownPasswordMatches(u, password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await giveBack(bucket);
  return null;
}

const STATUS: Record<string, number> = { invalid_email: 400, same_email: 400, taken: 409, owner_has_data: 409, partner: 409, limit: 429, expired: 400, wrong: 400, locked: 400, not_found: 404 };

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "email.change");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; password?: unknown; email?: unknown; code?: unknown; mfaCode?: unknown };
  const lang = u.lang === "en" ? "en" : "ar";

  if (b.action === "start") {
    const pw = await passwordRefusal(u, me.email, b.password);
    if (pw) return pw;
    if (OPAQUE_IDS && (await mfaActive(me.email, me.bornAt))) {
      if (b.mfaCode === undefined || b.mfaCode === "") return NextResponse.json({ ok: false, error: "mfa_required" }, { status: 401 });
      const code = await checkMfaCode(req, me.email, me.bornAt, b.mfaCode, { recovery: true });
      if (!code.ok) return code.res;
    }
    if (!(await allow(`emailchange:start:${me.email}`, STARTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
    const to = normalizeEmail(typeof b.email === "string" ? b.email : "");
    if (!validEmail(to)) return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
    const send = await verifySendRefusal(to, req);
    if (send) return send;
    const r = await startEmailChange(u, { kind: me.kind, email: me.email, pid: me.pid }, to, lang);
    if (!r.ok) return NextResponse.json(r, { status: STATUS[r.error] ?? 400 });
    if (!r.sent && !r.devCode) return NextResponse.json({ ok: false, error: "mail_failed" }, { status: 502 });
    return NextResponse.json({ ok: true, pending: r.to, ...(r.devCode ? { devCode: r.devCode } : {}) });
  }
  if (b.action === "confirm") {
    // A member's address move takes both persons' locks (`moveMemberLogin`, multi-workspace M1) and an owner's move holds
    // the account's `lock:team` (`moveOwnerLogin`): a timeout on either is a 409 with nothing moved.
    let r: Awaited<ReturnType<typeof confirmEmailChange>>;
    try {
      r = await confirmEmailChange(u, { kind: me.kind, email: me.email, pid: me.pid }, b.code, lang);
    } catch (e) {
      if (isPersonLockTimeout(e) || isTeamLockTimeout(e) || (e instanceof Error && e.message === "user_lock_timeout")) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
      throw e;
    }
    if (!r.ok) return NextResponse.json(r, { status: STATUS[r.error] ?? 400 });
    // The old login's sessions are already dead (the record moved, with a fresh session window); its device list goes
    // too, and this device signs in again at the new address.
    await revokeAllDevices(me.email).catch(() => {});
    await createSession(r.to);
    return NextResponse.json({ ok: true, email: r.to });
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
