import { db } from "../db";
import { clean } from "../perf-import";
import { SCOPE_REFUSED, composioRead } from "../connectors/composio";
import { accountOf, findKey, isComposio, listOf } from "../connectors/composio-shape";
import type { Connection } from "../connectors/store";
import type { Range, ReadPart, SocialPost } from "../social-stats";
import { DAY_MS, EMPTY_TOTALS, ISO_DAY, SOCIAL_PUB_KEY, beforeDeadline, count, day, late, message, refused, settle } from "./common";

/**
 * The TikTok account's results (rule 742, spec 2026-10-08-social-analytics-reports C1): the account the owner connected
 * through Composio with Thakeen's own TikTok app, read with constant fields. Read only: the catalog lists these two tools
 * as reads and nothing here posts, comments or edits. No user or video id is ever sent: both tools act on the login's own
 * account. TikTok counts only over the account's lifetime, so its totals stay null and it has no previous period; a change
 * comes only from the monthly history (rule 746). Captions are the owner's text, cleaned and capped.
 */

const DAYS = 28;
const MAX_POSTS = 30;
const PAGE = 20;
/** The spec's constant fields. Only followers are kept: likes and videos are lifetime counts, not the window's. */
const TT_FIELDS = ["follower_count", "likes_count", "video_count"] as const;
/** TikTok's video id: digits (nineteen today), sent as a string. */
const VIDEO_ID = /^\d{1,30}$/;
/**
 * TikTok's refusal for want of `user.info.stats` or `video.list` (on the app or on this login): `scope_not_authorized`,
 * `scope_permission_missed`, or an insufficient or missing scope. The adapter may read such a text as 401 (composio.ts
 * statusOf), so it is checked first. The adapter's own pattern, so a text the client threw is read the same way.
 */
const NO_SCOPE = SCOPE_REFUSED;

/** A Composio TikTok record with its TikTok account. */
export function holdsTt(c: Connection | null | undefined): boolean {
  return !!(c && isComposio(c) && c.data.tiktok);
}

/**
 * A video's page on tiktok.com or www.tiktok.com over https, without its query string (TikTok's share links carry utm
 * tags) or its hash; null for anything else, a short link (vm.tiktok.com) included.
 */
export function ttUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.port || (u.hostname !== "tiktok.com" && u.hostname !== "www.tiktok.com")) return null;
  return `${u.origin}${u.pathname}`;
}

/** The first value under `key`, breadth-first, at most five levels down: Composio wraps TikTok's answer in its own keys. */
const valueAt = (o: unknown, key: string): unknown => findKey(o, [key]);

/** A video's id as TikTok sends it (a digit string, or a whole number), or "". */
function idOf(v: Record<string, unknown>): string {
  const id = v.id;
  if (typeof id === "string" && VIDEO_ID.test(id)) return id;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? String(id) : "";
}

/** The UTC day a video was created (`create_time` is in seconds), or "" when it is not a date. */
function createdDay(v: Record<string, unknown>): string {
  const s = count(v.create_time);
  if (s == null) return "";
  const d = new Date(s * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const out = day(d);
  return ISO_DAY.test(out) ? out : "";
}

/** The next page's cursor: a whole number above zero (a number or digits), else none. */
function cursorOf(r: unknown): number | null {
  const c = count(valueAt(r, "cursor"));
  return c != null && c > 0 && Number.isSafeInteger(c) ? c : null;
}

const noScope = (r: { ok: boolean; error?: unknown }) => !r.ok && !late(r.error) && NO_SCOPE.test(message(r.error));

/**
 * The account's followers on the read date and its public videos created inside the last 28 whole days (the window ends
 * yesterday), at most 30, with each video's public counts. One call for the counts and one for the first page of 20 videos,
 * at once; a second page only when TikTok says there is one, gives its cursor, and nothing on the first page is older than
 * the window (TikTok lists the newest first). `deadline` is the shared one (rule 741): every call checks it first.
 *
 * A scope refusal (the app or the login lacks the scope) is the known `tt_no_scope`, beside the part when the other call
 * answered and thrown as such when neither did; it is never a refused token, so the record, which also publishes, is not
 * asked to reconnect. Any other refused token ends the read. Any other failure of one side leaves its figures null or its
 * videos empty and the part stands; the second page failing keeps the first. Nothing read at all is a failed read.
 */
export async function readTiktok(scope: string, c: Connection, now: Date, deadline: number): Promise<ReadPart> {
  const acc = accountOf(c, "tiktok");
  const ask = async (slug: string, args: Record<string, unknown>) => {
    beforeDeadline(deadline);
    return composioRead(scope, "tiktok", slug, args, acc);
  };
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window: Range = { from: day(new Date(end - DAYS * DAY_MS)), to: day(new Date(end - DAY_MS)) };
  const [stats, first, mine] = await Promise.all([
    settle(ask("TIKTOK_GET_USER_STATS", { fields: [...TT_FIELDS] })),
    settle(ask("TIKTOK_LIST_VIDEOS", { max_count: PAGE })),
    db.smembers(SOCIAL_PUB_KEY(scope)),
  ]);
  const scopeLess = noScope(stats) || noScope(first);
  for (const r of [stats, first]) if (!r.ok && !noScope(r) && refused(r.error)) throw r.error;
  // Neither read: the known state only when both were scope refusals; another failure beside one is a failed read, its
  // own error thrown (rule 742). Alone, nothing is written and the last snapshot stands; beside another part, this part
  // is dropped and its error code is written (history kept).
  if (!stats.ok && !first.ok) throw noScope(stats) && noScope(first) ? new Error("tt_no_scope") : noScope(stats) ? first.error : stats.error;

  const listed = (r: unknown) => listOf(r, "create_time");
  const videos = first.ok ? listed(first.value) : [];
  // The second page, only while the first reaches no further back than the window.
  const next = first.ok && valueAt(first.value, "has_more") === true ? cursorOf(first.value) : null;
  const dated = videos.map(createdDay).filter(Boolean);
  if (next != null && dated.length && dated.every((d) => d >= window.from)) {
    try {
      videos.push(...listed(await ask("TIKTOK_LIST_VIDEOS", { max_count: PAGE, cursor: next })));
    } catch (e) {
      if (refused(e) && !NO_SCOPE.test(message(e))) throw e;
    }
  }

  const ours = new Set(mine);
  const seen = new Set<string>();
  const posts = videos
    .map((v) => ({ v, id: idOf(v), date: createdDay(v) }))
    .filter(({ id, date }) => {
      // A video without a digit id or a date, created outside the window, or listed twice is not a post.
      if (!id || date < window.from || date > window.to || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_POSTS)
    .map(({ v, id, date }): SocialPost => {
      const text = [v.title, v.video_description].find((t): t is string => typeof t === "string" && !!t.trim()) ?? "";
      return {
        id,
        date,
        type: "VIDEO",
        caption: clean(text, 80),
        url: ttUrl(v.share_url),
        views: count(v.view_count),
        reach: null,
        likes: count(v.like_count),
        comments: count(v.comment_count),
        shares: count(v.share_count),
        saved: null,
        // TikTok's publish id is not the video's id, so this holds only once a published video's id is stored.
        fromThakeen: ours.has(id),
      };
    });
  return {
    platform: "tiktok",
    account: clean(c.meta?.account ?? "", 80) || "TikTok",
    range: window,
    followers: stats.ok ? count(valueAt(stats.value, "follower_count")) : null,
    // Lifetime counts are not the window's: TikTok's totals are not read.
    totals: { ...EMPTY_TOTALS },
    posts,
    ...(scopeLess ? { known: "tt_no_scope" } : {}),
  };
}
