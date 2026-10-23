import { NextResponse } from "next/server";
import { globalKey } from "@/lib/keys";
import { confirmSubscription } from "@/lib/newsletter";
import { allow, clientIp, retryLater } from "@/lib/rate";

/** Confirm and unsubscribe posts per IP per 15 minutes. */
const TRIES_PER_IP = 30;

/**
 * POST {token} → the double opt-in click (rules 3600-3609). The token is the one in the confirm mail's link fragment: 64
 * hex, single use, 48 hours, stored only as its SHA-256. Nothing is subscribed by loading the page (mail scanners open
 * links): the page's button posts here. Rate limited per IP; a bad, used, expired or superseded token is 400
 * `bad_token`, the same for each, and says nothing about the address.
 */
export async function POST(req: Request) {
  if (!(await allow(globalKey.newsletterTokenBucket(clientIp(req)), TRIES_PER_IP, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const b = (await req.json().catch(() => ({}))) as { token?: unknown };
  const r = await confirmSubscription(b.token);
  if (r === "bad_token") return NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });
  if (r === "busy") return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
