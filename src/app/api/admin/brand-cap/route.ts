import { NextResponse } from "next/server";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminActor, normalizeEmail, saveUser } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { activeCount, listBrands } from "@/lib/brands";
import { brandCapFor, isBrandCap } from "@/lib/pricing";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/brand-cap {email, brandCap, reason} (rule 1393): the founder sets how many brands an account may have
 * active, mostly for Agency accounts (founder decision 2026-10-09: "agency is set per customer"). `brandCap` is a whole
 * number from 1 to 200 (`isBrandCap`), or null / 0 to go back to the plan's number (src/lib/pricing.ts `brandCapFor`).
 * Founder only (`adminActor`: the founder's session or the console key), a reason of 3 to 200 characters (rule 1185),
 * written under the account's lock and logged with the number before and after. Lowering the cap below the account's
 * active brands archives nothing: it only stops new adds and restores (rule 1391).
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; brandCap?: unknown; reason?: unknown };
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  if (!email) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  const clear = b.brandCap === null || b.brandCap === 0;
  if (!clear && !isBrandCap(b.brandCap)) return NextResponse.json({ ok: false, error: "bad_brand_cap" }, { status: 400 });
  type Cap = { cap: number; override: number | null };
  let done: { before: Cap; after: Cap };
  try {
    done = await withUserLock(email, async (u) => {
      const before = { cap: brandCapFor(u), override: u.brandCap ?? null };
      if (clear) delete u.brandCap;
      else u.brandCap = b.brandCap as number;
      await saveUser(u);
      return { before, after: { cap: brandCapFor(u), override: u.brandCap ?? null } };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "user_not_found") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    throw e;
  }
  const active = activeCount(await listBrands(email));
  await adminAudit({ actor: who, section: "users", action: "brand_cap", target: email, what: `brand_cap ${email} ${done.before.cap}→${done.after.cap}`, before: done.before, after: done.after, reason: b.reason });
  return NextResponse.json({ ok: true, user: { email, brandCap: done.after.cap, brandCapOverride: done.after.override, activeBrands: active } });
}
