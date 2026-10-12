import { NextResponse } from "next/server";
import { adminActor, isAdmin } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { paymentsView, recordPayment, voidPayment } from "@/lib/partners";
import { refundPaymobPayment } from "@/lib/billing";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

/** GET /api/admin/payments/{email}: the account's recorded payments, first-month offer and partner attribution (rule 396). */
export async function GET(req: Request, ctx: { params: Promise<{ email: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const view = await paymentsView(decodeURIComponent((await ctx.params).email));
  if (!view) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...view });
}

/**
 * POST /api/admin/payments/{email}
 *   {action:"record", id?, amountSar, plan, date, reference?}  a payment received, SAR excluding VAT: the source of truth
 *   for commissions (rule 396). The first one uses the account's first-month offer; a retried id records nothing twice.
 *   {action:"void", id, reason?}  refunded or entered by mistake: voids its commission too (rule 397). A top-up pack's
 *   payment whose pack is still live is refused (409 topup_live, rule 455): it is voided with the pack, from the
 *   console's Top-ups block (POST /api/admin/topups "void").
 *   {action:"refund", id, reason?}  a payment taken online through Paymob (rules 700-729): the whole transaction is
 *   refunded at Paymob once, then the payment is voided as above (a pack's payment with its pack). 409 not_paymob for a
 *   payment recorded by hand, 502 paymob_refund_failed when Paymob refused (nothing is voided), 404 while Paymob is off.
 * A top-up's payment is never recorded here: "Add top-up" (POST /api/admin/topups) records it with the pack (rule 454).
 * The body's fields are passed one by one, so no request can mark a payment as a top-up's.
 * Either action re-takes every commission decision of the account (a backdated payment or a voided first payment moves
 * the first payment day); payments whose answer changed are logged as `reclassified`.
 * Recording a payment does not change the plan: activation stays POST /api/admin/plan. Every change goes to admin:log.
 */
export async function POST(req: Request, ctx: { params: Promise<{ email: string }> }) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const email = decodeURIComponent((await ctx.params).email);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const log = (what: string, reason?: string) => adminAudit({ actor: who, section: "billing", target: email, what, reason });
  if (b.action === "record") {
    const res = await recordPayment(email, { id: b.id, amountSar: b.amountSar, plan: b.plan, date: b.date, reference: b.reference }, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "not_found" ? 404 : 400 });
    const p = res.payment;
    if (!res.already) await log(`payment:${p.id} sar:${p.amountSar} plan:${p.plan} date:${p.date}${p.offer ? ` offer:${p.offer}` : ""}${p.commission ? ` commission:${p.commission.sar}` : p.notCounted ? ` not_counted:${p.notCounted}` : ""}${res.reclassified ? ` reclassified:${res.reclassified.join(",")}` : ""}`);
    return NextResponse.json(res);
  }
  if (b.action === "void") {
    // The void form asks a reason (rule 1185). "record" and "refund" have no reason form yet, so theirs stays optional.
    const noReason = reasonRefused(b.reason);
    if (noReason) return noReason;
    const res = await voidPayment(email, b.id, who, b.reason);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "topup_live" ? 409 : 404 });
    await log(`payment:${res.payment.id} void${res.reclassified ? ` reclassified:${res.reclassified.join(",")}` : ""}`, res.payment.voidReason);
    return NextResponse.json(res);
  }
  if (b.action === "refund") {
    const res = await refundPaymobPayment(email, b.id, who, b.reason);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "not_paymob" || res.error === "busy" ? 409 : res.error === "paymob_refund_failed" ? 502 : 404 });
    await log(`paymob_refund payment:${res.payment.id}${res.alreadyRefunded ? " already_refunded" : ""}${res.planEnded ? " plan_ended" : ""}`, res.payment.voidReason);
    return NextResponse.json(res);
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
