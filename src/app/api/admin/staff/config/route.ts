import { NextResponse } from "next/server";
import { adminActor, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, cleanReason, reasonRefused } from "@/lib/admin-audit";
import { db } from "@/lib/db";
import { STAFF_CONFIG, customerPathOff, getStaff, staffConfig } from "@/lib/staff";
import { actorOf, freshCodeRefusal, isStaffOwner } from "@/lib/staff-admin";

export const dynamic = "force-dynamic";

/**
 * Close the old door at runtime (rule 1650): POST { customerPathOff: true, reason, code }. From then on the founder's
 * customer session no longer opens the console (`adminActor`, `isAdminCookie`). Only a staff owner signed in through a
 * staff session with an enrolled authenticator, with a reason and a FRESH code: so the switch can never lock the founder
 * out, and the key path stays. Refused for the key, the header and the founder's customer session. Off only: turning it
 * back on is not offered (the contract release removes the path, rule 1651).
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const info = actorOf(req, who);
  if (!info || !isStaffOwner(info)) return NextResponse.json({ ok: false, error: "staff_owner_only" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { customerPathOff?: unknown; reason?: unknown; code?: unknown };
  if (b.customerPathOff !== true) return NextResponse.json({ ok: false, error: "off_only" }, { status: 400 });
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const me = await getStaff(who);
  if (!me?.totp) return NextResponse.json({ ok: false, error: "staff_owner_only" }, { status: 403 });
  const notFresh = await freshCodeRefusal(req, info, b.code);
  if (notFresh) return notFresh;
  if (await customerPathOff()) return NextResponse.json({ ok: true, already: true });
  const at = new Date().toISOString();
  await db.set(STAFF_CONFIG, { ...(await staffConfig()), customerPathOff: { at, by: who } });
  await adminAudit({
    actor: who,
    via: viaOf(req),
    section: "system",
    action: "console.customerPathOff",
    target: "console",
    what: "console: the founder's customer session no longer opens the console",
    after: { customerPathOff: { at, by: who } },
    reason: cleanReason(b.reason),
  });
  return NextResponse.json({ ok: true });
}
