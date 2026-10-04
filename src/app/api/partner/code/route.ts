import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { claimPartnerCode } from "@/lib/partners";

/**
 * POST /api/partner/code {code}: the billing page's partner-code field (rule 393). The owner only ("billing"), throttled
 * per account. Only an account still on its trial, never attributed and never paid takes a code; its own code, or that of
 * a partner on either team, is refused. The account keeps its one first-month offer: discounts never stack.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "billing");
  if (no) return no;
  if (!(await allow(`partnerclaim:${u.email}`, 10, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { code?: unknown };
  const res = await claimPartnerCode(u, b.code);
  if (!res.ok) return NextResponse.json(res, { status: res.error === "bad_partner_code" || res.error === "self_referral" ? 400 : 409 });
  return NextResponse.json(res);
}
