import { NextResponse } from "next/server";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { readCapped } from "@/lib/read-capped";
import { isShopHookTopic, recordCompliance, validShopifyWebhook } from "@/lib/connectors/shopify-compliance";

/** A compliance payload is a store, a customer and a list of order ids: a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024;
const HOOK_PER_IP = { max: 120, windowS: 60 };

/**
 * Shopify's mandatory compliance webhooks, one URL for all three topics and for `app/uninstalled` (rules 2168-2171, 2203;
 * src/lib/connectors/shopify-compliance.ts). Public: no cookie is read and nothing is trusted before
 * `X-Shopify-Hmac-Sha256` matches the raw body under SHOPIFY_CLIENT_SECRET; Shopify's review expects 401 otherwise,
 * including while the secret is unset. A verified delivery answers 200 so Shopify stops retrying; a store write that
 * fails answers 500 so it retries.
 */
export async function POST(req: Request) {
  // Per IP only, as the Paymob callback: a global bucket spent before the HMAC check would let anyone starve real deliveries.
  // A bucket name, not a key: `allow` builds the key with globalKey.rate.
  if (!(await allow("shopifyhook:ip:" + clientIp(req), HOOK_PER_IP.max, HOOK_PER_IP.windowS))) return retryLater({ ok: false, error: "slow_down" }, HOOK_PER_IP.windowS);
  const raw = await readCapped(req, MAX_BODY_BYTES).catch(() => null);
  if (raw === null) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  if (!validShopifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"), process.env.SHOPIFY_CLIENT_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const topic = req.headers.get("x-shopify-topic");
  // Signed by Shopify but not a topic we take (a webhook added to this URL by mistake): acknowledged, nothing kept.
  if (!isShopHookTopic(topic)) return NextResponse.json({ ok: true, ignored: true });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  try {
    // The event's own time, not the receipt's (rule 2244): a retry after the owner connected again keeps the old time.
    if (!(await recordCompliance(topic, body, new Date(), req.headers.get("x-shopify-triggered-at")))) return NextResponse.json({ ok: false, error: "bad_shop" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("shopify compliance", e instanceof Error ? e.name : "error");
    return NextResponse.json({ ok: false, error: "retry" }, { status: 500 });
  }
}
