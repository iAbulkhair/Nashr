import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { paymentsEnabled } from "@/lib/payments";
import { startCheckout, type CheckoutError } from "@/lib/billing";

const STATUS: Record<CheckoutError, number> = {
  not_enabled: 404, bad_request: 400, bad_plan: 400, bad_pack: 400, bad_interval: 400, not_found: 404,
  agency: 409, topup_needs_paid_plan: 409, need_phone: 409, yearly_not_offered: 409, yearly_active: 409, paymob_error: 502, provider_error: 502,
};

/**
 * POST {kind: "plan", plan, interval?} | {kind: "topup", credits}: start an online payment through Paymob KSA
 * (src/lib/billing.ts, rules 700-729). Owner only (`billing.pay`), never while the founder impersonates. The amount comes
 * from the pricing table, never from the body; the account is the session's. Answers the unified checkout URL. 404 while
 * Paymob is not configured, so the pay links and WhatsApp stay the only way to pay. `interval` (rules 3531-3536):
 * absent or "month" as before; "year" only for a plan whose yearly price the founder set in src/lib/pricing.ts, else 409
 * `yearly_not_offered`; 409 `yearly_active` for another plan while a paid year runs; anything else 400 `bad_interval`.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "billing.pay");
  if (no) return no;
  if (!paymentsEnabled()) return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 404 });
  if (!(await allow(`paycheckout:${u.email}`, 10, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const body = await req.json().catch(() => null);
  const lang = body && typeof body === "object" && (body as { lang?: unknown }).lang === "en" ? "en" : body && typeof body === "object" && (body as { lang?: unknown }).lang === "ar" ? "ar" : u.lang;
  const r = await startCheckout(u, body, lang);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: STATUS[r.error] });
  return NextResponse.json({ ok: true, url: r.url });
}
