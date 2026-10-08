import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newUser, settle, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { setComposioClientForTests } from "@/lib/connectors/composio";
import { EMPTY_TOTALS, SOCIAL_PUB_KEY, getSocialSnapshot, holdsSocial, socialDataBlock, syncSocial, syncSocialIfDue, type Totals } from "@/lib/social-stats";
import { fbUrl, holdsFb } from "@/lib/social-read/facebook";
import * as connRoute from "@/app/api/connect/[provider]/route";
import { fakeComposio, ok, type Answer, type Call, type Result } from "./helpers/composio-fake";

/**
 * Rule 739 (spec docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md, B1): the Facebook Page chosen for
 * publishing, read through Composio with constant metrics and fields: 56 days of daily insights split into the window and
 * the 28 days before it, the Page's own posts inside the window, and each post's lifetime views and reach. Amends 663 (the
 * three reads are reads only), 664 (the Page is a part beside Instagram) and 673 (a Facebook-only record with a Page is
 * read daily). Composio is the shared fake; answers follow the Graph API shapes Composio passes through (`data.data`).
 */
const NOW = new Date("2026-10-08T09:00:00Z");

let calls: Call[];
let answers: Record<string, Answer>;
beforeEach(() => {
  const f = fakeComposio();
  ({ calls, answers } = f);
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
