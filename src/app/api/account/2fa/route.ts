import { NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth";
import { checkMfaCode, confirmMfaSetup, mfaActive, mfaStatus, removeMfa, renewMfaRecovery, startMfaSetup } from "@/lib/mfa";
import { actingLogin, ownPasswordMatches } from "@/lib/own-password";
import { allow, giveBack, retryLater, WINDOW } from "@/lib/rate";
import { forbid } from "@/lib/roles";

/** Wrong passwords per login and hour on this route (as POST /api/account/sessions, rule 1170). */
const PASSWORD_TRIES_PER_HOUR = 10;

/**
 * The acting login's own two-step sign-in (rules 1930-1937, docs/system/flows.md "Customer two-step sign-in").
 * GET: whether it is on and how many recovery codes are left; `recommended` is true for the owner.
 * POST {action}:
 *   start {password}: a new secret and its otpauth address, shown once as a QR code; nothing is enrolled yet.
 *   confirm {code}: a code from the new secret turns it on and returns the eight recovery codes, shown only now.
 *   recovery {password, code}: eight new recovery codes replace the old ones (the authenticator's code only).
 *   disable {password, code}: turns it off (the authenticator's code or one recovery code).
 *
 * Owner or member, each for their OWN login (`actingLogin`); refused while a founder impersonates (`mfa.manage`). Every
 * step that changes it needs the login's own password: a stolen cookie can neither turn it off nor enrol the thief's
 * phone. The password limit counts wrong ones only (`allow` before the compare, `giveBack` after a right one).
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, ...(await mfaStatus(me.email, me.bornAt)), recommended: me.kind === "owner" });
}

async function passwordRefusal(u: User, login: string, password: unknown): Promise<NextResponse | null> {
  const bucket = `mfapw:${login}`;
  if (!(await allow(bucket, PASSWORD_TRIES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (!(await ownPasswordMatches(u, password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await giveBack(bucket);
  return null;
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "mfa.manage");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; password?: unknown; code?: unknown };

  if (b.action === "start") {
    const pw = await passwordRefusal(u, me.email, b.password);
    if (pw) return pw;
    if (await mfaActive(me.email, me.bornAt)) return NextResponse.json({ ok: false, error: "already_on" }, { status: 409 });
    const { secret, uri } = await startMfaSetup(me.email);
    return NextResponse.json({ ok: true, secret, uri });
  }
  if (b.action === "confirm") {
    if (await mfaActive(me.email, me.bornAt)) return NextResponse.json({ ok: false, error: "already_on" }, { status: 409 });
    const done = await confirmMfaSetup(req, me.email, b.code);
    return done.ok ? NextResponse.json({ ok: true, codes: done.codes }) : done.res;
  }
  if (b.action === "recovery" || b.action === "disable") {
    const pw = await passwordRefusal(u, me.email, b.password);
    if (pw) return pw;
    if (!(await mfaActive(me.email, me.bornAt))) return NextResponse.json({ ok: false, error: "not_on" }, { status: 409 });
    // New recovery codes need the authenticator itself: a leaked recovery code must not mint eight more.
    const code = await checkMfaCode(req, me.email, me.bornAt, b.code, { recovery: b.action === "disable" });
    if (!code.ok) return code.res;
    if (b.action === "disable") {
      await removeMfa(me.email);
      return NextResponse.json({ ok: true });
    }
    const codes = await renewMfaRecovery(me.email, me.bornAt);
    return codes ? NextResponse.json({ ok: true, codes }) : NextResponse.json({ ok: false, error: "not_on" }, { status: 409 });
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
