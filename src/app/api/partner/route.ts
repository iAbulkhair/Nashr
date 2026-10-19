import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { allow, retryLater } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { saveBank } from "@/lib/partners";
import { acct } from "@/lib/account-id";

/**
 * PUT /api/partner {holder, iban, country, taxNumber?, vatRegistered?}: the partner's own payout details, where commission
 * is paid (rules 399, 411). The owner only ("partner.bank", refused while a founder impersonates), throttled per account,
 * and only for an approved partner. Partners must live in Saudi Arabia for now (rule 1471, `country_closed`): the IBAN is checked for its country's length (when
 * known) and checksum, `country` is the partner's country of residence, `taxNumber` an optional VAT or tax registration
 * number and `vatRegistered` the partner's own answer that they are VAT-registered (only `true` counts, and it needs the
 * number: vat_number_required). The answer carries the IBAN masked, and none of it is ever logged.
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "partner.bank");
  if (no) return no;
  if (!(await allow(`partnerbank:${u.email}`, 10, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { holder?: unknown; iban?: unknown; country?: unknown; taxNumber?: unknown; vatRegistered?: unknown };
  const res = await saveBank(acct(u), { holder: b.holder, iban: b.iban, country: b.country, taxNumber: b.taxNumber, vatRegistered: b.vatRegistered });
  if (!res.ok) return NextResponse.json(res, { status: res.error === "not_partner" ? 404 : 400 });
  return NextResponse.json(res);
}
