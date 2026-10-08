import { db } from "../db";
import { clean } from "../perf-import";
import { pmap } from "../parallel";
import { sumRead, type N } from "../figures";
import { composioRead } from "../connectors/composio";
import { accountOf, at, isComposio, listOf } from "../connectors/composio-shape";
import type { Connection } from "../connectors/store";
import type { PlatformPart, Range, SocialPost, Totals } from "../social-stats";
import { DAY_MS, EMPTY_TOTALS, SOCIAL_PUB_KEY, beforeDeadline, count, dateOf, day, rangeBefore, refused, settle, splitDays } from "./common";

/**
 * The Facebook Page's results (rule 739, spec 2026-10-08-social-analytics-reports B1): the Page chosen for publishing
 * (`meta.pageId`, set at connect from the Pages the owner manages), read through the Composio Facebook toolkit with
 * constant metrics and fields. Read only: the catalog lists these three tools as reads and nothing here posts, replies or
 * edits. The page id comes only from the stored connection, never from a request; captions are the owner's or the
 * public's text, cleaned and capped. `fields` never names `access_token`.
 */

const DAYS = 28;
const MAX_POSTS = 30;
const FB_METRICS = "page_media_view,page_total_media_view_unique,page_post_engagements,page_total_actions,page_follows,page_daily_follows_unique,page_daily_unfollows_unique";
const FB_POST_FIELDS = "id,message,created_time,permalink_url,status_type,from,shares,reactions.summary(true),comments.summary(true)";
/** The only two post metrics Meta still serves; likes, comments and shares come from the post's own fields. */
const FB_POST_METRICS = "post_media_view,post_total_media_view_unique";
const NAMES = new Set(FB_METRICS.split(","));
/** A page post's id: the page's and the post's numbers (`123_456`), as Graph and publishing return it. */
const POST_ID = /^\d{1,30}(?:_\d{1,30})?$/;
const TYPES: Record<string, string> = { added_photos: "IMAGE", added_video: "VIDEO", shared_story: "LINK" };
/** Graph's refusal when the app does not hold the `read_insights` permission the Page's insights need. */
const NO_INSIGHTS = /read_insights/i;

/** A Composio Meta record with the Facebook part and the Page chosen for publishing (digits only). */
export function holdsFb(c: Connection | null | undefined): boolean {
  return !!(c && isComposio(c) && c.data.facebook && /^\d+$/.test(c.meta?.pageId ?? ""));
}

/** Only a post page on facebook.com or www.facebook.com over https. A link with a query string is dropped, not cut: a cut photo.php link opens nothing. */
export function fbUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    const host = u.hostname === "facebook.com" || u.hostname === "www.facebook.com";
    return u.protocol === "https:" && host && !u.port && !u.search ? u.origin + u.pathname : null;
  } catch {
    return null;
  }
}

/**
 * The day a daily value covers. Meta stamps it with the end of the Page's day (`end_time`, midnight in the Page's time
 * zone), so 12 hours earlier falls inside that day for any time zone from UTC-11 to UTC+12. "" when there is no stamp.
 */
function fbDay(v: unknown): string {
  const ms = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? day(new Date(ms - 12 * 36e5)) : "";
}

type Row = { day: string; name: string; value: N };
const sum = (rows: Row[], name: string) => sumRead(rows.filter((r) => r.name === name).map((r) => r.value));
/** One period's Page totals: each metric is the sum over the days Meta answered for, null when no day carried it. */
function totalsOf(rows: Row[]): Totals {
  return {
    ...EMPTY_TOTALS,
    views: sum(rows, "page_media_view"),
    reach: sum(rows, "page_total_media_view_unique"),
    engagements: sum(rows, "page_post_engagements"),
    clicks: sum(rows, "page_total_actions"),
    followsGained: sum(rows, "page_daily_follows_unique"),
    followsLost: sum(rows, "page_daily_unfollows_unique"),
  };
}

/** Each metric's value by name, from `values[0].value` or `total_value.value`, through `count`. */
function postMetrics(r: unknown): Record<string, N> {
  const out: Record<string, N> = {};
  for (const row of listOf(r, "name")) out[String(row.name)] = count(at(row, "values.0.value", "total_value.value"));
  return out;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "");

/**
 * The Page's last 28 whole days and the 28 before them (rule 733): 56 days of daily insights in one call (Meta allows
 * 90), asked from midnight UTC 56 days back to midnight today, split here by day; followers are the last daily
 * `page_follows`. Its own posts created inside the window, at most 30, each with its lifetime views and reach. `deadline`
 * is the shared one (rule 741): every call checks it first.
 *
 * A refused token ends the read. Insights refused for want of `read_insights` are the known `fb_no_insights`. Any other
 * failure of one side leaves its figures null or its posts empty and the part stands; both failing is a failed read.
 */
export async function readFacebook(scope: string, c: Connection, now: Date, deadline: number): Promise<PlatformPart> {
  const acc = accountOf(c, "facebook");
  const pageId = c.meta?.pageId ?? "";
  if (!/^\d+$/.test(pageId)) throw new Error("not_connected");
  const ask = async (slug: string, args: Record<string, unknown>) => {
    beforeDeadline(deadline);
    return composioRead(scope, "facebook", slug, args, acc);
  };
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window: Range = { from: day(new Date(end - DAYS * DAY_MS)), to: day(new Date(end - DAY_MS)) };
  const [insights, list, mine] = await Promise.all([
    settle(ask("FACEBOOK_GET_PAGE_INSIGHTS", { page_id: pageId, metrics: FB_METRICS, period: "day", since: day(new Date(end - 2 * DAYS * DAY_MS)), until: day(new Date(end)) })),
    settle(ask("FACEBOOK_GET_PAGE_POSTS", { page_id: pageId, fields: FB_POST_FIELDS, limit: MAX_POSTS })),
    db.smembers(SOCIAL_PUB_KEY(scope)),
  ]);
  for (const r of [list, insights]) if (!r.ok && refused(r.error)) throw r.error;
  if (!insights.ok && NO_INSIGHTS.test(message(insights.error))) throw new Error("fb_no_insights");
  if (!insights.ok && !list.ok) throw insights.error;

  const rows: Row[] = (insights.ok ? listOf(insights.value, "name") : [])
    .filter((m) => NAMES.has(String(m.name)))
    .flatMap((m) => (Array.isArray(m.values) ? m.values : []).map((x): Row => ({ day: fbDay(at(x, "end_time")), name: String(m.name), value: count(at(x, "value")) })));
  const { cur, prev } = splitDays(rows, window);
  // Rows Meta answered that fall in neither period (no stamp, another range) are not summed: said once, never guessed.
  if (rows.length && !cur.length && !prev.length) console.warn("fb_no_day_rows");
  // Stable sort: of two values for one day, the later one stands.
  const follows = rows.filter((r) => r.name === "page_follows" && r.value != null).sort((a, b) => a.day.localeCompare(b.day));
  const before = totalsOf(prev);

  // The feed also holds visitors' and tagged posts, and its own date filter reads the updated time: only the Page's own
  // posts created inside the window are kept.
  const posts = (list.ok ? listOf(list.value) : [])
    .filter((row) => POST_ID.test(String(row.id)) && String(at(row, "from.id") ?? "") === pageId)
    .filter((row) => { const d = dateOf(row.created_time); return d >= window.from && d <= window.to; })
    .slice(0, MAX_POSTS);
  const ours = new Set(mine);
  // Each post's views and reach. A refused token ends the read and the other workers ask nothing more; a timeout, a rate
  // limit, the deadline or any other failure leaves that post's two figures null.
  let stop = false;
  const views = await pmap(posts, async (row): Promise<Record<string, N>> => {
    if (stop) return {};
    try {
      return postMetrics(await ask("FACEBOOK_GET_POST_INSIGHTS", { post_id: String(row.id), metrics: FB_POST_METRICS, period: "lifetime" }));
    } catch (e) {
      if (refused(e)) { stop = true; throw e; }
      return {};
    }
  }, 4);
  return {
    platform: "facebook",
    account: clean(c.meta?.pageName ?? "", 80) || `Page ${pageId}`,
    range: window,
    followers: follows.length ? follows[follows.length - 1].value : null,
    totals: totalsOf(cur),
    // Only days Meta answered for the earlier 28: a Page with none (new, or insights not yet kept) has no prev.
    ...(Object.values(before).some((v) => v != null) ? { prev: { range: rangeBefore(window), totals: before } } : {}),
    posts: posts.map((row, i): SocialPost => ({
      id: String(row.id),
      date: dateOf(row.created_time),
      type: TYPES[String(row.status_type)] ?? "POST",
      caption: clean(typeof row.message === "string" ? row.message : "", 80),
      url: fbUrl(row.permalink_url),
      views: views[i].post_media_view ?? null,
      reach: views[i].post_total_media_view_unique ?? null,
      likes: count(at(row, "reactions.summary.total_count")),
      comments: count(at(row, "comments.summary.total_count")),
      shares: count(at(row, "shares.count")),
      saved: null,
      fromThakeen: ours.has(String(row.id)),
    })),
  };
}
