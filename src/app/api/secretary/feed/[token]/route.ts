import { FEED_TOKEN, resolveFeed } from "@/lib/feed-token";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { buildIcs, feedHolds, feedItems } from "@/lib/secretary-feed";
import { getBrand } from "@/lib/brand";
import { zoneOf } from "@/lib/zones";
import { appOrigin } from "@/lib/origin";

/**
 * GET: one login's private calendar feed (Reem phase 3 B1), what a calendar app subscribes to. No session: the random
 * token in the path is the credential, a founder-approved narrow exception to "no secret in a URL" (spec section 6). One
 * trailing `.ics` is stripped. A value of the wrong shape is a 404 before any rate count or store read. Then, in order:
 * 120 an hour per client IP, the record (`resolveFeed`), 60 an hour per link, and the validity check (`feedHolds`: the
 * login still active and the scope still one of its account's active brands). Items are read with the record's own scope
 * only, never a value from the request. Every failure is the same empty 404, so a probe learns nothing, except the two
 * rate refusals: both are 429 with `Retry-After`, and the per-link one shows a holder of a live token that the record
 * exists (a named, accepted exception). Writes only the rate counters and `listOpenItems`' removal of ghost ids from the
 * open set; nothing else.
 */
const PER_IP_HOUR = 120;
const PER_LINK_HOUR = 60;
const notFound = () => new Response(null, { status: 404 });
const tooMany = () => retryLater(null, 3600);

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: raw } = await ctx.params;
  const token = typeof raw === "string" && raw.endsWith(".ics") ? raw.slice(0, -4) : raw;
  if (typeof token !== "string" || !FEED_TOKEN.test(token)) return notFound();
  if (!(await allow(`feed:ip:${clientIp(req)}`, PER_IP_HOUR, 3600))) return tooMany();
  const found = await resolveFeed(token);
  if (!found) return notFound();
  if (!(await allow(`feed:t:${found.hash}`, PER_LINK_HOUR, 3600))) return tooMany();
  const { rec } = found;
  if (!(await feedHolds(rec))) return notFound();
  const now = Date.now();
  const [items, brand] = await Promise.all([feedItems(rec.scope, now), getBrand(rec.scope)]);
  const body = buildIcs(items, { lang: rec.lang === "en" ? "en" : "ar", zone: zoneOf(brand), origin: appOrigin(), now });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
