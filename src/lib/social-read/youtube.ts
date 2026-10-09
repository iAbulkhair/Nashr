import { db } from "../db";
import { clean } from "../perf-import";
import { sumRead, type N } from "../figures";
import { composioRead } from "../connectors/composio";
import { accountOf, at, findKey, isComposio, listOf } from "../connectors/composio-shape";
import type { Connection } from "../connectors/store";
import type { Range, ReadPart, SocialPost, Totals } from "../social-stats";
import { DAY_MS, EMPTY_TOTALS, ISO_DAY, SOCIAL_PUB_KEY, anyAboveZero, beforeDeadline, count, dateOf, day, late, message, rangeBefore, refused, settle, splitDays } from "./common";

/**
 * The YouTube channel's results (rule 740, spec 2026-10-08-social-analytics-reports B2): the channel the owner connected
 * (`meta.channelId`, set at connect from the channel the login owns), read through the Composio YouTube toolkit with
 * constant metrics and parts. Read only: the catalog lists these four tools as reads and nothing here uploads, comments
 * or edits. No channel id is ever sent: the analytics ask for `channel==MINE` and the lists for `mine`, the login's own
 * channel; the stored id only picks the subscriber count out of the answer. Titles are the owner's text, cleaned and capped.
 */

const DAYS = 28;
const MAX_POSTS = 30;
const YT_METRICS = "views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,subscribersLost";
const METRIC_NAMES = YT_METRICS.split(",");
/**
 * The channel id check, the same at connect (via-composio.ts) and in the report sources (report-sources.ts): UC and 10 to
 * 40 more letters, digits, - or _ (YouTube's are 22 today; the bound keeps a stored id short).
 */
export const CHANNEL_ID = /^UC[\w-]{10,40}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/**
 * Google's refusal of the analytics for want of `yt-analytics.readonly` (insufficient scopes, 403, forbidden) or with the
 * API not enabled for the app. The adapter keeps such a refusal's text and never makes 403 its status (composio.ts statusOf).
 */
const NO_ANALYTICS = /\b403\b|forbidden|insufficient|permission|scope|has not been used|disabled/i;

/** A Composio YouTube record with the channel chosen at connect (a UC channel id). */
export function holdsYt(c: Connection | null | undefined): boolean {
  return !!(c && isComposio(c) && c.data.youtube && CHANNEL_ID.test(c.meta?.channelId ?? ""));
}

/** A video's watch page on www.youtube.com, built from its id; null for anything that is not a video id. */
export function ytUrl(id: string): string | null {
  return VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** The first array under `key`, breadth-first, at most five levels down: Composio wraps Google's answer in its own keys. */
const arrayAt = (o: unknown, key: string): unknown[] => (findKey(o, [key], Array.isArray) as unknown[] | undefined) ?? [];

type DayRow = { day: string; v: Record<string, N> };
/**
 * The analytics table's rows, each by day with its metrics through `count`. A row is read by its column headers' names;
 * without headers, in the order YouTube documents (the dimension, then the metrics as asked); a row sent as an object is
 * read by name.
 */
function dayRows(r: unknown): DayRow[] {
  const heads = arrayAt(r, "columnHeaders").map((h) => String(at(h, "name") ?? ""));
  const cols = heads.length ? heads : ["day", ...METRIC_NAMES];
  return arrayAt(r, "rows").map((row) => {
    const get = (k: string) => (Array.isArray(row) ? row[cols.indexOf(k)] : at(row, k));
    const d = get("day");
    return { day: typeof d === "string" ? d : "", v: Object.fromEntries(METRIC_NAMES.map((m) => [m, count(get(m))])) };
  });
}

/** One period's channel totals: each metric is the sum over the days YouTube answered for, null when no day carried it. */
function totalsOf(rows: DayRow[]): Totals {
  const sum = (m: string) => sumRead(rows.map((r) => r.v[m]));
  return {
    ...EMPTY_TOTALS,
    views: sum("views"),
    watchMinutes: sum("estimatedMinutesWatched"),
    likes: sum("likes"),
    comments: sum("comments"),
    shares: sum("shares"),
    followsGained: sum("subscribersGained"),
    followsLost: sum("subscribersLost"),
  };
}

/** A listed upload's video id: the playlist item's `resourceId`, or a search result's `id.videoId`. */
function videoIdOf(row: unknown): string {
  const v = at(row, "snippet.resourceId.videoId", "contentDetails.videoId", "id.videoId", "videoId", "id");
  return typeof v === "string" && VIDEO_ID.test(v) ? v : "";
}

/**
 * The channel's last 28 whole days and the 28 before them (rule 733): 56 days of daily analytics in one call, from 56
 * days before today's UTC midnight to yesterday (YouTube's end date is inclusive), split here by day; its subscribers on
 * the read date; and its uploads published inside the window, at most 30 of the latest, with each video's public counts.
 * `deadline` is the shared one (rule 741): every call checks it first.
 *
 * A refused token ends the read. Analytics refused for want of their scope keep the public counts and add the known
 * `yt_no_analytics` beside the part; any other failure of one side leaves its figures null or its videos empty and the
 * part stands. Nothing read at all is a failed read.
 */
export async function readYoutube(scope: string, c: Connection, now: Date, deadline: number): Promise<ReadPart> {
  const acc = accountOf(c, "youtube");
  const channelId = c.meta?.channelId ?? "";
  if (!CHANNEL_ID.test(channelId)) throw new Error("not_connected");
  const ask = async (slug: string, args: Record<string, unknown>) => {
    beforeDeadline(deadline);
    return composioRead(scope, "youtube", slug, args, acc);
  };
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window: Range = { from: day(new Date(end - DAYS * DAY_MS)), to: day(new Date(end - DAY_MS)) };
  const startDate = day(new Date(end - 2 * DAYS * DAY_MS));
  // The dates are built here, never taken from a request; checked anyway before they are sent.
  if (!ISO_DAY.test(startDate) || !ISO_DAY.test(window.to)) throw new Error("read_failed");
  const [stats, report, list, mine] = await Promise.all([
    settle(ask("YOUTUBE_LIST_CHANNELS", { part: "statistics", mine: true, maxResults: 1 })),
    settle(ask("YOUTUBE_QUERY_ANALYTICS", { ids: "channel==MINE", startDate, endDate: window.to, metrics: YT_METRICS, dimensions: "day" })),
    settle(ask("YOUTUBE_LIST_CHANNEL_VIDEOS", { mine: true, part: "snippet", maxResults: MAX_POSTS })),
    db.smembers(SOCIAL_PUB_KEY(scope)),
  ]);
  for (const r of [stats, report, list]) if (!r.ok && refused(r.error)) throw r.error;
  if (!stats.ok && !report.ok && !list.ok) throw stats.error;
  const noAnalytics = !report.ok && !late(report.error) && NO_ANALYTICS.test(message(report.error));

  // Subscribers only from the stored channel's row; a count the owner hides is not read. The login answers for its own
  // channel (mine, channel==MINE): rows none of which is the stored channel mean the analytics and uploads are another
  // channel's, so the read fails with a code (not a known state). Alone, nothing is written and the last snapshot stands;
  // beside another part, this part is dropped and its error code is written (history kept).
  const channels = stats.ok ? listOf(stats.value, "statistics") : [];
  const channel = channels.find((row) => row.id === channelId);
  if (channels.length && !channel) throw new Error("yt_other_channel");
  const followers = channel && at(channel, "statistics.hiddenSubscriberCount") !== true ? count(at(channel, "statistics.subscriberCount")) : null;

  const rows = report.ok ? dayRows(report.value) : [];
  const { cur, prev } = splitDays(rows, window);
  // Rows YouTube answered that fall in neither period (no date, another range) are not summed: said once, never guessed.
  if (rows.length && !cur.length && !prev.length) console.warn("yt_no_day_rows");
  const before = totalsOf(prev);

  // The latest uploads, then their counts in one call. Only videos the answer gives back for the ids asked, published
  // inside the window and not private (Thakeen's own uploads stay private until the owner publishes them) are kept.
  const ids = [...new Set((list.ok ? listOf(list.value, "snippet") : []).map(videoIdOf).filter(Boolean))].slice(0, MAX_POSTS);
  let videos: Record<string, unknown>[] = [];
  if (ids.length) {
    try {
      const got = listOf(await ask("YOUTUBE_GET_VIDEO_DETAILS_BATCH", { id: ids, parts: ["snippet", "statistics", "status"] }));
      videos = ids.map((id) => got.find((v) => v.id === id)).filter((v): v is Record<string, unknown> => !!v);
    } catch (e) {
      if (refused(e)) throw e;
    }
  }
  const ours = new Set(mine);
  const posts = videos
    .filter((v) => { const d = dateOf(at(v, "snippet.publishedAt")); return d >= window.from && d <= window.to; })
    .filter((v) => at(v, "status.privacyStatus") !== "private")
    .map((v): SocialPost => {
      const id = String(v.id);
      const title = at(v, "snippet.title");
      return {
        id,
        date: dateOf(at(v, "snippet.publishedAt")),
        type: "VIDEO",
        caption: clean(typeof title === "string" ? title : "", 80),
        url: ytUrl(id),
        views: count(at(v, "statistics.viewCount")),
        reach: null,
        likes: count(at(v, "statistics.likeCount")),
        comments: count(at(v, "statistics.commentCount")),
        shares: null,
        saved: null,
        fromThakeen: ours.has(id),
      };
    });
  return {
    platform: "youtube",
    account: clean(c.meta?.account ?? "", 80) || clean(`Channel ${channelId}`, 80),
    range: window,
    followers,
    totals: totalsOf(cur),
    // Only days YouTube answered for the earlier 28 with a figure above 0: a channel with none, or only zeros (new, or
    // quiet then), has no prev.
    ...(anyAboveZero(before) ? { prev: { range: rangeBefore(window), totals: before } } : {}),
    posts,
    ...(noAnalytics ? { known: "yt_no_analytics" } : {}),
  };
}
