import { NextResponse } from "next/server";
import { adminActor, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, cleanReason, reasonRefused } from "@/lib/admin-audit";
import { SETUP_TTL, STAFF_ROLES, getStaff, issueSetupCode, listStaff, saveStaff, staffEmail, withStaffLock, type StaffRole } from "@/lib/staff";
import { endStaffSessions } from "@/lib/staff-session";
import { actorOf, cleanName, freshCodeRefusal, isStaffOwner, lastOwner, secretJson, staffView } from "@/lib/staff-admin";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * Staff management (rules 1635-1640, docs/system/permissions.md section 1.7).
 *
 * GET: the staff list, for a staff owner or the break-glass key session. Never the password hash, the sealed secret or
 * the recovery hashes.
 */
export async function GET(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const info = actorOf(req, who);
  if (!isStaffOwner(info) && info?.via !== "key") return bad("staff_owner_only", 403);
  const staff = await listStaff();
  return NextResponse.json({ ok: true, staff: staff.map(staffView) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST { action, email, reason, code, ... }. Every action needs a reason and a FRESH code (rule 1636): the person's own
 * authenticator code for a staff owner, the console code for the key session.
 *   create  { email, name, role: "owner" }  staff owner only; phase 1 creates owners only (rule 1637); answers a setup
 *                                           code once (30 minutes, single use), handed over in person (rule 1640)
 *   disable { email }                       staff owner only; never oneself, never the last enabled owner
 *   enable  { email }                       staff owner only
 *   reset   { email }                       staff owner, or the break-glass key session when nobody else can (rule 1643):
 *                                           a reset code once; the person sets a new password and enrols again
 *   role    { email, role }                 staff owner only; never one's own, never the last enabled owner
 * Disable, reset and a role change end every session and step-up of that person (`sessionsAfter`, rule 1635).
 * The `x-admin-key` header and the founder's customer session never manage staff.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const info = actorOf(req, who);
  if (!info) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; email?: unknown; name?: unknown; role?: unknown; reason?: unknown; code?: unknown };
  const action = typeof b.action === "string" ? b.action : "";
  if (!["create", "disable", "enable", "reset", "role"].includes(action)) return bad("unknown_action");
  const keyMayDo = action === "reset" && info.via === "key";
  if (!isStaffOwner(info) && !keyMayDo) return bad(info.via === "staff" || info.via === "key" ? "staff_owner_only" : "staff_only", 403);
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = staffEmail(b.email);
  if (!email) return bad("bad_email");
  const notFresh = await freshCodeRefusal(req, info, b.code);
  if (notFresh) return notFresh;
  const reason = cleanReason(b.reason);
  const log = (act: string, what: string, extra: { before?: unknown; after?: unknown } = {}) =>
    adminAudit({ actor: who, via: viaOf(req), section: "system", action: act, target: email, what, reason, ...extra });

  if (action === "create") {
    const name = cleanName(b.name);
    if (!name) return bad("name_required");
    if (b.role !== "owner") return bad("role_owner_only");
    const created = await withStaffLock(email, async (s) => {
      if (s) return false;
      await saveStaff({ email, name, role: "owner", passHash: "", createdAt: new Date().toISOString(), createdBy: who });
      return true;
    });
    if (!created) return bad("exists", 409);
    const code = await issueSetupCode(email, who, "setup");
    await log("staff.create", `staff:create ${email} (owner)`, { after: { email, name, role: "owner" } });
    return secretJson({ ok: true, email, code, expiresIn: SETUP_TTL });
  }

  if ((action === "disable" || action === "role") && email === who) return bad("not_self");
  if (!(await getStaff(email))) return bad("unknown_staff", 404);
  if ((action === "disable" || (action === "role" && b.role !== "owner")) && (await lastOwner(email))) return bad("last_owner", 409);

  if (action === "disable" || action === "enable") {
    const disabled = action === "disable";
    await withStaffLock(email, async (s) => {
      if (!s) return;
      s.disabled = disabled;
      if (disabled) endStaffSessions(s);
      else delete s.disabled;
      await saveStaff(s);
    });
    await log(`staff.${action}`, `staff:${action} ${email}`, { after: { disabled } });
    return NextResponse.json({ ok: true });
  }

  if (action === "role") {
    const role = STAFF_ROLES.find((r) => r === b.role);
    if (!role) return bad("bad_role");
    let before: StaffRole | null = null;
    await withStaffLock(email, async (s) => {
      if (!s) return;
      before = s.role;
      s.role = role;
      endStaffSessions(s);
      await saveStaff(s);
    });
    await log("staff.role", `staff:role ${email} ${before ?? "?"} -> ${role}`, { before: { role: before }, after: { role } });
    return NextResponse.json({ ok: true });
  }

  // reset
  const target = await withStaffLock(email, async (s) => {
    if (!s || s.disabled) return null;
    endStaffSessions(s);
    await saveStaff(s);
    return s;
  });
  if (!target) return bad("disabled", 409);
  const code = await issueSetupCode(email, who, "reset");
  await log("staff.reset", `staff:reset ${email}`);
  return secretJson({ ok: true, email, code, expiresIn: SETUP_TTL });
}
