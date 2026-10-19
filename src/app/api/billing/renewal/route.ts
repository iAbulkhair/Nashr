import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { paymentsEnabled } from "@/lib/payments";
import { setRenewal } from "@/lib/billing";
import { acct } from "@/lib/account-id";

/**
 * POST {action: "cancel" | "resume" | "remove_card"}: the owner's renewal settings for the online subscription
 * (src/lib/billing.ts, rules 700-729). Cancel stops the automatic charge (the paid month runs out, then the account is
 * locked after the grace days); resume needs a saved card; remove_card deletes the saved card token. Owner only
 * (`billing.pay`), never while the founder impersonates. 404 while Paymob is not configured.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "billing.pay");
  if (no) return no;
  if (!paymentsEnabled()) return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 404 });
  if (!(await allow(`payrenewal:${u.email}`, 30, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { action?: unknown };
  const r = await setRenewal(acct(u), b?.action);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "bad_action" ? 400 : 409 });
  return NextResponse.json({ ok: true, billing: r.billing });
}
