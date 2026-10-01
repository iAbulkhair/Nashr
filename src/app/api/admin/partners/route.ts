import { NextResponse } from "next/server";
import { adminActor, isAdmin } from "@/lib/auth";
import { CAPS, pushCapped } from "@/lib/db";
import { approvePartner, confirmBank, listApplications, listPartners, recordPayout, rejectApplication, voidPayout } from "@/lib/partners";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/partners: the founder console's Partners tab (rules 390, 398, 400, 412, 414). Applications from the
 * public form with their decision, a suggested code and the terms consent (date and version), and every partner with
 * referrals, balances, commissions, payouts, tax flags and totals, and bank details in full: the IBAN is shown here and
 * nowhere else.
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const [applications, partners] = await Promise.all([listApplications(), listPartners()]);
  return NextResponse.json({ ok: true, applications, partners });
}

/**
 * POST /api/admin/partners
 *   {action:"approve", email, name?, code, appId?, consentOutOfBand?}  claim a unique code and link it to the applicant's
 *   email. Refused (no_consent, 400) unless the application `appId` of that email recorded consent to the terms, or the
 *   founder states with `consentOutOfBand: true` that the applicant agreed outside the form; the consent is carried onto
 *   the partner record and the log line says which (rule 415)
 *   {action:"reject", appId}
 *   {action:"payout", email, id?, amountSar, vatSar?, whtSar?, date, reference?}  mark a bank transfer paid; only a payable
 *   balance (SAR 200 or more) is paid down, never past it, to confirmed bank details, under the partner's lock; a retried
 *   id records once. `amountSar` is the commission; `vatSar` the VAT paid on top to a VAT-registered partner and `whtSar`
 *   the withholding tax Thakeen bore, both optional and for the books only: they never change the balance (rule 412)
 *   {action:"void_payout", email, id, reason?}  a payout entered by mistake: kept on record, its amount back in the balance
 *   {action:"confirm_bank", email, savedAt}  the founder checked the bank details with the partner out of band (by phone,
 *   from the application); `savedAt` names the version seen, so details changed since then stay unconfirmed
 * Every change is written to admin:log with the acting founder; bank details never are.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const log = (email: string, what: string) => pushCapped("admin:log", JSON.stringify({ actor: who, email, what, at: new Date().toISOString() }), CAPS.adminLog);
  if (b.action === "approve") {
    const res = await approvePartner({ email: b.email, name: b.name, code: b.code, appId: b.appId, consentOutOfBand: b.consentOutOfBand }, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "already_partner" || res.error === "code_taken" || res.error === "member_login" ? 409 : 400 });
    await log(res.partner.email, `partner:approve code:${res.partner.code} terms:${res.partner.terms?.via ?? "none"}`);
    return NextResponse.json(res);
  }
  if (b.action === "reject") {
    if (!(await rejectApplication(b.appId, who))) return NextResponse.json({ ok: false, error: "bad_app" }, { status: 400 });
    await log(String(b.appId), "partner:reject");
    return NextResponse.json({ ok: true });
  }
  if (b.action === "payout") {
    const email = typeof b.email === "string" ? b.email : "";
    const res = await recordPayout(email, { id: b.id, amountSar: b.amountSar, vatSar: b.vatSar, whtSar: b.whtSar, date: b.date, reference: b.reference }, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "not_found" ? 404 : res.error === "bank_unconfirmed" ? 409 : 400 });
    const taxes = `${res.payout.vatSar ? ` vat:${res.payout.vatSar}` : ""}${res.payout.whtSar ? ` wht:${res.payout.whtSar}` : ""}`;
    if (!res.already) await log(email, `partner:payout ${res.payout.id} sar:${res.payout.sar}${taxes} date:${res.payout.date}`);
    return NextResponse.json(res);
  }
  if (b.action === "void_payout") {
    const email = typeof b.email === "string" ? b.email : "";
    const res = await voidPayout(email, b.id, who, b.reason);
    if (!res.ok) return NextResponse.json(res, { status: 404 });
    await pushCapped("admin:log", JSON.stringify({ actor: who, email, what: `partner:payout ${res.payout.id} void sar:${res.payout.sar}`, reason: res.payout.voidReason, at: new Date().toISOString() }), CAPS.adminLog);
    return NextResponse.json(res);
  }
  if (b.action === "confirm_bank") {
    const email = typeof b.email === "string" ? b.email : "";
    const res = await confirmBank(email, b.savedAt, who);
    if (!res.ok) return NextResponse.json(res, { status: res.error === "not_found" ? 404 : 409 });
    await log(email, "partner:bank confirm");
    return NextResponse.json(res);
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
