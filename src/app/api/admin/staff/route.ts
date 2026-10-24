import { NextResponse, after } from "next/server";
import { adminActor, viaOf } from "@/lib/auth";
import { mailReady, sendEmail } from "@/lib/notify";
import { globalKey } from "@/lib/keys";
import { appOrigin } from "@/lib/origin";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, cleanReason, reasonRefused } from "@/lib/admin-audit";
import { INVITE_TTL, OWNERS_LOCK, SETUP_TTL, STAFF_ROLES, getStaff, issueSetupCode, listStaff, otherActiveOwner, saveStaff, sha, staffEmail, withStaffLock, type StaffRole } from "@/lib/staff";
import { endStaffSessions } from "@/lib/staff-session";
import { actorOf, cleanName, freshCodeRefusal, isStaffOwner, lastOwner, secretJson, staffView, withNamedLock } from "@/lib/staff-admin";
import { alertFoundersKeyStaff, type KeyStaffAction } from "@/lib/staff-alert";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
/** Invites per inviting owner per hour, and per IP per hour (rule 3707). */
const INVITES_PER_OWNER = 10, INVITES_PER_IP = 20, INVITE_WINDOW = 60 * 60;

/** The invite mail (rule 3706): the code only in the link's fragment, which no browser sends to a server. */
function inviteMail(lang: "ar" | "en", name: string, role: StaffRole, link: string): { subject: string; text: string } {
  if (lang === "ar") {
    const r = role === "owner" ? "مالك" : "دعم (قراءة فقط)";
    return {
      subject: "دعوة إلى لوحة موظفي ذكين",
      text: `مرحبًا ${name}،\n\nدُعيت إلى لوحة موظفي ذكين بدور: ${r}.\nافتح هذا الرابط، واكتب بريدك، واختر كلمة مرور، ثم أعدّ تطبيق المصادقة:\n\n${link}\n\nالرابط يعمل مرة واحدة خلال 24 ساعة. لا تشاركه مع أحد. إن لم تكن تتوقع هذه الدعوة فتجاهلها.`,
    };
  }
  const r = role === "owner" ? "owner" : "support (read-only)";
  return {
    subject: "Your invite to the Thakeen staff console",
    text: `Hello ${name},\n\nYou were invited to the Thakeen staff console as: ${r}.\nOpen this link, type your email, choose a password, then set up an authenticator app:\n\n${link}\n\nThe link works once within 24 hours. Do not share it. If you did not expect this invite, ignore it.`,
  };
}

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
 *   disable { email }                       staff owner only; never oneself, never the last active owner
 *   enable  { email }                       staff owner, or the break-glass key session when no active owner is left
 *   reset   { email }                       staff owner (never oneself), or the break-glass key session when no other
 *                                           active owner exists (rule 1643): the person's password, authenticator and
 *                                           recovery codes are void at once, and a reset code is answered once
 *   role    { email, role }                 staff owner only; never one's own, never the last active owner
 *   invite  { email, name, role, lang }     staff owner only (rule 3706): `owner` or `support`; the record is created
 *                                           without a password and an invite link is mailed, single use, valid 24
 *                                           hours, the code only in the link's fragment and only its hash stored.
 *                                           10 per owner and 20 per IP per hour (rule 3707). When mail is not set up
 *                                           or the send fails, the link is answered once (no-store) to hand over.
 * The key session needs the console code enrolled and typed (403 `console_code_required`), and every reset or enable it
 * does mails the founders (`ADMIN_EMAILS`, src/lib/staff-alert.ts). Disable, enable, role and reset run under
 * `lock:staff:owners` with their last-owner and other-owner checks (rule 1659). Disable, reset and a role change end
 * every session and step-up of that person (`sessionsAfter`, rule 1635). The `x-admin-key` header and the founder's
 * customer session never manage staff.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const info = actorOf(req, who);
  if (!info) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; email?: unknown; name?: unknown; role?: unknown; reason?: unknown; code?: unknown; lang?: unknown };
  const action = typeof b.action === "string" ? b.action : "";
  if (!["create", "invite", "disable", "enable", "reset", "role"].includes(action)) return bad("unknown_action");
  const byKey = info.via === "key";
  const keyMayDo = byKey && (action === "reset" || action === "enable");
  if (!isStaffOwner(info) && !keyMayDo) return bad(info.via === "staff" || byKey ? "staff_owner_only" : "staff_only", 403);
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = staffEmail(b.email);
  if (!email) return bad("bad_email");
  const notFresh = await freshCodeRefusal(req, info, b.code);
  if (notFresh) return notFresh;
  const reason = cleanReason(b.reason);
  const log = (act: string, what: string, extra: { before?: unknown; after?: unknown } = {}) =>
    adminAudit({ actor: who, via: viaOf(req), section: "system", action: act, target: email, what, reason, ...extra });

  if (action === "invite") {
    const name = cleanName(b.name);
    if (!name) return bad("name_required");
    const role = STAFF_ROLES.find((r) => r === b.role);
    if (!role) return bad("bad_role");
    const [perOwner, perIp] = await Promise.all([
      allow(globalKey.staffInviteBucket(sha(who)), INVITES_PER_OWNER, INVITE_WINDOW),
      allow(globalKey.staffInviteIpBucket(clientIp(req)), INVITES_PER_IP, INVITE_WINDOW),
    ]);
    if (!perOwner || !perIp) return retryLater({ ok: false, error: "slow_down" }, INVITE_WINDOW);
    const created = await withStaffLock(email, async (s) => {
      if (s) return false;
      await saveStaff({ email, name, role, passHash: "", createdAt: new Date().toISOString(), createdBy: who });
      return true;
    });
    if (!created) return bad("exists", 409);
    const code = await issueSetupCode(email, who, "invite");
    const lang = b.lang === "en" ? "en" : "ar";
    const link = `${appOrigin()}/${lang}/admin/login/setup#invite=${code}`;
    const m = inviteMail(lang, name, role, link);
    const mailed = mailReady() ? await sendEmail(email, m.subject, m.text).catch(() => false) : false;
    await log("staff.invite", `staff:invite ${email} (${role})`, { after: { email, name, role, mailed } });
    return mailed ? secretJson({ ok: true, email, mailed: true, expiresIn: INVITE_TTL }) : secretJson({ ok: true, email, mailed: false, link, expiresIn: INVITE_TTL });
  }

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

  if ((action === "disable" || action === "role" || action === "reset") && email === who) return bad("not_self");
  const role = action === "role" ? STAFF_ROLES.find((r) => r === b.role) : undefined;
  if (action === "role" && !role) return bad("bad_role");

  // One lock for every change to who can manage staff: the checks below and the write they guard cannot interleave with
  // another request's (two owners disabling each other at once would otherwise leave none).
  type Out = { error: string; status: number } | { before?: StaffRole; code?: string };
  const out = await withNamedLock<Out>(OWNERS_LOCK, async () => {
    if (!(await getStaff(email))) return { error: "unknown_staff", status: 404 };
    if (byKey && (await otherActiveOwner(email))) return { error: "owner_active", status: 409 };
    if ((action === "disable" || (action === "role" && role !== "owner")) && (await lastOwner(email))) return { error: "last_owner", status: 409 };
    if (action === "disable" || action === "enable") {
      const disabled = action === "disable";
      await withStaffLock(email, async (s) => {
        if (!s) return;
        if (disabled) { s.disabled = true; endStaffSessions(s); }
        else delete s.disabled;
        await saveStaff(s);
      });
      return {};
    }
    if (action === "role") {
      let before: StaffRole | undefined;
      await withStaffLock(email, async (s) => {
        if (!s) return;
        before = s.role;
        s.role = role!;
        endStaffSessions(s);
        await saveStaff(s);
      });
      return { before };
    }
    // reset: the old password, authenticator and recovery codes stop working now, not when the code is redeemed.
    const voided = await withStaffLock(email, async (s) => {
      if (!s || s.disabled) return false;
      s.passHash = "";
      delete s.totp;
      delete s.rc;
      endStaffSessions(s);
      await saveStaff(s);
      return true;
    });
    if (!voided) return { error: "disabled", status: 409 };
    return { code: await issueSetupCode(email, who, "reset") };
  });
  if ("error" in out) return bad(out.error, out.status);
  if (byKey) after(() => alertFoundersKeyStaff(action as KeyStaffAction, email));

  if (action === "disable" || action === "enable") {
    await log(`staff.${action}`, `staff:${action} ${email}`, { after: { disabled: action === "disable" } });
    return NextResponse.json({ ok: true });
  }
  if (action === "role") {
    await log("staff.role", `staff:role ${email} ${out.before ?? "?"} -> ${role}`, { before: { role: out.before ?? null }, after: { role } });
    return NextResponse.json({ ok: true });
  }
  await log("staff.reset", `staff:reset ${email}`);
  return secretJson({ ok: true, email, code: out.code, expiresIn: SETUP_TTL });
}
