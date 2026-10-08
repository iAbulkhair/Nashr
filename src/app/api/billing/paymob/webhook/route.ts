import { NextResponse } from "next/server";
import { allow, clientIp } from "@/lib/rate";
import { paymobConfig } from "@/lib/paymob";
import { handlePaymobCallback } from "@/lib/billing";
import { readCapped } from "@/lib/read-capped";

/** A transaction or card-token callback is a few kilobytes. Anything larger is not from Paymob. */
const MAX_BODY_BYTES = 64 * 1024;
const HOOK_PER_IP = { max: 240, windowS: 60 };

/**
 * Paymob's transaction and card-token callbacks (src/lib/billing.ts, rules 700-729). Public: no cookie is read and
 * nothing is trusted before the HMAC (SHA-512 over the documented fields, `?hmac=`) matches. The account and the amount
 * come from our own intent, found by our random reference; the callback's amount, currency and order must agree with it
 * or nothing is applied. Exactly once per transaction id. 404 while Paymob is not configured.
 */
export async function POST(req: Request) {
  if (!paymobConfig()) return NextResponse.json({ ok: false }, { status: 404 });
  // Per IP only: a global bucket spent before the HMAC check would let anyone starve real callbacks.
  if (!(await allow(`paymobhook:${clientIp(req)}`, HOOK_PER_IP.max, HOOK_PER_IP.windowS))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  let body: unknown;
  try {
    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  try {
    const r = await handlePaymobCallback(body, new URL(req.url).searchParams.get("hmac"));
    return NextResponse.json({ ok: r.status < 400, result: r.result }, { status: r.status });
  } catch (e) {
    // Paymob retries a failed callback; every step is idempotent on the transaction id.
    console.error("paymob webhook", e instanceof Error ? e.name : "error");
    return NextResponse.json({ ok: false, error: "retry" }, { status: 500 });
  }
}
