import { NextResponse } from "next/server";
import { adminActor, isAdmin } from "@/lib/auth";
import { CAPS, pushCapped } from "@/lib/db";
import { paymentsView, recordPayment, voidPayment } from "@/lib/partners";

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
 * A top-up's payment is never recorded here: "Add top-up" (POST /api/admin/topups) records it with the pack (rule 454).
 * The body's fields are passed one by one, so no request can mark a payment as a top-up's.
 * Either action re-takes every commission decision of the account (a backdated payment or a voided first payment moves
 * the first payment day); payments whose answer changed are logged as `reclassified`.
 * Recording a payment does not change the plan: activation stays POST /api/admin/plan. Every change goes to admin:log.
 */
export async function POST(req: Request, ctx: { params: Promise<{ email: string }> }) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const email = decodeURIComponent((await ctx.params).email);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const log = (what: string, reason?: string) => pushCapped("admin:log", JSON.stringify({ actor: who, email, what, reason: reason || undefined, at: new Date().toISOString() }), CAPS.adminLog);
  if (b.action === "record") {
    const res = await recordPayment(email, { id: b.id, amountSar: b.amountSar, plan: b.plan, date: b.date, reference: b.reference }, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "not_found" ? 404 : 400 });
    const p = res.payment;
    if (!res.already) await log(`payment:${p.id} sar:${p.amountSar} plan:${p.plan} date:${p.date}${p.offer ? ` offer:${p.offer}` : ""}${p.commission ? ` commission:${p.commission.sar}` : p.notCounted ? ` not_counted:${p.notCounted}` : ""}${res.reclassified ? ` reclassified:${res.reclassified.join(",")}` : ""}`);
    return NextResponse.json(res);
  }
  if (b.action === "void") {
    const res = await voidPayment(email, b.id, who, b.reason);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "topup_live" ? 409 : 404 });
    await log(`payment:${res.payment.id} void${res.reclassified ? ` reclassified:${res.reclassified.join(",")}` : ""}`, res.payment.voidReason);
    return NextResponse.json(res);
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
