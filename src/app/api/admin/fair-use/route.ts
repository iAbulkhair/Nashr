import { NextResponse } from "next/server";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { accountByLogin, adminActor, normalizeEmail, saveUser } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { monthKey, withUserLock } from "@/lib/credits";
import { fairUseOf } from "@/lib/fair-use";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/fair-use {email, action: "lift" | "clear", reason} (rule 1730): the founder lifts an account's fair-use
 * pause for the current UTC month (src/lib/fair-use.ts), or puts it back. `lift` writes `User.fairUseLift` = {month, at,
 * by}, which counts for that month only, so the stop applies again on the 1st without anyone clearing it; `clear` deletes
 * it. Founder only (`adminActor`, 401), then the second factor (`secondFactorRefusal`, rule 1376), then a reason of 3 to
 * 200 characters (rule 1185); written under the account's lock and logged (`section` users, `action` fair_use_lift or
 * fair_use_clear) with the state before and after. No key is built from the body but the account's own `user:{email}`,
 * its lock and its two usage counters.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; action?: unknown; reason?: unknown };
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  if (!email) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (b.action !== "lift" && b.action !== "clear") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const action = b.action;
  const month = monthKey();
  type Lift = { month: string; at: string; by: string } | null;
  let done: { before: Lift; after: Lift; user: Parameters<typeof fairUseOf>[0] };
  // The address names the account; the lock and the save use its id (rule 1982).
  const account = await accountByLogin(email);
  if (!account) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  try {
    done = await withUserLock(acct(account), async (u) => {
      const before = u.fairUseLift ?? null;
      if (action === "lift") u.fairUseLift = { month, at: new Date().toISOString(), by: who };
      else delete u.fairUseLift;
      await saveUser(u);
      return { before, after: u.fairUseLift ?? null, user: u };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "user_not_found") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    throw e;
  }
  await adminAudit({ actor: who, section: "users", action: `fair_use_${action}`, target: email, what: `fair_use_${action} ${email} ${month}`, before: done.before, after: done.after, reason: b.reason });
  const s = await fairUseOf(done.user, month).catch(() => null);
  return NextResponse.json(
    { ok: true, fairUse: { email, month, lifted: done.after?.month === month, paused: s?.paused ?? null, costSar: s?.costSar ?? null, limitSar: s?.limitSar ?? null } },
    { headers: { "cache-control": "no-store" } },
  );
}
