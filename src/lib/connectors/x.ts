import type { Connection } from "./store";
import { providerTimeout } from "../fetch-timeout";
import { clean } from "../perf-import";
import { DAY_MS, EMPTY_TOTALS, count, dateOf, day, handle } from "../social-read/common";
import type { PlatformPart, SocialPost } from "../social-stats";

export async function postToX(c: Connection, text: string): Promise<{ url: string; id: string }> {
  // Bounded inside the publish route's 60 s: a timeout is reported as "result unknown" (publish-once.ts), never a kill.
  const r = await fetch("https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${c.data.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 280) }), signal: AbortSignal.timeout(45_000) });
  if (!r.ok) {
    const text = await r.text();
    // X answers a repeated post with 403 "duplicate content". That is a refusal of this text, not of the token: without
    // its own code it read as a revoked connection (refusedToken) and disconnected X.
    if (r.status === 403 && /duplicate/i.test(text)) throw new Error("x_duplicate");
    throw new Error(`x ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as { data: { id: string } };
  return { id: j.data.id, url: `https://x.com/i/status/${j.data.id}` };
}
export async function xMe(c: Connection) {
  const r = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${c.data.access_token}` }, signal: providerTimeout() });
  if (!r.ok) return null;
  const j = (await r.json()) as { data: { username: string; name: string } };
  return j.data;
}

/**
 * The X account's results (rules 744, 745, spec 2026-10-08-social-analytics-reports C3), read only on an owner's click
 * and paid by the account (src/lib/x-stats.ts `refreshX`). X bills each read, so one refresh is two requests and never
 * more: the account with its public counts, then one page of at most `X_MAX_POSTS` of its own posts from the last 30
 * days, never a second page (no `pagination_token`) and nothing joined (no `expansions`). The prices are X's list prices
 * on 2026-10-08 (docs/system/costs.md): $0.010 the user, $0.005 a post, $0.060 a refresh at most, under one credit's
 * ceiling with and without VAT (tests/pricing-floor.test.ts).
 */
export const X_READ_CREDITS = 1;
export const X_MAX_POSTS = 10;
export const X_READ_USD = Object.freeze({ user: 0.01, post: 0.005 });
const X_DAYS = 30;
const X_TIMEOUT_MS = 15_000;
/** X's user and post ids: digits, sent as strings (nineteen at most today). */
const X_ID = /^[0-9]{1,19}$/;
/** The longest wait passed on from X's own headers: a day. */
const MAX_WAIT_S = 86_400;

/**
 * X refused the app, not the owner's token: 402 (the app's X credits ran out), 403 (the app's access level) or 429 (a
 * rate limit). The message carries no 401 or 403, so `refusedToken` never asks the owner to reconnect for it (rule 744).
 * `retryAfter` is X's own wait in seconds (`retry-after`, else `x-rate-limit-reset`), or null when X gave none.
 */
export class XUnavailable extends Error {
  constructor(readonly status: 402 | 403 | 429, readonly retryAfter: number | null) {
    super("x_unavailable");
    this.name = "XUnavailable";
  }
}

/** X's wait in whole seconds: `retry-after` in seconds, else the rate window's reset (epoch seconds) from now. */
function waitOf(r: Response): number | null {
  const after = r.headers.get("retry-after")?.trim() ?? "";
  if (/^\d{1,9}$/.test(after)) return Math.min(MAX_WAIT_S, Math.max(1, Number(after)));
  const reset = r.headers.get("x-rate-limit-reset")?.trim() ?? "";
  if (!/^\d{1,12}$/.test(reset)) return null;
  const s = Math.ceil(Number(reset) - Date.now() / 1000);
  return s > 0 ? Math.min(MAX_WAIT_S, s) : null;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** An X handle as `@name`, through `handle` (its `@` taken off first), or "" when nothing of it is left. */
const xHandle = (v: unknown) => {
  const h = handle(typeof v === "string" ? v.replace(/^@/, "") : "");
  return h ? `@${h}`.slice(0, 80) : "";
};

/**
 * One GET with the owner's token and a 15-second timeout. Only HTTP 401 reads as a refused token (`x 401: …`); X's text
 * is never kept in a message, so no other status can carry the digits `refusedToken` looks for.
 */
async function xGet(c: Connection, url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${c.data.access_token}` }, signal: AbortSignal.timeout(X_TIMEOUT_MS) });
  if (r.status === 401) throw new Error("x 401: unauthorized");
  if (r.status === 402 || r.status === 403 || r.status === 429) throw new XUnavailable(r.status, waitOf(r));
  if (!r.ok) throw new Error(`x_status_${r.status}`);
  const j = rec(await r.json().catch(() => null));
  if (!j) throw new Error("x_malformed");
  return j;
}

/** The first of `keys` read as a count in any of `sets`, or null (a missing number is not read, never zero). */
const first = (sets: (Record<string, unknown> | null)[], ...keys: string[]) => {
  for (const s of sets) for (const k of keys) {
    const v = count(s?.[k]);
    if (v != null) return v;
  }
  return null;
};

/**
 * The account's followers on the read date and its own posts of the last 30 days (reposts excluded), each with its
 * lifetime counts: views are impressions, shares reposts (`retweet_count` before X renamed it), saved bookmarks; X gives
 * no reach. Parsed tolerantly: a missing number is null, a post without a digit id or a date in the window is dropped.
 * Totals stay null and there is no previous period (post figures are lifetime totals, like TikTok's); a change comes
 * only from the monthly history (rule 746). `fromThakeen` is set by `refreshX` from `socialpub:{scope}`. The account is
 * the `@handle` with X's own characters (`handle`), and `accountId` the user id X answered for the owner's token.
 */
export async function readX(c: Connection, now: Date): Promise<PlatformPart> {
  const me = rec((await xGet(c, "https://api.x.com/2/users/me?user.fields=public_metrics")).data);
  const id = typeof me?.id === "string" && X_ID.test(me.id) ? me.id : null;
  if (!me || !id) throw new Error("x_malformed");
  const since = new Date(now.getTime() - X_DAYS * DAY_MS);
  const q = new URLSearchParams({
    max_results: String(X_MAX_POSTS),
    start_time: since.toISOString().replace(/\.\d{3}Z$/, "Z"),
    exclude: "retweets",
    "tweet.fields": "created_at,public_metrics,non_public_metrics,organic_metrics",
  });
  const list = await xGet(c, `https://api.x.com/2/users/${id}/tweets?${q}`);
  // No posts in the window: X answers with no `data` at all. Anything else that is not a list is not X's answer.
  if (list.data !== undefined && !Array.isArray(list.data)) throw new Error("x_malformed");
  const range = { from: day(since), to: day(now) };
  const seen = new Set<string>();
  const posts = ((list.data as unknown[] | undefined) ?? [])
    .map(rec)
    .map((t) => ({ t, id: typeof t?.id === "string" && X_ID.test(t.id) ? t.id : "", date: dateOf(t?.created_at) }))
    .filter(({ t, id, date }) => {
      if (!t || !id || !date || date < range.from || date > range.to || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, X_MAX_POSTS)
    .map(({ t, id, date }): SocialPost => {
      const pub = rec(t!.public_metrics), own = rec(t!.non_public_metrics), org = rec(t!.organic_metrics);
      return {
        id,
        date,
        type: "POST",
        caption: clean(typeof t!.text === "string" ? t!.text : "", 80),
        url: `https://x.com/i/status/${id}`,
        views: first([pub, own, org], "impression_count"),
        reach: null,
        likes: first([pub], "like_count"),
        comments: first([pub], "reply_count"),
        shares: first([pub], "repost_count", "retweet_count"),
        saved: first([pub], "bookmark_count"),
        fromThakeen: false,
      };
    });
  // The handle keeps X's own characters (`_` included); a stored label that is not a handle goes through `clean`.
  const stored = c.meta?.account ?? "";
  return {
    platform: "x",
    account: xHandle(me.username) || (stored.startsWith("@") ? xHandle(stored) : clean(stored, 80)) || "X",
    // The id X answered for the owner's own token, checked above and the one the posts were read under (rule 746): a
    // renamed handle keeps its history. Never displayed: the route and the Reports page drop it, Dana's block never prints it.
    accountId: id,
    range,
    followers: first([rec(me.public_metrics)], "followers_count"),
    totals: { ...EMPTY_TOTALS },
    posts,
  };
}
