import { NextResponse } from "next/server";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { activeProvider } from "@/lib/payments";
import { handleGeideaCallback } from "@/lib/billing";
import { readCapped } from "@/lib/read-capped";
import { log } from "@/lib/log";

/** An order callback is a few kilobytes. Anything larger is not from Geidea. */
const MAX_BODY_BYTES = 64 * 1024;
const HOOK_PER_IP = { max: 240, windowS: 60 };

/**
 * Geidea's order callback, for a payment and for a refund (src/lib/billing.ts, rules 3900-3917). Public: no cookie is
 * read and nothing is trusted before the signature inside the body (HMAC-SHA256 under the API password over the amount,
 * currency, order id, status, our reference and the timestamp, compared with `sameSecret`) matches. The account and the
 * amount come from our own intent, found by our random reference; the order's amount, currency, test flag and agreement
 * must agree with it or nothing is applied. Exactly once per order. 404 unless Geidea is the chosen provider.
 */
export async function POST(req: Request) {
  if (activeProvider() !== "geidea") return NextResponse.json({ ok: false }, { status: 404 });
  // Per IP only: a global bucket spent before the signature check would let anyone starve real callbacks.
  if (!(await allow("geideahook:" + clientIp(req), HOOK_PER_IP.max, HOOK_PER_IP.windowS))) return retryLater({ ok: false, error: "slow_down" }, HOOK_PER_IP.windowS);
  let body: unknown;
  try {
    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  try {
    const r = await handleGeideaCallback(body);
    return NextResponse.json({ ok: r.status < 400, result: r.result }, { status: r.status });
  } catch (e) {
    // Every step is idempotent on the order id: a callback Geidea sends again, or the reconciliation, finishes it.
    log.error("geidea webhook", e);
    return NextResponse.json({ ok: false, error: "retry" }, { status: 500 });
  }
}
