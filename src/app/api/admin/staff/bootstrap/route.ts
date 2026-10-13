import { NextResponse } from "next/server";
import { adminActor, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, cleanReason, reasonRefused } from "@/lib/admin-audit";
import { OWNERS_LOCK, SETUP_TTL, getStaff, issueSetupCode, ownerExists, saveStaff, staffEmail } from "@/lib/staff";
import { actorOf, cleanName, secretJson, withNamedLock } from "@/lib/staff-admin";

export const dynamic = "force-dynamic";

/**
 * The first staff login (rule 1639, docs/system/flows.md section 71). POST { email, name, reason }.
 *
 * Only from a key session (the browser key form, which needs the console code once `admin:2fa` is enrolled, rule 1645),
 * never the `x-admin-key` header, a staff session or the founder's customer session; the write gate asks for the console
 * code when it is enrolled. Only while no ACTIVE owner exists (enabled, password set, authenticator enrolled: an owner
 * who never finished setup does not block it, rule 1659): once one does, 409 `exists` for everyone, key included. Writes
 * `staff:{email}` (role `owner`, no password yet) and answers a setup code ONCE, valid 30 minutes, single use, which the
 * founder types into /{lang}/admin/login/setup (never a URL). No email is sent.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (await ownerExists()) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  if (actorOf(req, who)?.via !== "key") return NextResponse.json({ ok: false, error: "key_session_only" }, { status: 403 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; name?: unknown; reason?: unknown };
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = staffEmail(b.email);
  if (!email) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  const name = cleanName(b.name);
  if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  const code = await withNamedLock(OWNERS_LOCK, async () => {
    if ((await ownerExists()) || (await getStaff(email))) return null;
    await saveStaff({ email, name, role: "owner", passHash: "", createdAt: new Date().toISOString(), createdBy: "key" });
    return issueSetupCode(email, "key", "setup");
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
  return secretJson({ ok: true, email, code, expiresIn: SETUP_TTL });
}
