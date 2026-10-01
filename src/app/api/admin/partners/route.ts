import { NextResponse } from "next/server";
import { adminActor, isAdmin } from "@/lib/auth";
import { CAPS, pushCapped } from "@/lib/db";
import { approvePartner, listApplications, listPartners, recordPayout, rejectApplication } from "@/lib/partners";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/partners: the founder console's Partners tab (rules 390, 398, 400). Applications from the public form
 * with their decision and a suggested code, and every partner with referrals, balances, commissions, payouts and bank
 * details in full: the IBAN is shown here and nowhere else.
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const [applications, partners] = await Promise.all([listApplications(), listPartners()]);
  return NextResponse.json({ ok: true, applications, partners });
}

/**
 * POST /api/admin/partners
 *   {action:"approve", email, name?, code, appId?}  claim a unique code and link it to the applicant's email
 *   {action:"reject", appId}
 *   {action:"payout", email, amountSar, date, reference?}  mark a bank transfer paid; only a payable balance (SAR 200 or
 *   more) is paid down, never past it, under the partner's lock
 * Every change is written to admin:log with the acting founder; bank details never are.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const log = (email: string, what: string) => pushCapped("admin:log", JSON.stringify({ actor: who, email, what, at: new Date().toISOString() }), CAPS.adminLog);
  if (b.action === "approve") {
    const res = await approvePartner({ email: b.email, name: b.name, code: b.code, appId: b.appId }, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "already_partner" || res.error === "code_taken" || res.error === "member_login" ? 409 : 400 });
    await log(res.partner.email, `partner:approve code:${res.partner.code}`);
    return NextResponse.json(res);
  }
  if (b.action === "reject") {
    if (!(await rejectApplication(b.appId, who))) return NextResponse.json({ ok: false, error: "bad_app" }, { status: 400 });
    await log(String(b.appId), "partner:reject");
    return NextResponse.json({ ok: true });
  }
  if (b.action === "payout") {
    const email = typeof b.email === "string" ? b.email : "";
    const res = await recordPayout(email, { amountSar: b.amountSar, date: b.date, reference: b.reference }, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "not_found" ? 404 : 400 });
    await log(email, `partner:payout sar:${res.payout.sar} date:${res.payout.date}`);
    return NextResponse.json(res);
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
