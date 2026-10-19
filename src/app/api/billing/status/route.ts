import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { paymentsEnabled } from "@/lib/payments";
import { billingView, lastCheckout } from "@/lib/billing";
import { acct } from "@/lib/account-id";

/** Reads per account and hour: the return page asks every few seconds for about a minute, so a few returns fit easily. */
const STATUS_PER_HOUR = 240;

/**
 * GET /api/billing/status (rule 1155): how the account's latest online checkout went, for the page Paymob sends the
 * owner back to, and the subscription as the billing page shows it. Read only: it starts, charges and changes nothing.
 * The account is the session's (`u.email`); the checkout is found through the account's own pointer, never a ref from
 * the request. Owner (`billing`), as the billing page's pay controls; a founder viewing the account may read it.
 * While Paymob is not configured (production today) it answers `enabled: false` and reads nothing.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "billing");
  if (no) return no;
  if (!(await allow(`billingstatus:${u.email}`, STATUS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (!paymentsEnabled()) return NextResponse.json({ ok: true, enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const last = await lastCheckout(acct(u));
  return NextResponse.json({ ok: true, enabled: true, plan: u.plan, checkout: last, billing: billingView(u.billing) }, { headers: { "Cache-Control": "no-store" } });
}
