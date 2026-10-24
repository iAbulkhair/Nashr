import { NextResponse } from "next/server";
import { adminActor, sessionAccountForConsole, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, cleanReason, reasonRefused } from "@/lib/admin-audit";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { OWNERS_LOCK, SETUP_TTL, getStaff, issueSetupCode, ownerExists, saveStaff, staffEmail } from "@/lib/staff";
import { actorOf, cleanName, secretJson, withNamedLock } from "@/lib/staff-admin";
import { founderPasskeyOptions, founderStepUpRefusal } from "@/lib/staff-founder";
import { setStaffSetupCookie } from "@/lib/staff-session";

export const dynamic = "force-dynamic";

/**
 * The first staff login (rules 1639, 3700, 3701, docs/system/flows.md section 71). POST { email, name, reason }.
 *
 * Two ways in, never the `x-admin-key` header or a staff session (403 `key_session_only`):
 *
 *  - The founder's own customer session (rule 3700, amending 1639; the founder signed in as themselves, not a member,
 *    not impersonating): only with a proof made for THIS request (`code`: 6 digits from the console authenticator or
 *    the founder's two-step sign-in, or `passkey`: a response to `{action:"passkey-options"}`), never a step-up still
 *    open from earlier. `email` defaults to the founder's own. The setup code is not shown: it goes into the setup
 *    hand-off cookie (HttpOnly, SameSite=Strict, 30 minutes, rule 3701) and the answer says `next: "setup"`, so the
 *    setup screen asks only for the password. The customer session itself never becomes a staff session (rule 1630).
 *  - The key session (break-glass, rule 1639 as before; the write gate asks for the console code once it is enrolled):
 *    the setup code is answered ONCE, valid 30 minutes, single use, typed into /{lang}/admin/login/setup.
 *
 * Only while no ACTIVE owner exists (rule 1659): once one does, 409 `exists` for everyone. Writes `staff:{email}` (role
 * `owner`, no password yet). No email is sent.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (await ownerExists()) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  const via = actorOf(req, who)?.via;
  if (via !== "key" && via !== "founder-session") return NextResponse.json({ ok: false, error: "key_session_only" }, { status: 403 });
  const founder = via === "founder-session" ? await sessionAccountForConsole() : null;
  if (via === "founder-session") {
    const foreign = consoleWriteRefusal(req);
    if (foreign) return foreign;
    if (!founder) return NextResponse.json({ ok: false }, { status: 401 });
  } else {
    const no2fa = await secondFactorRefusal(req, who);
    if (no2fa) return no2fa;
  }
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; email?: unknown; name?: unknown; reason?: unknown; code?: unknown; passkey?: unknown };
  if (founder && b.action === "passkey-options") return founderPasskeyOptions(founder);
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = staffEmail(b.email ?? (founder ? founder.actor?.email : undefined));
  if (!email) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  const name = cleanName(b.name);
  if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  if (founder) {
    const refused = await founderStepUpRefusal(req, founder, { code: b.code, passkey: b.passkey });
    if (refused) return refused;
  }
  const by = founder ? who : "key";
  const code = await withNamedLock(OWNERS_LOCK, async () => {
    if ((await ownerExists()) || (await getStaff(email))) return null;
    await saveStaff({ email, name, role: "owner", passHash: "", createdAt: new Date().toISOString(), createdBy: by });
    return issueSetupCode(email, by, "setup");
  });
  if (!code) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  await adminAudit({
    actor: who,
    via: viaOf(req),
    section: "system",
    action: "staff.bootstrap",
    target: email,
    what: `staff:bootstrap ${email} (owner)`,
    after: { email, name, role: "owner" },
    reason: cleanReason(b.reason),
  });
  if (founder) {
    await setStaffSetupCookie(code, SETUP_TTL);
    return secretJson({ ok: true, email, next: "setup", expiresIn: SETUP_TTL });
  }
  return secretJson({ ok: true, email, code, expiresIn: SETUP_TTL });
}
