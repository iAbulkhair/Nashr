import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { saveBank } from "@/lib/partners";

/**
 * PUT /api/partner {holder, iban}: the partner's own bank details, where commission is paid (rule 399). The owner only
 * ("partner.bank", refused while a founder impersonates), throttled per account, and only for an approved partner. The
 * IBAN must be a valid Saudi IBAN (checksum included); the answer carries it masked, and it is never logged.
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "partner.bank");
  if (no) return no;
  if (!(await allow(`partnerbank:${u.email}`, 10, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { holder?: unknown; iban?: unknown };
  const res = await saveBank(u.email, b.holder, b.iban);
  if (!res.ok) return NextResponse.json(res, { status: res.error === "not_partner" ? 404 : 400 });
  return NextResponse.json(res);
}
