import { NextResponse } from "next/server";
import { paymentsEnabled } from "@/lib/payments";
import { publicSeats } from "@/lib/founding";
import { allow, clientIp, retryLater } from "@/lib/rate";

export const dynamic = "force-dynamic";

/**
 * GET /api/founding/seats (rule 1711): the founding seats left, for the pricing page. Public, no session, rate limited
 * per IP. `{ open: false }` before the sale starts, while online payment is off, and once no seat is left: a number is
 * shown only while it is the real count and above zero. Never an email or any account detail.
 */
export async function GET(req: Request) {
  if (!(await allow(`foundingseats:ip:${clientIp(req)}`, 60, 60))) return retryLater({ ok: false, error: "slow_down" }, 60);
  const seats = await publicSeats(paymentsEnabled());
  return NextResponse.json({ ok: true, ...seats }, { headers: { "Cache-Control": "public, max-age=30" } });
}
