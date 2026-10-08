import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, settle, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { OAUTH_COOKIE, getConnection, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { setComposioClientForTests } from "@/lib/connectors/composio";
import { connectViaComposio } from "@/lib/connectors/via-composio";
import { connectedSources } from "@/lib/report-sources";
import { EMPTY_TOTALS, SOCIAL_PUB_KEY, getSocialSnapshot, holdsSocial, socialDataBlock, syncSocial, syncSocialIfDue, type Totals } from "@/lib/social-stats";
import { fbUrl, holdsFb } from "@/lib/social-read/facebook";
import { holdsYt, ytUrl } from "@/lib/social-read/youtube";
import { holdsTt, ttUrl } from "@/lib/social-read/tiktok";
import * as connRoute from "@/app/api/connect/[provider]/route";
import * as callbackRoute from "@/app/api/connect/[provider]/callback/route";
import { fakeComposio, ok, type Answer, type Call, type Result } from "./helpers/composio-fake";

/**
 * Rule 739 (spec docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md, B1): the Facebook Page chosen for
 * publishing, read through Composio with constant metrics and fields: 56 days of daily insights split into the window and
 * the 28 days before it, the Page's own posts inside the window, and each post's lifetime views and reach. Amends 663 (the
 * three reads are reads only), 664 (the Page is a part beside Instagram) and 673 (a Facebook-only record with a Page is
 * read daily). Composio is the shared fake; answers follow the Graph API shapes Composio passes through (`data.data`).
 *
 * Rule 740 (same spec, B2): the YouTube channel chosen at connect, read the same way: its subscriber count, 56 days of
 * daily channel analytics split into the window and the 28 days before it, and its latest uploads (at most 30) with each
 * video's public counts. Amends 663 (the three new tools are reads only), 664 (the channel is a part), 673 (a YouTube
 * record is read daily) and 735 (the YouTube path answers sync_social). Answers follow the Data and Analytics API shapes.
 *
 * Rule 742 (same spec, C1): the TikTok account, read through Composio with Thakeen's own TikTok app: its lifetime
 * counts with constant fields (only followers are kept) and its public videos, at most two pages of 20, the ones created
 * inside the window kept (at most 30). No previous period: TikTok's counters are lifetime, so a change comes only from
 * the monthly history. Amends 663 (the two tools are reads only), 664 (a known state beside the part), 673 (a TikTok
 * record is read daily) and 735 (the TikTok path answers sync_social). Answers follow TikTok's v2 API shapes.
 */
const NOW = new Date("2026-10-08T09:00:00Z");

let calls: Call[];
let answers: Record<string, Answer>;
let owned: string[];
beforeEach(() => {
  const f = fakeComposio();
  ({ calls, answers, owned } = f);
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "meta,linkedin");
  setComposioClientForTests(f.client);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

const via = (provider: string, data: Record<string, string>, meta: Record<string, string> = {}): Connection => ({ provider, data, meta: { via: "composio", ...meta }, connectedAt: NOW.toISOString() });
const fbConn = (meta: Record<string, string> = {}) => via("meta", { facebook: "ca_fb" }, { pageId: "123", pageName: "عود الشرق", ...meta });
const both = () => via("meta", { instagram: "ca_ig", facebook: "ca_fb" }, { igId: "1784", pageId: "123", pageName: "عود الشرق" });
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const post = (provider: string, body: Record<string, unknown>) => connRoute.POST(json(`/api/connect/${provider}`, "POST", body), ctx(provider));

const METRICS = "page_media_view,page_total_media_view_unique,page_post_engagements,page_total_actions,page_follows,page_daily_follows_unique,page_daily_unfollows_unique";
const FIELDS = "id,message,created_time,permalink_url,status_type,from,shares,reactions.summary(true),comments.summary(true)";

/** One daily value for the Page's day `d` (YYYY-MM-DD): Meta stamps it 07:00 UTC the next day, the end of a Pacific day. */
const at = (d: string, value: unknown) => ({ value, end_time: `${new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)}T07:00:00+0000` });
const metric = (name: string, values: unknown[]) => ({ name, period: "day", values, title: name, id: `123/insights/${name}/day` });
const insights = (...rows: ReturnType<typeof metric>[]) => ok({ data: { data: rows, paging: { previous: "https://graph.facebook.com/v21.0/123/insights?access_token=SECRET" } } });

/** The window is 2026-09-10 to 2026-10-07 and the period before it 2026-08-13 to 2026-09-09. */
function pageInsights() {
  return insights(
    metric("page_media_view", [at("2026-10-07", 100), at("2026-10-06", 50), at("2026-09-10", 5), at("2026-09-09", 40), at("2026-08-13", 2), at("2026-08-12", 999)]),
    metric("page_total_media_view_unique", [at("2026-10-07", 60), at("2026-10-06", 30)]),
    metric("page_post_engagements", [at("2026-10-07", 7)]),
    metric("page_total_actions", [at("2026-10-07", 3)]),
    metric("page_follows", [at("2026-10-05", 500), at("2026-10-07", 512), at("2026-10-06", 510)]),
    metric("page_daily_follows_unique", [at("2026-10-07", 4), at("2026-10-06", 2), at("2026-09-01", 9)]),
    metric("page_daily_unfollows_unique", [at("2026-10-07", 1)]),
  );
}
const fbPost = (n: string, created: string, over: Record<string, unknown> = {}) => ({
  id: `123_${n}`, message: `post ${n}`, created_time: `${created}T10:00:00+0000`, permalink_url: `https://www.facebook.com/123/posts/${n}`,
  status_type: "added_photos", from: { id: "123", name: "عود الشرق" }, shares: { count: 3 },
  reactions: { data: [], summary: { total_count: 12 } }, comments: { data: [], summary: { total_count: 4 } }, ...over,
});
function fbAnswers(posts: Record<string, unknown>[] = [fbPost("1", "2026-10-05")], views: Record<string, [unknown, unknown]> = {}) {
  answers.FACEBOOK_GET_PAGE_INSIGHTS = pageInsights();
  answers.FACEBOOK_GET_PAGE_POSTS = ok({ data: { data: posts, paging: { next: "https://graph.facebook.com/v21.0/123/feed?access_token=SECRET&after=c1" } } });
  answers.FACEBOOK_GET_POST_INSIGHTS = (a) => {
    const [v, r] = views[String(a.post_id)] ?? [900, 700];
    return ok({ data: { data: [{ name: "post_media_view", period: "lifetime", values: [{ value: v }] }, { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: r }] }] } });
  };
}
function igAnswers() {
  answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "oud", followers_count: 1200 } });
  answers.INSTAGRAM_GET_USER_INSIGHTS = ok({ data: { data: [{ name: "reach", total_value: { value: 5400 } }, { name: "views", total_value: { value: 9100 } }] } });
  answers.INSTAGRAM_GET_IG_USER_MEDIA = ok({ data: { data: [] } });
}
/** Every figure is null or a clean count: never NaN, Infinity, a negative or a string. */
const clean = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

describe("Facebook Page results (rule 739)", () => {
  it("reads the chosen page with constant metrics and fields, never access_token (739)", async () => {
    const u = await newUser("fbread");
    await db.sadd(SOCIAL_PUB_KEY(u.email), "123_1");
    fbAnswers();
    const snap = await syncSocial(u.email, { meta: fbConn() }, NOW);
    expect(calls.find((c) => c.slug === "FACEBOOK_GET_PAGE_INSIGHTS")?.args).toEqual({ page_id: "123", metrics: METRICS, period: "day", since: "2026-08-13", until: "2026-10-08" });
    expect(calls.find((c) => c.slug === "FACEBOOK_GET_PAGE_POSTS")?.args).toEqual({ page_id: "123", fields: FIELDS, limit: 30 });
    expect(calls.find((c) => c.slug === "FACEBOOK_GET_POST_INSIGHTS")?.args).toEqual({ post_id: "123_1", metrics: "post_media_view,post_total_media_view_unique", period: "lifetime" });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(JSON.stringify(c.args)).not.toContain("access_token");
    expect(JSON.stringify(await getSocialSnapshot(u.email))).not.toContain("access_token");

    const fb = snap.parts.facebook!;
    expect(fb).toMatchObject({ platform: "facebook", account: "عود الشرق", range: { from: "2026-09-10", to: "2026-10-07" }, followers: 512 });
    expect(fb.totals).toEqual({ ...EMPTY_TOTALS, views: 155, reach: 90, engagements: 7, clicks: 3, followsGained: 6, followsLost: 1 });
    // The 28 days before the window, from the same call: a day before them (2026-08-12) counts in neither.
    expect(fb.prev).toEqual({ range: { from: "2026-08-13", to: "2026-09-09" }, totals: { ...EMPTY_TOTALS, views: 42, followsGained: 9 } });
    expect(fb.posts).toEqual([{ id: "123_1", date: "2026-10-05", type: "IMAGE", caption: "post 1", url: "https://www.facebook.com/123/posts/1", views: 900, reach: 700, likes: 12, comments: 4, shares: 3, saved: null, fromThakeen: true }]);
    expect(snap.errors).toEqual({});
    expect(snap.history).toEqual([{ month: "2026-10", platform: "facebook", followers: 512, totals: fb.totals }]);
    // Dana is told how the Page's reach adds up, beside the figures.
    const block = await socialDataBlock(u.email, NOW);
    expect(block).toContain('"facebook":{"account":"عود الشرق"');
    expect(block).toContain("On the Facebook Page, reach adds up each day's unique viewers");
  });

  it("keeps only the page's own posts inside the window, links only on facebook.com (739)", async () => {
    const u = await newUser("fbposts");
    fbAnswers([
      fbPost("5", "2026-10-08"), // today: after the window
      fbPost("1", "2026-10-05", { message: "<b>عود</b> ملكي " + "x".repeat(200) }),
      fbPost("3", "2026-10-04", { from: { id: "999", name: "a visitor" } }), // a visitor's post on the Page
      fbPost("6", "2026-10-01", { permalink_url: "https://evil.example/123/posts/6", status_type: "mobile_status_update" }),
      fbPost("2", "2026-09-20", { permalink_url: "https://www.facebook.com/photo.php?fbid=9&set=a.1", status_type: "added_video", shares: undefined, reactions: { summary: { total_count: "7" } } }),
      fbPost("4", "2026-09-09", {}), // older than the window
      fbPost("8", "2026-10-02", { id: "123_8/../../me", from: { id: "123" } }), // not a post id
      fbPost("9", "2026-10-03", { from: undefined }), // no author: not known to be the Page's
      fbPost("10", "2026-09-30", { permalink_url: "http://www.facebook.com/123/posts/10", status_type: "shared_story" }),
    ], { "123_2": ["40", {}] });
    const base = answers.FACEBOOK_GET_POST_INSIGHTS as (a: Record<string, unknown>) => Result;
    answers.FACEBOOK_GET_POST_INSIGHTS = (a) => (a.post_id === "123_6" ? { successful: false, error: "(#100) Unsupported get request" } : base(a));
    const fb = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    expect(fb.posts.map((p) => p.id)).toEqual(["123_1", "123_6", "123_2", "123_10"]);
    expect(calls.filter((c) => c.slug === "FACEBOOK_GET_POST_INSIGHTS").map((c) => c.args.post_id)).toEqual(["123_1", "123_6", "123_2", "123_10"]);
    const [p1, p6, p2, p10] = fb.posts;
    expect(p1.caption.length).toBeLessThanOrEqual(80);
    expect(p1.caption).not.toMatch(/[<>]/);
    expect(p1.caption.startsWith("bعود/b ملكي")).toBe(true);
    // A foreign host, a link with a query string and plain http are never kept.
    expect([p6.url, p2.url, p10.url]).toEqual([null, null, null]);
    expect([p1.type, p6.type, p2.type, p10.type]).toEqual(["IMAGE", "POST", "VIDEO", "LINK"]);
    // A post whose insights fail keeps null views and reach; the read stands.
    expect(p6).toMatchObject({ views: null, reach: null, likes: 12, comments: 4, shares: 3, fromThakeen: false });
    // "40" is read as 40, {} is not read; a post Graph sends without `shares` has its shares unknown, not zero.
    expect(p2).toMatchObject({ views: 40, reach: null, likes: 7, shares: null, saved: null });
  });

  it("page insights tolerate strings, empty objects and junk (Review Focus 5)", async () => {
    const u = await newUser("fbjunk");
    fbAnswers([fbPost("1", "2026-10-05", { reactions: { summary: { total_count: "N/A" } }, comments: { summary: { total_count: -1 } }, shares: { count: "5" } })], { "123_1": [Infinity, "12abc"] });
    answers.FACEBOOK_GET_PAGE_INSIGHTS = insights(
      metric("page_media_view", [
        at("2026-10-07", "1234"), at("2026-10-06", {}), at("2026-10-05", "N/A"), at("2026-10-04", ""), at("2026-10-03", NaN), at("2026-10-02", -5),
        at("2026-10-01", Infinity), at("2026-09-30", "12abc"), at("2026-09-29", "9".repeat(400)), at("2026-09-28", "0x10"), at("2026-09-27", null), at("2026-09-26", "-3"),
      ]),
      // A metric answered only with {}: not read, so null, never 0.
      metric("page_total_media_view_unique", [at("2026-10-07", {})]),
      metric("page_post_engagements", [at("2026-10-07", " 8 "), at("2026-10-06", "2.5")]),
      metric("page_follows", [at("2026-10-06", "800"), at("2026-10-07", "N/A")]),
      metric("page_daily_follows_unique", [at("2026-10-07", -3)]),
      metric("page_daily_unfollows_unique", [at("2026-10-07", [1])]),
    );
    const fb = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    expect(fb.totals).toEqual({ ...EMPTY_TOTALS, views: 1234, engagements: 10.5 });
    expect(fb.followers).toBe(800);
    expect(fb).not.toHaveProperty("prev");
    expect(fb.posts[0]).toMatchObject({ views: null, reach: null, likes: null, comments: null, shares: 5 });
    const figures: unknown[] = [fb.followers, ...Object.values(fb.totals as Totals), ...fb.posts.flatMap((p) => [p.views, p.reach, p.likes, p.comments, p.shares, p.saved])];
    for (const v of figures) expect(clean(v), String(v)).toBe(true);
  });

  it("a Facebook-only Meta record is read daily (673)", async () => {
    const u = await newUser("fbdaily");
    await saveConnection(u.email, fbConn());
    fbAnswers();
    expect(await syncSocialIfDue(u.email, NOW)).toBe(true);
    const s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.parts.facebook?.totals.views).toBe(155);
    expect(await syncSocialIfDue(u.email, new Date(NOW.getTime() + 19 * 3600e3))).toBe(false);
    // The owner's refresh on the Meta path reads it too (rule 735: the path answers once a reader holds the record).
    expect(holdsSocial("meta", fbConn())).toBe(true);
    await signIn(u.email);
    expect((await post("meta", { action: "sync_social" })).status).toBe(200);
    await settle();
  });

  it("a Page whose app lacks read_insights is a known state, never a failure, and Instagram stands beside it", async () => {
    const u = await newUser("fbnoins");
    fbAnswers();
    igAnswers();
    answers.FACEBOOK_GET_PAGE_INSIGHTS = { successful: false, error: "(#10) This endpoint requires the 'read_insights' permission to manage the object" };
    const snap = await syncSocial(u.email, { meta: both() }, NOW);
    expect(snap.errors).toEqual({ facebook: "fb_no_insights" });
    expect(snap.parts.facebook).toBeUndefined();
    expect(snap.parts.instagram?.account).toBe("oud");
    // Alone, it is written and not thrown: the daily run adds no failure line for a permission the owner cannot fix by reconnecting.
    const alone = await newUser("fbnoins2");
    await saveConnection(alone.email, fbConn());
    expect(await syncSocialIfDue(alone.email, NOW)).toBe(true);
    expect(await getSocialSnapshot(alone.email)).toMatchObject({ v: 2, parts: {}, errors: { facebook: "fb_no_insights" } });
  });

  it("a refused token ends the read for its provider; one failed side keeps the other; both failing is a failed read", async () => {
    const u = await newUser("fbfail");
    igAnswers();
    fbAnswers();
    // A refused token on the post list: thrown with Meta as its provider, after Instagram is written.
    answers.FACEBOOK_GET_PAGE_POSTS = { successful: false, error: "Error validating access token: session has expired" };
    await expect(syncSocial(u.email, { meta: both() }, NOW)).rejects.toMatchObject({ provider: "meta", message: expect.stringMatching(/ 401:/) });
    expect(await getSocialSnapshot(u.email)).toMatchObject({ parts: { instagram: { account: "oud" } }, errors: { facebook: "read_failed" } });

    // A failed post list keeps the Page's figures; failed insights keep its posts.
    answers.FACEBOOK_GET_PAGE_POSTS = { successful: false, error: "Service temporarily unavailable" };
    const noPosts = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    expect(noPosts).toMatchObject({ followers: 512, totals: { views: 155 }, posts: [] });
    fbAnswers();
    answers.FACEBOOK_GET_PAGE_INSIGHTS = { successful: false, error: "(#100) Invalid metric" };
    const noTotals = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    expect(noTotals).toMatchObject({ followers: null, totals: EMPTY_TOTALS, posts: [{ id: "123_1", views: 900 }] });
    expect(noTotals).not.toHaveProperty("prev");

    // Both failing: the Page is not read, and Instagram stands.
    answers.FACEBOOK_GET_PAGE_POSTS = { successful: false, error: "Service temporarily unavailable" };
    const s = await syncSocial(u.email, { meta: both() }, NOW);
    expect(s.errors).toEqual({ facebook: "read_failed" });
    expect(s.parts.instagram).toBeDefined();
    await expect(syncSocial(u.email, { meta: fbConn() }, NOW)).rejects.toMatchObject({ provider: "meta" });
  });

  it("a refused token on a post's insights stops the other post reads", async () => {
    const u = await newUser("fbpost401");
    fbAnswers(Array.from({ length: 12 }, (_, i) => fbPost(String(i + 1), "2026-10-01")));
    answers.FACEBOOK_GET_POST_INSIGHTS = { successful: false, error: "Unauthorized: token revoked" };
    await expect(syncSocial(u.email, { meta: fbConn() }, NOW)).rejects.toMatchObject({ provider: "meta", message: expect.stringMatching(/ 401:/) });
    expect(calls.filter((c) => c.slug === "FACEBOOK_GET_POST_INSIGHTS").length).toBeLessThanOrEqual(4);
  });

  it("post reads run four at a time and none is asked past the shared deadline (741)", async () => {
    const u = await newUser("fbdeadline");
    fbAnswers(Array.from({ length: 40 }, (_, i) => fbPost(String(i + 1), "2026-10-01")));
    const base = answers.FACEBOOK_GET_POST_INSIGHTS as (a: Record<string, unknown>) => Result;
    answers.FACEBOOK_GET_POST_INSIGHTS = (a) => { vi.setSystemTime(NOW.getTime() + 31_000); return base(a); };
    const fb = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    // Posts are capped at 30; the four asked before the clock passed 30 s land, the rest stay unread.
    expect(fb.posts).toHaveLength(30);
    expect(calls.filter((c) => c.slug === "FACEBOOK_GET_POST_INSIGHTS")).toHaveLength(4);
    expect(fb.posts.filter((p) => p.views === 900)).toHaveLength(4);
    expect(fb.posts.filter((p) => p.views === null)).toHaveLength(26);
  });

  it("rows dated in neither period are not summed, and said once", async () => {
    const u = await newUser("fbnoday");
    fbAnswers();
    answers.FACEBOOK_GET_PAGE_INSIGHTS = insights(metric("page_media_view", [{ value: 10 }, { value: 20, end_time: "yesterday" }, at("2025-01-01", 30)]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fb = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    expect(fb.totals).toEqual(EMPTY_TOTALS);
    expect(warn.mock.calls.filter((c) => c[0] === "fb_no_day_rows")).toHaveLength(1);
  });

  it("followers come only from a dated daily row (739)", async () => {
    const u = await newUser("fbfollowday");
    fbAnswers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A row with no stamp, and one whose stamp is not a date: no day, so neither is the Page's count on a day.
    answers.FACEBOOK_GET_PAGE_INSIGHTS = insights(metric("page_media_view", [at("2026-10-07", 100)]), metric("page_follows", [{ value: 999 }, { value: 998, end_time: "yesterday" }]));
    expect((await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!.followers).toBeNull();
    // Beside a dated row, the dated one stands.
    answers.FACEBOOK_GET_PAGE_INSIGHTS = insights(metric("page_follows", [at("2026-10-06", 510), { value: 999 }]));
    expect((await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!.followers).toBe(510);
  });

  it("an earlier period in which every figure read is 0 gives no prev (733)", async () => {
    const u = await newUser("fbprevzero");
    fbAnswers();
    answers.FACEBOOK_GET_PAGE_INSIGHTS = insights(
      metric("page_media_view", [at("2026-10-07", 100), at("2026-09-01", 0), at("2026-08-20", 0)]),
      metric("page_daily_follows_unique", [at("2026-10-07", 4), at("2026-09-02", 0)]),
    );
    const fb = (await syncSocial(u.email, { meta: fbConn() }, NOW)).parts.facebook!;
    expect(fb.totals).toMatchObject({ views: 100, followsGained: 4 });
    expect(fb).not.toHaveProperty("prev");
  });

  it("Graph's permission codes (#10) and (#200) on the insights read are fb_no_insights too (739)", async () => {
    const u = await newUser("fbnoinscode");
    fbAnswers();
    for (const error of ["(#10) Application does not have permission for this action", "(#200) Requires pages_read_engagement permission to manage the object"]) {
      answers.FACEBOOK_GET_PAGE_INSIGHTS = { successful: false, error };
      const snap = await syncSocial(u.email, { meta: fbConn() }, NOW);
      expect(snap.errors, error).toEqual({ facebook: "fb_no_insights" });
      expect(snap.parts.facebook, error).toBeUndefined();
    }
    // Another code is not a permission: the posts stand and the figures are unread.
    answers.FACEBOOK_GET_PAGE_INSIGHTS = { successful: false, error: "(#100) Invalid metric" };
    expect((await syncSocial(u.email, { meta: fbConn() }, NOW)).errors).toEqual({});
  });

  it("holds a Composio Meta record with the Facebook part and a chosen Page, and the account falls back to the Page id", async () => {
    expect(holdsFb(fbConn())).toBe(true);
    expect(holdsFb(via("meta", { facebook: "ca_fb" }))).toBe(false);
    expect(holdsFb(fbConn({ pageId: "p1" }))).toBe(false);
    expect(holdsFb(fbConn({ pageId: "123abc" }))).toBe(false);
    expect(holdsFb(via("meta", { instagram: "ca_ig" }, { pageId: "123", igId: "1784" }))).toBe(false);
    expect(holdsFb({ provider: "meta", data: { access_token: "t" }, meta: { pageId: "123" }, connectedAt: NOW.toISOString() })).toBe(false);
    expect(holdsFb(null)).toBe(false);
    const u = await newUser("fbname");
    fbAnswers();
    const conn = fbConn();
    delete conn.meta!.pageName;
    expect((await syncSocial(u.email, { meta: conn }, NOW)).parts.facebook?.account).toBe("Page 123");
    const marked = await syncSocial(u.email, { meta: fbConn({ pageName: "<b>Oud</b>\n" + "y".repeat(120) }) }, NOW);
    expect(marked.parts.facebook!.account).not.toMatch(/[<>\n]/);
    expect(marked.parts.facebook!.account.length).toBeLessThanOrEqual(80);
  });

  it("links only to a post page on facebook.com over https", () => {
    expect(fbUrl("https://www.facebook.com/123/posts/1")).toBe("https://www.facebook.com/123/posts/1");
    expect(fbUrl("https://facebook.com/123/posts/1#top")).toBe("https://facebook.com/123/posts/1");
    for (const bad of [
      "https://m.facebook.com/123/posts/1", "http://www.facebook.com/123/posts/1", "https://www.facebook.com.evil.example/1",
      "https://www.facebook.com:8443/123/posts/1", "https://www.facebook.com/photo.php?fbid=1", "javascript:alert(1)", "not a link", 42, null,
    ]) expect(fbUrl(bad), String(bad)).toBeNull();
  });
});

const YT_METRICS = "views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,subscribersLost";
const CH = "UCddiUEpeqJcYeBxX1IVBKvQ";
const ytConn = (meta: Record<string, string> = {}) => via("youtube", { youtube: "ca_yt" }, { channelId: CH, account: "Ward TV", ...meta });
/** An eleven-character video id: vid00000001, vid00000002, ... */
const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
const HEADS = ["day", ...YT_METRICS.split(",")];
const heads = (names: string[]) => names.map((name) => ({ name, columnType: name === "day" ? "DIMENSION" : "METRIC", dataType: name === "day" ? "STRING" : "INTEGER" }));
/** One analytics day: views, minutes watched, likes, comments, shares, subscribers gained and lost, in HEADS order. */
type Day = [string, ...unknown[]];
const DAYS: Day[] = [
  ["2026-10-07", 100, 250, 10, 2, 1, 5, 1],
  ["2026-10-06", 50, 120, 4, 1, 0, 3, 0],
  ["2026-09-10", 5, 10, 0, 0, 0, 0, 0],
  ["2026-09-09", 40, 90, 2, 0, 0, 1, 2],
  ["2026-08-13", 2, 3, 0, 0, 0, 0, 0],
  ["2026-08-12", 999, 999, 999, 999, 999, 999, 999], // before both periods
];
const report = (rows: unknown[], names: string[] | null = HEADS) => ok({ data: { kind: "youtubeAnalytics#resultTable", ...(names ? { columnHeaders: heads(names) } : {}), rows } });
const ytVideo = (id: string, published: string, over: Record<string, unknown> = {}) => ({
  kind: "youtube#video", id, snippet: { title: `video ${id}`, publishedAt: `${published}T12:00:00Z`, channelId: CH },
  statistics: { viewCount: "1500", likeCount: "80", commentCount: "6", favoriteCount: "0" }, status: { privacyStatus: "public" }, ...over,
});
/** The channel's upload list as playlist items (the playlist item's own id is not a video id). */
const listing = (ids: string[]) => ok({ data: { items: ids.map((id, i) => ({ kind: "youtube#playlistItem", id: `UUpl${i}aGVsbG8gd29ybGQgaXRlbQ`, snippet: { title: `video ${id}`, resourceId: { kind: "youtube#video", videoId: id } } })) } });
function ytAnswers(videos: Record<string, unknown>[] = [ytVideo(vid(1), "2026-10-05")], rows: unknown[] = DAYS) {
  answers.YOUTUBE_LIST_CHANNELS = ok({ data: { kind: "youtube#channelListResponse", items: [{ kind: "youtube#channel", id: CH, statistics: { viewCount: "90000", subscriberCount: "5000", hiddenSubscriberCount: false, videoCount: "40" } }] } });
  answers.YOUTUBE_QUERY_ANALYTICS = report(rows);
  answers.YOUTUBE_LIST_CHANNEL_VIDEOS = listing(videos.map((v) => String(v.id)));
  answers.YOUTUBE_GET_VIDEO_DETAILS_BATCH = (a) => ok({ data: { items: videos.filter((v) => (a.id as string[]).includes(String(v.id))) } });
}
const YT_TOTALS = { ...EMPTY_TOTALS, views: 155, watchMinutes: 380, likes: 14, comments: 3, shares: 1, followsGained: 8, followsLost: 1 };

describe("YouTube channel results (rule 740)", () => {
  it("reads the connected channel with constant metrics and parts, never a channel id (740)", async () => {
    const u = await newUser("ytread");
    await db.sadd(SOCIAL_PUB_KEY(u.email), vid(1));
    ytAnswers();
    const snap = await syncSocial(u.email, { youtube: ytConn() }, NOW);
    const args = (slug: string) => calls.find((c) => c.slug === slug)?.args;
    expect(args("YOUTUBE_LIST_CHANNELS")).toEqual({ part: "statistics", mine: true, maxResults: 1 });
    expect(args("YOUTUBE_QUERY_ANALYTICS")).toEqual({ ids: "channel==MINE", startDate: "2026-08-13", endDate: "2026-10-07", metrics: YT_METRICS, dimensions: "day" });
    expect(args("YOUTUBE_LIST_CHANNEL_VIDEOS")).toEqual({ mine: true, part: "snippet", maxResults: 30 });
    expect(args("YOUTUBE_GET_VIDEO_DETAILS_BATCH")).toEqual({ id: [vid(1)], parts: ["snippet", "statistics", "status"] });
    expect(calls).toHaveLength(4);
    // The login's own channel is asked for (channel==MINE, mine): the stored channel id and any token never leave.
    for (const c of calls) expect(JSON.stringify(c.args)).not.toMatch(new RegExp(`${CH}|access_token`));

    const yt = snap.parts.youtube!;
    expect(yt).toMatchObject({ platform: "youtube", account: "Ward TV", range: { from: "2026-09-10", to: "2026-10-07" }, followers: 5000 });
    expect(yt.totals).toEqual(YT_TOTALS);
    // The 28 days before the window, from the same call: a day before them (2026-08-12) counts in neither.
    expect(yt.prev).toEqual({ range: { from: "2026-08-13", to: "2026-09-09" }, totals: { ...EMPTY_TOTALS, views: 42, watchMinutes: 93, likes: 2, comments: 0, shares: 0, followsGained: 1, followsLost: 2 } });
    expect(yt.posts).toEqual([{ id: vid(1), date: "2026-10-05", type: "VIDEO", caption: `video ${vid(1)}`, url: `https://www.youtube.com/watch?v=${vid(1)}`, views: 1500, reach: null, likes: 80, comments: 6, shares: null, saved: null, fromThakeen: true }]);
    expect(snap.errors).toEqual({});
    expect(snap.history).toEqual([{ month: "2026-10", platform: "youtube", followers: 5000, totals: yt.totals }]);
    // Dana is told what YouTube's figures are, beside them.
    const block = await socialDataBlock(u.email, NOW);
    expect(block).toContain('"youtube":{"account":"Ward TV"');
    expect(block).toContain("On the YouTube channel, followers are subscribers");
  });

  it("keeps at most 30 uploads, published inside the window and not private, links only on youtube.com (740)", async () => {
    const u = await newUser("ytposts");
    const videos = Array.from({ length: 35 }, (_, i) => ytVideo(vid(i + 1), "2026-10-01"));
    videos[0] = ytVideo(vid(1), "2026-10-08"); // today: after the window
    videos[1] = ytVideo(vid(2), "2026-10-02", { status: { privacyStatus: "private" } }); // a private draft (Thakeen's uploads)
    videos[2] = ytVideo(vid(3), "2026-09-09"); // older than the window
    videos[3] = ytVideo(vid(4), "2026-10-03", { snippet: { title: "<b>ورد</b> طائفي\n" + "x".repeat(200), publishedAt: "2026-10-03T08:00:00Z" } });
    videos[4] = ytVideo(vid(5), "2026-09-10", { status: { privacyStatus: "unlisted" }, statistics: { viewCount: "N/A", likeCount: "12abc", commentCount: -1 } });
    ytAnswers(videos);
    // Ids that are not video ids, a repeat and a search result's shape: the bad ones and the repeat are never asked for.
    const ids = [vid(1), "bad id!!!!!", "../../../me", vid(2), vid(2), ...videos.slice(2).map((v) => String(v.id))];
    answers.YOUTUBE_LIST_CHANNEL_VIDEOS = ok({ data: { items: ids.map((id, i) => (i === 0 ? { id: { kind: "youtube#video", videoId: id }, snippet: { title: "t" } } : { id: `item${i}`, snippet: { resourceId: { videoId: id } } })) } });
    // The answer also carries a video not asked for: never kept.
    const base = answers.YOUTUBE_GET_VIDEO_DETAILS_BATCH as (a: Record<string, unknown>) => Result;
    answers.YOUTUBE_GET_VIDEO_DETAILS_BATCH = (a) => {
      const r = base(a) as { data: { data: { items: unknown[] } } };
      return ok({ data: { items: [...r.data.data.items, ytVideo("zzzzzzzzzzz", "2026-10-01")] } });
    };
    const yt = (await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!;
    const asked = calls.find((c) => c.slug === "YOUTUBE_GET_VIDEO_DETAILS_BATCH")!.args.id as string[];
    expect(asked).toEqual(Array.from({ length: 30 }, (_, i) => vid(i + 1)));
    expect(calls.filter((c) => c.slug === "YOUTUBE_GET_VIDEO_DETAILS_BATCH")).toHaveLength(1);
    expect(yt.posts).toHaveLength(27);
    expect(yt.posts.map((p) => p.id)).toEqual([vid(4), vid(5), ...Array.from({ length: 25 }, (_, i) => vid(i + 6))]);
    for (const p of yt.posts) expect(p.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/);
    const [p4, p5] = yt.posts;
    expect(p4.caption.length).toBeLessThanOrEqual(80);
    expect(p4.caption).not.toMatch(/[<>\n]/);
    // An unlisted video stands; counts that are not numbers are not read, never zero.
    expect(p5).toMatchObject({ date: "2026-09-10", views: null, likes: null, comments: null, reach: null, shares: null, saved: null, fromThakeen: false });
  });

  it("analytics refused for want of their scope keep the subscribers and videos as a known state (740)", async () => {
    const u = await newUser("ytnoana");
    ytAnswers();
    answers.YOUTUBE_QUERY_ANALYTICS = { successful: false, error: "Request had insufficient authentication scopes." };
    const snap = await syncSocial(u.email, { youtube: ytConn() }, NOW);
    expect(snap.errors).toEqual({ youtube: "yt_no_analytics" });
    const yt = snap.parts.youtube!;
    expect(yt).toMatchObject({ followers: 5000, totals: EMPTY_TOTALS, posts: [{ id: vid(1), views: 1500 }] });
    expect(yt.totals.views).toBeNull();
    expect(yt).not.toHaveProperty("prev");
    expect(yt).not.toHaveProperty("known");
    // The stored part carries no state of its own, and the daily run writes it without a failure line.
    expect(JSON.stringify(await getSocialSnapshot(u.email))).not.toContain('"known"');
    const alone = await newUser("ytnoana2");
    await saveConnection(alone.email, ytConn());
    expect(await syncSocialIfDue(alone.email, NOW)).toBe(true);
    expect(await getSocialSnapshot(alone.email)).toMatchObject({ v: 2, parts: { youtube: { followers: 5000 } }, errors: { youtube: "yt_no_analytics" } });
    // Google's other refusal texts for the same cause.
    for (const error of ["The caller does not have permission (403)", "Forbidden", "YouTube Analytics API has not been used in project 1 before or it is disabled."]) {
      answers.YOUTUBE_QUERY_ANALYTICS = { successful: false, error };
      expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).errors, error).toEqual({ youtube: "yt_no_analytics" });
    }
    // Any other failure leaves the figures unread with no code: not a state the owner can act on.
    answers.YOUTUBE_QUERY_ANALYTICS = { successful: false, error: "Backend Error" };
    const other = await syncSocial(u.email, { youtube: ytConn() }, NOW);
    expect(other.errors).toEqual({});
    expect(other.parts.youtube).toMatchObject({ followers: 5000, totals: EMPTY_TOTALS });
  });

  it("a refused token ends the read; one failed side keeps the others; nothing read is a failed read", async () => {
    const u = await newUser("ytfail");
    ytAnswers();
    answers.YOUTUBE_LIST_CHANNEL_VIDEOS = { successful: false, error: "Token has been expired or revoked." };
    await expect(syncSocial(u.email, { youtube: ytConn() }, NOW)).rejects.toMatchObject({ provider: "youtube", message: expect.stringMatching(/ 401:/) });
    // The only part not read: nothing is written over the last read.
    expect(await getSocialSnapshot(u.email)).toBeNull();

    // A refused token on the video details too.
    ytAnswers();
    answers.YOUTUBE_GET_VIDEO_DETAILS_BATCH = { successful: false, error: "Unauthorized" };
    await expect(syncSocial(u.email, { youtube: ytConn() }, NOW)).rejects.toMatchObject({ provider: "youtube", message: expect.stringMatching(/ 401:/) });

    // Failed details keep the channel's figures; a failed channel list keeps the analytics and the videos.
    answers.YOUTUBE_GET_VIDEO_DETAILS_BATCH = { successful: false, error: "Backend Error" };
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube).toMatchObject({ followers: 5000, totals: YT_TOTALS, posts: [] });
    ytAnswers();
    answers.YOUTUBE_LIST_CHANNELS = { successful: false, error: "Backend Error" };
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube).toMatchObject({ followers: null, totals: YT_TOTALS, posts: [{ id: vid(1) }] });

    // All three failing: the channel is not read.
    answers.YOUTUBE_QUERY_ANALYTICS = { successful: false, error: "Backend Error" };
    answers.YOUTUBE_LIST_CHANNEL_VIDEOS = { successful: false, error: "Backend Error" };
    const kept = await getSocialSnapshot(u.email);
    await expect(syncSocial(u.email, { youtube: ytConn() }, NOW)).rejects.toMatchObject({ provider: "youtube", message: expect.stringMatching(/ 502:/) });
    expect(await getSocialSnapshot(u.email)).toEqual(kept);
  });

  it("analytics are read by their column names, and junk is never a figure (Review Focus 5)", async () => {
    const u = await newUser("ytjunk");
    ytAnswers([ytVideo(vid(1), "2026-10-05", { statistics: { viewCount: Infinity, likeCount: "7", commentCount: {} } })]);
    // Columns in another order than asked: read by name.
    const order = ["views", "day", "subscribersLost", "likes", "estimatedMinutesWatched", "comments", "shares", "subscribersGained"];
    answers.YOUTUBE_QUERY_ANALYTICS = report([
      ["1234", "2026-10-07", 1, " 8 ", "2.5", {}, "N/A", -3],
      [NaN, "2026-10-06", Infinity, "", null, "12abc", "9".repeat(400), "0x10"],
      [-5, "2026-10-05", [1], "-3", 4, 2, 1, 6],
    ], order);
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ id: CH, statistics: { subscriberCount: "N/A" } }] } });
    const yt = (await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!;
    expect(yt.totals).toEqual({ ...EMPTY_TOTALS, views: 1234, watchMinutes: 6.5, likes: 8, comments: 2, shares: 1, followsGained: 6, followsLost: 1 });
    expect(yt.followers).toBeNull();
    expect(yt).not.toHaveProperty("prev");
    expect(yt.posts[0]).toMatchObject({ views: null, likes: 7, comments: null });
    const figures: unknown[] = [yt.followers, ...Object.values(yt.totals as Totals), ...yt.posts.flatMap((p) => [p.views, p.reach, p.likes, p.comments, p.shares, p.saved])];
    for (const v of figures) expect(clean(v), String(v)).toBe(true);

    // Without column headers, rows are read in the order asked; rows sent as objects are read by name.
    answers.YOUTUBE_QUERY_ANALYTICS = report([["2026-10-07", 100, 250, 10, 2, 1, 5, 1]], null);
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!.totals).toMatchObject({ views: 100, watchMinutes: 250, followsGained: 5, followsLost: 1 });
    answers.YOUTUBE_QUERY_ANALYTICS = report([{ day: "2026-10-07", views: 30, estimatedMinutesWatched: "45" }], null);
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!.totals).toEqual({ ...EMPTY_TOTALS, views: 30, watchMinutes: 45 });
  });

  it("subscribers come only from the connected channel, and a hidden count is not read", async () => {
    const u = await newUser("ytsubs");
    ytAnswers();
    // A channel list with no row: no subscriber count, and the rest of the read stands.
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [] } });
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!.followers).toBeNull();
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ id: CH, statistics: { subscriberCount: "0", hiddenSubscriberCount: true } }] } });
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!.followers).toBeNull();
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ id: CH, statistics: { subscriberCount: "0", hiddenSubscriberCount: false } }] } });
    expect((await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!.followers).toBe(0);
  });

  it("a login whose channel is not the stored one is a failed read, yt_other_channel, and the last read stands (740)", async () => {
    const u = await newUser("ytother");
    await saveConnection(u.email, ytConn());
    ytAnswers();
    await syncSocial(u.email, { youtube: ytConn() }, NOW);
    const kept = await getSocialSnapshot(u.email);
    // The login now answers for another channel (channel==MINE): its analytics and uploads are that channel's, not the stored one's.
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ id: "UCanotherchannel000000", statistics: { subscriberCount: "777" } }] } });
    await expect(syncSocial(u.email, { youtube: ytConn() }, NOW)).rejects.toMatchObject({ provider: "youtube", message: "yt_other_channel" });
    expect(await getSocialSnapshot(u.email), "the last good part stands").toEqual(kept);
    // The daily run's line names the code; it is no known state and asks no reconnect.
    await expect(syncSocialIfDue(u.email, NOW, true)).rejects.toThrow(/^yt_other_channel$/);
    expect((await getConnection(u.email, "youtube"))?.needsReconnect).toBeFalsy();
    // Beside another part, the channel is not read and its code is written.
    ttAnswers();
    const both = await syncSocial(u.email, { youtube: ytConn(), tiktok: ttConn() }, NOW);
    expect(both.errors).toEqual({ youtube: "yt_other_channel" });
    expect(both.parts.youtube).toBeUndefined();
    expect(both.parts.tiktok).toBeDefined();
  });

  it("an earlier period in which every figure read is 0 gives no prev (733)", async () => {
    const u = await newUser("ytprevzero");
    ytAnswers(undefined, [["2026-10-07", 100, 250, 10, 2, 1, 5, 1], ["2026-09-09", 0, 0, 0, 0, 0, 0, 0], ["2026-08-20", 0, 0, 0, 0, 0, 0, 0]]);
    const yt = (await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!;
    expect(yt.totals).toMatchObject({ views: 100, watchMinutes: 250 });
    expect(yt).not.toHaveProperty("prev");
  });

  it("a channel id is UC and 10 to 40 more characters, at connect, in the reader and in the report sources (740)", async () => {
    const long = "UC" + "a".repeat(41);
    const longest = "UC" + "a".repeat(40);
    expect(holdsYt(ytConn({ channelId: long }))).toBe(false);
    expect(holdsYt(ytConn({ channelId: longest }))).toBe(true);
    expect(connectedSources([{ provider: "youtube", meta: { via: "composio", channelId: long } }])).toEqual([]);
    expect(connectedSources([{ provider: "youtube", meta: { via: "composio", channelId: longest } }])).toEqual(["youtube"]);
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ kind: "youtube#channel", id: long, snippet: { title: "Ward TV" } }] } });
    await expect(connectViaComposio("s740", "youtube", "youtube", "ca_yt", null)).rejects.toThrow("no_youtube_channel");
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ kind: "youtube#channel", id: longest, snippet: { title: "Ward TV" } }] } });
    expect((await connectViaComposio("s740", "youtube", "youtube", "ca_yt", null)).meta?.channelId).toBe(longest);
    // The fallback name is one clean line of at most 80 characters.
    const u = await newUser("ytlongname");
    ytAnswers();
    answers.YOUTUBE_LIST_CHANNELS = ok({ data: { items: [{ id: longest, statistics: { subscriberCount: "5" } }] } });
    const conn = ytConn({ channelId: longest });
    delete conn.meta!.account;
    const account = (await syncSocial(u.email, { youtube: conn }, NOW)).parts.youtube!.account;
    expect(account).toBe(`Channel ${longest}`);
    expect(account.length).toBeLessThanOrEqual(80);
  });

  it("no video details are asked past the shared deadline (741)", async () => {
    const u = await newUser("ytdeadline");
    ytAnswers();
    const list = answers.YOUTUBE_LIST_CHANNEL_VIDEOS as Result;
    answers.YOUTUBE_LIST_CHANNEL_VIDEOS = () => { vi.setSystemTime(NOW.getTime() + 31_000); return list; };
    const yt = (await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!;
    expect(calls.filter((c) => c.slug === "YOUTUBE_GET_VIDEO_DETAILS_BATCH")).toHaveLength(0);
    expect(yt).toMatchObject({ followers: 5000, totals: YT_TOTALS, posts: [] });
  });

  it("rows dated in neither period are not summed, and said once", async () => {
    const u = await newUser("ytnoday");
    ytAnswers();
    answers.YOUTUBE_QUERY_ANALYTICS = report([["", 10, 1, 1, 1, 1, 1, 1], ["yesterday", 20, 1, 1, 1, 1, 1, 1], ["2025-01-01", 30, 1, 1, 1, 1, 1, 1], [null, 40]]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const yt = (await syncSocial(u.email, { youtube: ytConn() }, NOW)).parts.youtube!;
    expect(yt.totals).toEqual(EMPTY_TOTALS);
    expect(warn.mock.calls.filter((c) => c[0] === "yt_no_day_rows")).toHaveLength(1);
  });

  it("a YouTube record is read daily, and the owner's refresh on the YouTube path reads it (673, 735)", async () => {
    const u = await newUser("ytdaily");
    await saveConnection(u.email, ytConn());
    ytAnswers();
    expect(await syncSocialIfDue(u.email, NOW)).toBe(true);
    const s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.parts.youtube?.totals.views).toBe(155);
    expect(await syncSocialIfDue(u.email, new Date(NOW.getTime() + 19 * 3600e3))).toBe(false);
    // holdsSocial derives from READERS: the YouTube path answers sync_social, never 404 not_connected.
    expect(holdsSocial("youtube", ytConn())).toBe(true);
    await signIn(u.email);
    calls.length = 0;
    const r = await post("youtube", { action: "sync_social" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, read: true });
    expect(calls.map((c) => c.slug)).toContain("YOUTUBE_QUERY_ANALYTICS");
    await settle();
  });

  it("holds a Composio YouTube record with the channel chosen at connect, and the account falls back to the channel id", async () => {
    expect(holdsYt(ytConn())).toBe(true);
    expect(holdsYt(via("youtube", { youtube: "ca_yt" }))).toBe(false);
    for (const channelId of ["UC1", "channel==MINE", "UCddiUEpeqJc YeBxX1", "XXddiUEpeqJcYeBxX1IVBKvQ"]) expect(holdsYt(ytConn({ channelId })), channelId).toBe(false);
    expect(holdsYt(via("youtube", {}, { channelId: CH }))).toBe(false);
    expect(holdsYt({ provider: "youtube", data: { access_token: "t" }, meta: { channelId: CH }, connectedAt: NOW.toISOString() })).toBe(false);
    expect(holdsYt(null)).toBe(false);
    const u = await newUser("ytname");
    ytAnswers();
    const conn = ytConn();
    delete conn.meta!.account;
    expect((await syncSocial(u.email, { youtube: conn }, NOW)).parts.youtube?.account).toBe(`Channel ${CH}`);
    const marked = await syncSocial(u.email, { youtube: ytConn({ account: "<b>Ward</b>\n" + "y".repeat(120) }) }, NOW);
    expect(marked.parts.youtube!.account).not.toMatch(/[<>\n]/);
    expect(marked.parts.youtube!.account.length).toBeLessThanOrEqual(80);
  });

  it("links only to a video's watch page on www.youtube.com", () => {
    expect(ytUrl(vid(1))).toBe(`https://www.youtube.com/watch?v=${vid(1)}`);
    expect(ytUrl("dQw4w9WgX-_")).toBe("https://www.youtube.com/watch?v=dQw4w9WgX-_");
    for (const bad of ["vid0000001", "vid000000012", "vid00000/01", "vid0000000 ", "javascript:", "a&list=xyz1", "", "https://e.x"]) expect(ytUrl(bad), bad).toBeNull();
  });
});

const TT_FIELDS = ["follower_count", "likes_count", "video_count"];
const ttConn = (meta: Record<string, string> = {}) => via("tiktok", { tiktok: "ca_tt" }, { account: "TikTok", ...meta });
/** A nineteen-digit video id, as TikTok gives it: 7000000000000000001, 7000000000000000002, ... */
const ttId = (n: number) => `7${String(n).padStart(18, "0")}`;
/** The day `k` days before NOW (2026-10-08): the window is 2026-09-10 (back(28)) to 2026-10-07 (back(1)). */
const back = (k: number) => new Date(NOW.getTime() - k * 864e5).toISOString().slice(0, 10);
const ttVideo = (n: number, d: string, over: Record<string, unknown> = {}) => ({
  id: ttId(n), create_time: Date.parse(`${d}T12:00:00Z`) / 1000, title: `clip ${n}`, video_description: `about clip ${n}`, duration: 15,
  share_url: `https://www.tiktok.com/@ward/video/${ttId(n)}?utm_campaign=tt4d_open_api&utm_source=aw1`,
  view_count: 1000 + n, like_count: 50, comment_count: 4, share_count: 2, ...over,
});
/** One page of TIKTOK_LIST_VIDEOS, in TikTok's own shape. */
const page = (videos: unknown[], more = false, cursor: unknown = 0) => ok({ data: { videos, cursor, has_more: more } });
function ttAnswers(pages: Result[] = [page([ttVideo(1, back(3))])], followers: unknown = 1000) {
  answers.TIKTOK_GET_USER_STATS = ok({ data: { user: { follower_count: followers, following_count: 12, likes_count: 52000, video_count: 40 } } });
  answers.TIKTOK_LIST_VIDEOS = (a) => (a.cursor === undefined ? pages[0] : pages[1] ?? page([]));
}
const listCalls = () => calls.filter((c) => c.slug === "TIKTOK_LIST_VIDEOS").map((c) => c.args);

describe("TikTok account results (rule 742)", () => {
  it("reads stats with constant fields and at most two pages of videos (742)", async () => {
    const u = await newUser("ttread");
    await db.sadd(SOCIAL_PUB_KEY(u.email), ttId(1));
    // 35 videos inside the window, two a day, newest first; TikTok says there are more after the second page.
    const vids = Array.from({ length: 35 }, (_, i) => ttVideo(i + 1, back(1 + Math.floor(i / 2))));
    ttAnswers([page(vids.slice(0, 20), true, 1700000000000), page(vids.slice(20), true, 1690000000000)]);
    const snap = await syncSocial(u.email, { tiktok: ttConn() }, NOW);
    expect(calls.find((c) => c.slug === "TIKTOK_GET_USER_STATS")?.args).toEqual({ fields: TT_FIELDS });
    expect(listCalls()).toEqual([{ max_count: 20 }, { max_count: 20, cursor: 1700000000000 }]);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(JSON.stringify(c.args)).not.toMatch(/ca_tt|access_token|open_id/);

    const tt = snap.parts.tiktok!;
    expect(tt).toMatchObject({ platform: "tiktok", account: "TikTok", range: { from: "2026-09-10", to: "2026-10-07" }, followers: 1000 });
    // Lifetime counts are not the window's totals: likes_count and video_count are never stored as figures.
    expect(tt.totals).toEqual(EMPTY_TOTALS);
    expect(JSON.stringify(snap)).not.toMatch(/52000|"video_count"|"likes_count"/);
    expect(tt).not.toHaveProperty("prev");
    expect(tt.posts.map((p) => p.id)).toEqual(vids.slice(0, 30).map((v) => v.id));
    expect(tt.posts[0]).toEqual({ id: ttId(1), date: "2026-10-07", type: "VIDEO", caption: "clip 1", url: `https://www.tiktok.com/@ward/video/${ttId(1)}`, views: 1001, reach: null, likes: 50, comments: 4, shares: 2, saved: null, fromThakeen: true });
    expect(tt.posts[1].fromThakeen).toBe(false);
    expect(snap.errors).toEqual({});
    expect(snap.history).toEqual([{ month: "2026-10", platform: "tiktok", followers: 1000, totals: EMPTY_TOTALS }]);
    // Dana is told what TikTok's figures are, beside them.
    const block = await socialDataBlock(u.email, NOW);
    expect(block).toContain('"tiktok":{"account":"TikTok"');
    expect(block).toContain("On the TikTok account, only followers and posts are read");
  });

  it("an account with no public videos is read, with no posts (742)", async () => {
    const u = await newUser("ttnone");
    ttAnswers([page([], false, 0)]);
    const snap = await syncSocial(u.email, { tiktok: ttConn() }, NOW);
    expect(snap.parts.tiktok).toMatchObject({ followers: 1000, totals: EMPTY_TOTALS, posts: [] });
    expect(snap.errors).toEqual({});
    expect(listCalls()).toEqual([{ max_count: 20 }]);
    // An empty first page that says there is more is not paged: nothing on it shows the next page is in the window.
    ttAnswers([page([], true, 1700000000000)]);
    calls.length = 0;
    expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok?.posts).toEqual([]);
    expect(listCalls()).toEqual([{ max_count: 20 }]);
  });

  it("lifetime counters give a change only through history (742)", async () => {
    const u = await newUser("tthist");
    ttAnswers(undefined, 900);
    const sept = new Date("2026-09-08T09:00:00Z");
    expect((await syncSocial(u.email, { tiktok: ttConn() }, sept)).parts.tiktok).toMatchObject({ range: { from: "2026-08-11", to: "2026-09-07" }, followers: 900 });
    ttAnswers(undefined, 1000);
    const snap = await syncSocial(u.email, { tiktok: ttConn() }, NOW);
    expect(snap.parts.tiktok).not.toHaveProperty("prev");
    expect(snap.history).toEqual([
      { month: "2026-09", platform: "tiktok", followers: 900, totals: EMPTY_TOTALS },
      { month: "2026-10", platform: "tiktok", followers: 1000, totals: EMPTY_TOTALS },
    ]);
  });

  it("keeps only unique videos created inside the window, links only on tiktok.com (742)", async () => {
    const u = await newUser("ttposts");
    ttAnswers([page([
      ttVideo(1, "2026-10-08"), // today: after the window
      ttVideo(2, back(2), { title: "", video_description: "<b>ورد</b> طائفي\n" + "x".repeat(200) }),
      ttVideo(3, back(3), { share_url: "https://evil.example/@ward/video/3" }),
      ttVideo(4, back(4), { share_url: "http://www.tiktok.com/@ward/video/4" }),
      ttVideo(5, back(5), { share_url: "https://vm.tiktok.com/ZMabc/", view_count: "1234", like_count: "N/A", comment_count: {}, share_count: -1 }),
      ttVideo(6, back(6), { id: "../../me" }), // not a video id
      ttVideo(2, back(6), { title: "a repeat" }), // the same video again
      ttVideo(7, back(7), { create_time: "soon" }), // no date: not known to be in the window
      ttVideo(8, back(8), { create_time: 1e13 }), // a stamp no date can hold
      ttVideo(9, back(28), { title: "   ", video_description: "last day of the window" }),
      ttVideo(10, back(29)), // older than the window
    ], true, 1700000000000)]);
    const tt = (await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok!;
    // A video older than the window is on this page, so the next page is older still: it is never asked for.
    expect(listCalls()).toEqual([{ max_count: 20 }]);
    expect(tt.posts.map((p) => p.id)).toEqual([ttId(2), ttId(3), ttId(4), ttId(5), ttId(9)]);
    const [p2, p3, p4, p5, p9] = tt.posts;
    expect(p2.caption.length).toBeLessThanOrEqual(80);
    expect(p2.caption).not.toMatch(/[<>\n]/);
    expect(p2.caption.startsWith("bورد/b طائفي")).toBe(true);
    expect(p9).toMatchObject({ date: "2026-09-10", caption: "last day of the window" });
    expect([p2.url, p3.url, p4.url, p5.url]).toEqual([`https://www.tiktok.com/@ward/video/${ttId(2)}`, null, null, null]);
    // A count written in digits is read; anything else is not read, never zero.
    expect(p5).toMatchObject({ views: 1234, likes: null, comments: null, shares: null, reach: null, saved: null, type: "VIDEO" });
    const figures: unknown[] = [tt.followers, ...Object.values(tt.totals as Totals), ...tt.posts.flatMap((p) => [p.views, p.reach, p.likes, p.comments, p.shares, p.saved])];
    for (const v of figures) expect(clean(v), String(v)).toBe(true);
  });

  it("followers and the cursor tolerate strings, empty objects and junk (Review Focus 5)", async () => {
    const u = await newUser("ttjunk");
    const full = Array.from({ length: 20 }, (_, i) => ttVideo(i + 1, back(1)));
    for (const [followers, want] of [["1234", 1234], [{}, null], ["N/A", null], [-3, null], [Infinity, null], [0, 0]] as [unknown, number | null][]) {
      ttAnswers([page(full, false)], followers);
      expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok!.followers, String(followers)).toBe(want);
    }
    // A cursor that is not a whole number above zero is never sent: the read stops at the first page.
    for (const cursor of ["abc", -5, 1.5, "9".repeat(30), {}, 0, null]) {
      calls.length = 0;
      ttAnswers([page(full, true, cursor)]);
      expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok!.posts, String(cursor)).toHaveLength(20);
      expect(listCalls(), String(cursor)).toEqual([{ max_count: 20 }]);
    }
    // A cursor written in digits is sent as the number it is.
    calls.length = 0;
    ttAnswers([page(full, true, "1700000000000")]);
    await syncSocial(u.email, { tiktok: ttConn() }, NOW);
    expect(listCalls()).toEqual([{ max_count: 20 }, { max_count: 20, cursor: 1700000000000 }]);
  });

  it("a refused token ends the read; one failed side keeps the other; nothing read is a failed read", async () => {
    const u = await newUser("ttfail");
    ttAnswers();
    answers.TIKTOK_GET_USER_STATS = { successful: false, error: "Token has been expired or revoked." };
    await expect(syncSocial(u.email, { tiktok: ttConn() }, NOW)).rejects.toMatchObject({ provider: "tiktok", message: expect.stringMatching(/ 401:/) });
    expect(await getSocialSnapshot(u.email)).toBeNull();

    // A refused token on the second page too.
    const full = Array.from({ length: 20 }, (_, i) => ttVideo(i + 1, back(1)));
    ttAnswers([page(full, true, 1700000000000), { successful: false, error: "Unauthorized" }]);
    await expect(syncSocial(u.email, { tiktok: ttConn() }, NOW)).rejects.toMatchObject({ provider: "tiktok", message: expect.stringMatching(/ 401:/) });
    // Any other failure of the second page keeps the first.
    ttAnswers([page(full, true, 1700000000000), { successful: false, error: "internal_error" }]);
    expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok?.posts).toHaveLength(20);

    // Failed stats keep the videos; a failed list keeps the followers.
    ttAnswers();
    answers.TIKTOK_GET_USER_STATS = { successful: false, error: "internal_error" };
    expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok).toMatchObject({ followers: null, posts: [{ id: ttId(1) }] });
    ttAnswers();
    answers.TIKTOK_LIST_VIDEOS = { successful: false, error: "internal_error" };
    expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok).toMatchObject({ followers: 1000, posts: [] });

    // Both failing: the account is not read and the last read stands.
    answers.TIKTOK_GET_USER_STATS = { successful: false, error: "internal_error" };
    const kept = await getSocialSnapshot(u.email);
    await expect(syncSocial(u.email, { tiktok: ttConn() }, NOW)).rejects.toMatchObject({ provider: "tiktok", message: expect.stringMatching(/ 502:/) });
    expect(await getSocialSnapshot(u.email)).toEqual(kept);
  });

  it("a scope refusal is a known state, never a refused token, and the record is not marked for reconnect", async () => {
    const u = await newUser("ttscope");
    await saveConnection(u.email, ttConn());
    // TikTok's words when the app or the login lacks user.info.stats or video.list; the adapter reads "Unauthorized" as 401.
    ttAnswers();
    answers.TIKTOK_GET_USER_STATS = { successful: false, error: "Unauthorized: scope_not_authorized: The user did not authorize the scope required for completing this request." };
    const one = await syncSocial(u.email, { tiktok: ttConn() }, NOW);
    expect(one.errors).toEqual({ tiktok: "tt_no_scope" });
    expect(one.parts.tiktok).toMatchObject({ followers: null, posts: [{ id: ttId(1) }] });
    expect(one.parts.tiktok).not.toHaveProperty("known");
    // Both refused: no part, written and not thrown, and the TikTok record (which also publishes) stays connected.
    answers.TIKTOK_LIST_VIDEOS = { successful: false, error: "scope_permission_missed" };
    expect(await syncSocialIfDue(u.email, NOW, true)).toBe(true);
    expect(await getSocialSnapshot(u.email)).toMatchObject({ v: 2, parts: {}, errors: { tiktok: "tt_no_scope" } });
    expect((await getConnection(u.email, "tiktok"))?.needsReconnect).toBeFalsy();
  });

  it("a scope refusal the client throws keeps its words through the adapter: tt_no_scope, no reconnect (742)", async () => {
    const u = await newUser("ttscopethrown");
    await saveConnection(u.email, ttConn());
    vi.spyOn(console, "error").mockImplementation(() => {});
    ttAnswers();
    answers.TIKTOK_GET_USER_STATS = () => { throw new Error("Unauthorized: scope_not_authorized: The user did not authorize the scope required for completing this request."); };
    expect(await syncSocialIfDue(u.email, NOW, true)).toBe(true);
    const s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.errors).toEqual({ tiktok: "tt_no_scope" });
    expect(s?.v === 2 && s.parts.tiktok).toMatchObject({ followers: null, posts: [{ id: ttId(1) }] });
    expect((await getConnection(u.email, "tiktok"))?.needsReconnect).toBeFalsy();
    // Any other thrown text keeps only the adapter's own word: a refused token still asks for a reconnect.
    answers.TIKTOK_GET_USER_STATS = () => { throw new Error("Unauthorized: token revoked for open_id 123"); };
    answers.TIKTOK_LIST_VIDEOS = () => { throw new Error("Unauthorized: token revoked for open_id 123"); };
    await expect(syncSocialIfDue(u.email, NOW, true)).rejects.toThrow("reconnect_required");
    expect((await getConnection(u.email, "tiktok"))?.needsReconnect).toBeTruthy();
  });

  it("tt_no_scope only when every failed call was a scope refusal; another failure beside one is a failed read (742)", async () => {
    const u = await newUser("ttscopemixed");
    ttAnswers();
    await syncSocial(u.email, { tiktok: ttConn() }, NOW);
    const kept = await getSocialSnapshot(u.email);
    const scope = { successful: false, error: "scope_not_authorized" };
    const broken = { successful: false, error: "internal_error" };
    // Stats refused for a scope, videos failing otherwise: not a scope state, so the last read stands.
    answers.TIKTOK_GET_USER_STATS = scope;
    answers.TIKTOK_LIST_VIDEOS = broken;
    await expect(syncSocial(u.email, { tiktok: ttConn() }, NOW)).rejects.toMatchObject({ provider: "tiktok", message: expect.stringMatching(/ 502: list_videos internal_error/) });
    expect(await getSocialSnapshot(u.email)).toEqual(kept);
    // The other way round.
    answers.TIKTOK_GET_USER_STATS = broken;
    answers.TIKTOK_LIST_VIDEOS = scope;
    await expect(syncSocial(u.email, { tiktok: ttConn() }, NOW)).rejects.toMatchObject({ provider: "tiktok", message: expect.stringMatching(/ 502: get_user_stats internal_error/) });
    expect(await getSocialSnapshot(u.email)).toEqual(kept);
    // Both refused for a scope: the known state, written.
    answers.TIKTOK_GET_USER_STATS = scope;
    answers.TIKTOK_LIST_VIDEOS = scope;
    expect((await syncSocial(u.email, { tiktok: ttConn() }, NOW)).errors).toEqual({ tiktok: "tt_no_scope" });
  });

  it("no second page is asked past the shared deadline (741)", async () => {
    const u = await newUser("ttdeadline");
    const full = Array.from({ length: 20 }, (_, i) => ttVideo(i + 1, back(1)));
    const first = page(full, true, 1700000000000);
    ttAnswers([first, page([ttVideo(30, back(2))])]);
    answers.TIKTOK_LIST_VIDEOS = (a) => { vi.setSystemTime(NOW.getTime() + 31_000); return a.cursor === undefined ? first : page([]); };
    const tt = (await syncSocial(u.email, { tiktok: ttConn() }, NOW)).parts.tiktok!;
    expect(listCalls()).toEqual([{ max_count: 20 }]);
    expect(tt).toMatchObject({ followers: 1000 });
    expect(tt.posts).toHaveLength(20);
  });

  it("a TikTok record is read daily, and the owner's refresh on the TikTok path reads it (673, 735)", async () => {
    const u = await newUser("ttdaily");
    await saveConnection(u.email, ttConn());
    ttAnswers();
    expect(await syncSocialIfDue(u.email, NOW)).toBe(true);
    const s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.parts.tiktok?.followers).toBe(1000);
    expect(await syncSocialIfDue(u.email, new Date(NOW.getTime() + 19 * 3600e3))).toBe(false);
    // holdsSocial derives from READERS: the TikTok path answers sync_social and reads, never 404 not_connected.
    expect(holdsSocial("tiktok", ttConn())).toBe(true);
    await signIn(u.email);
    calls.length = 0;
    const r = await post("tiktok", { action: "sync_social" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, read: true });
    expect(calls.map((c) => c.slug).sort()).toEqual(["TIKTOK_GET_USER_STATS", "TIKTOK_LIST_VIDEOS"]);
    await settle();
  });

  it("holds a Composio TikTok record with its account, and the account label is cleaned", async () => {
    expect(holdsTt(ttConn())).toBe(true);
    expect(holdsTt(via("tiktok", {}))).toBe(false);
    expect(holdsTt(via("tiktok", { youtube: "ca_yt" }))).toBe(false);
    expect(holdsTt({ provider: "tiktok", data: { access_token: "t", tiktok: "x" }, meta: {}, connectedAt: NOW.toISOString() })).toBe(false);
    expect(holdsTt(null)).toBe(false);
    const u = await newUser("ttname");
    ttAnswers();
    const conn = ttConn();
    delete conn.meta!.account;
    expect((await syncSocial(u.email, { tiktok: conn }, NOW)).parts.tiktok?.account).toBe("TikTok");
    const marked = await syncSocial(u.email, { tiktok: ttConn({ account: "<b>Ward</b>\n" + "y".repeat(120) }) }, NOW);
    expect(marked.parts.tiktok!.account).not.toMatch(/[<>\n]/);
    expect(marked.parts.tiktok!.account.length).toBeLessThanOrEqual(80);
  });

  it("links only to a page on tiktok.com or www.tiktok.com over https, without its query string", () => {
    expect(ttUrl(`https://www.tiktok.com/@ward/video/${ttId(1)}?utm_campaign=tt4d_open_api&utm_source=aw1#top`)).toBe(`https://www.tiktok.com/@ward/video/${ttId(1)}`);
    expect(ttUrl("https://tiktok.com/@ward/video/1")).toBe("https://tiktok.com/@ward/video/1");
    expect(ttUrl("https://user:pass@www.tiktok.com/@ward/video/1")).toBe("https://www.tiktok.com/@ward/video/1");
    for (const bad of [
      "http://www.tiktok.com/@ward/video/1", "https://m.tiktok.com/v/1.html", "https://vm.tiktok.com/ZMabc/", "https://www.tiktok.com.evil.example/x",
      "https://www.tiktok.com:8443/@ward/video/1", "javascript:alert(1)", "not a link", 42, null,
    ]) expect(ttUrl(bad), String(bad)).toBeNull();
  });
});

describe("review of the whole phase (rules 735, 739, 740, 742)", () => {
  it("a 403 that is not a refused token (a quota or permission answer) asks no record to reconnect (735)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // YouTube's quota answer carries a 403 but is no refused token: the read fails as it is and the channel stays connected.
    const yt = await newUser("ytquota");
    await saveConnection(yt.email, ytConn());
    const quota = { successful: false, error: "HttpError 403 quotaExceeded: The request cannot be completed because you have exceeded your quota." };
    answers.YOUTUBE_LIST_CHANNELS = quota;
    answers.YOUTUBE_QUERY_ANALYTICS = quota;
    answers.YOUTUBE_LIST_CHANNEL_VIDEOS = quota;
    await expect(syncSocialIfDue(yt.email, NOW, true)).rejects.toMatchObject({ provider: "youtube", message: expect.stringMatching(/ 502:/) });
    expect((await getConnection(yt.email, "youtube"))?.needsReconnect).toBeFalsy();
    await signIn(yt.email);
    const r = await post("youtube", { action: "sync_social" });
    expect(r.status).toBe(502);
    expect((await r.json()).error).not.toBe("reconnect_required");
    expect((await getConnection(yt.email, "youtube"))?.needsReconnect).toBeFalsy();

    // The Facebook Page: a 403 that is not about read_insights, on both sides, is a failed read and no reconnect either.
    const fb = await newUser("fbforbid");
    await saveConnection(fb.email, fbConn());
    // Not one of Graph's permission codes (#10, #200), which are fb_no_insights.
    const forbidden = { successful: false, error: "(#368) Forbidden 403: the action attempted is not allowed" };
    answers.FACEBOOK_GET_PAGE_INSIGHTS = forbidden;
    answers.FACEBOOK_GET_PAGE_POSTS = forbidden;
    await signIn(fb.email);
    const f = await post("meta", { action: "sync_social" });
    expect(f.status).toBe(502);
    expect((await f.json()).error).toMatch(/ 502:/);
    expect((await getConnection(fb.email, "meta"))?.needsReconnect).toBeFalsy();
  });

  it("every part whose token was refused asks its own record to reconnect, not only the first (735)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const u = await newUser("tworefused");
    await Promise.all([saveConnection(u.email, both()), saveConnection(u.email, ytConn())]);
    fbAnswers();
    igAnswers();
    ytAnswers();
    const expired = { successful: false, error: "Token has been expired or revoked." };
    answers.INSTAGRAM_GET_USER_INFO = expired;
    answers.YOUTUBE_LIST_CHANNEL_VIDEOS = expired;
    await signIn(u.email);
    const r = await post("youtube", { action: "sync_social" });
    // The Page was read and saved; the first refused part in PLATFORMS order (Instagram, on the Meta record) names the answer.
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, read: true, reconnect: "meta" });
    const [meta, yt] = await Promise.all([getConnection(u.email, "meta"), getConnection(u.email, "youtube")]);
    expect(meta?.needsReconnect, "Instagram's record").toBeTruthy();
    expect(yt?.needsReconnect, "the channel's record too").toBeTruthy();
    const s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && Object.keys(s.parts)).toEqual(["facebook"]);
    expect(s?.v === 2 && s.errors).toEqual({ instagram: "read_failed", youtube: "read_failed" });
  });

  it("connecting the Facebook Page, a YouTube channel or a TikTok account reads its results at once (739, 740, 742)", async () => {
    const u = await newUser("connread");
    owned.push("ca_fb", "ca_yt", "ca_tt");
    const finish = async (provider: string, toolkit: string, accountId: string) => {
      const st = `st-${Math.random().toString(16).slice(2)}`;
      await saveState(st, { email: u.email, provider, lang: "en", shop: "", verifier: "", via: "composio", toolkit, accountId });
      await signIn(u.email);
      jar().set(OAUTH_COOKIE, st);
      const res = await callbackRoute.GET(new Request(`https://app.test/api/connect/${provider}/callback?state=${st}`), ctx(provider));
      await settle();
      return new URL(res.headers.get("location")!).searchParams;
    };
    answers.FACEBOOK_LIST_MANAGED_PAGES = ok({ data: [{ id: "123", name: "عود الشرق" }] });
    fbAnswers();
    expect((await finish("meta", "facebook", "ca_fb")).get("connected")).toBe("meta");
    let s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.parts.facebook?.followers).toBe(512);

    ytAnswers();
    const channels = answers.YOUTUBE_LIST_CHANNELS;
    // The connect asks for the channel's snippet (its id and title), the reader for its statistics.
    answers.YOUTUBE_LIST_CHANNELS = (a) => (a.part === "snippet" ? ok({ data: { items: [{ kind: "youtube#channel", id: CH, snippet: { title: "Ward TV" } }] } }) : (channels as Result));
    expect((await finish("youtube", "youtube", "ca_yt")).get("connected")).toBe("youtube");
    s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.parts.youtube?.followers).toBe(5000);

    ttAnswers();
    expect((await finish("tiktok", "tiktok", "ca_tt")).get("connected")).toBe("tiktok");
    s = await getSocialSnapshot(u.email);
    expect(s?.v === 2 && s.parts.tiktok?.followers).toBe(1000);
    expect(s?.v === 2 && Object.keys(s.parts).sort()).toEqual(["facebook", "tiktok", "youtube"]);
  });

  it("each part keeps its account id from the stored connection only; TikTok, which stores none, has none (746)", async () => {
    const u = await newUser("accountids");
    fbAnswers();
    ytAnswers();
    ttAnswers();
    const s = await syncSocial(u.email, { meta: fbConn(), youtube: ytConn(), tiktok: ttConn() }, NOW);
    expect(s.parts.facebook?.accountId).toBe("123");
    expect(s.parts.youtube?.accountId).toBe(CH);
    expect(s.parts.tiktok).not.toHaveProperty("accountId");
    // Another Page id drops the Page's history even under the same name; the channel renamed keeps its rows.
    const dec = new Date(Date.UTC(2026, 11, 1, 0, 30));
    const next = await syncSocial(u.email, { meta: fbConn({ pageId: "456" }), youtube: ytConn({ account: "Ward TV 2" }), tiktok: ttConn() }, dec);
    expect(next.history.filter((r) => r.platform === "facebook").map((r) => r.month)).toEqual(["2026-12"]);
    expect(next.history.filter((r) => r.platform === "youtube").map((r) => r.month)).toEqual(["2026-10", "2026-12"]);
  });

  it("choosing another Facebook Page reads it at once while the workspace's six social reads an hour last (739)", async () => {
    const u = await newUser("fbpick");
    await saveConnection(u.email, fbConn({ pages: JSON.stringify([{ id: "123", name: "عود الشرق", ig: "" }, { id: "456", name: "Ward", ig: "" }]) }));
    fbAnswers();
    await signIn(u.email);
    const r = await post("meta", { action: "select_page", pageId: "456" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, read: true });
    await settle();
    expect(calls.find((c) => c.slug === "FACEBOOK_GET_PAGE_INSIGHTS")?.args.page_id, "the new Page, from the record").toBe("456");
    // The bucket is the sync_social one: once the six are spent, the choice is still saved and nothing is read.
    for (let i = 0; i < 5; i++) expect((await post("meta", { action: "sync_social" })).status, `refresh ${i + 1}`).toBe(200);
    calls.length = 0;
    const late = await post("meta", { action: "select_page", pageId: "123" });
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ ok: true, read: false });
    await settle();
    expect(calls).toEqual([]);
    expect((await getConnection(u.email, "meta"))?.meta?.pageId).toBe("123");
  });
});
