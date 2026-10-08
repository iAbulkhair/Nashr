import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newMember, newUser, settle, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { wipeAccount } from "@/lib/account";
import { saveTask, type Task } from "@/lib/brand";
import { publishOnce } from "@/lib/publish-once";
import * as publish from "@/lib/connectors/publish";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import * as fresh from "@/lib/connectors/fresh";
import { setComposioClientForTests } from "@/lib/connectors/composio";
import { EMPTY_TOTALS, PLATFORMS, READERS, SOCIAL_DEADLINE_MS, SOCIAL_KEY, SOCIAL_PUB_KEY, beforeDeadline, getSocialSnapshot, holdsSocial, rangeBefore, socialDataBlock, socialForPage, splitDays, syncSocial, syncSocialIfDue, upsertHistory, type HistoryRow, type Platform, type PlatformPart, type SocialSnapshot } from "@/lib/social-stats";
import { connectedSources, reportSources, socialRead } from "@/lib/report-sources";
import SocialStats from "@/components/app/SocialStats";
import { syncSiteIfDue } from "@/lib/site-stats";
import { OWNER_SYNC_KEY, ROUTINES } from "@/lib/routines";
import * as connRoute from "@/app/api/connect/[provider]/route";
import { fakeComposio, ok, type Answer, type Call } from "./helpers/composio-fake";

/**
 * Rules 735 and 736 (spec docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md, A4 and A7): any member
 * may refresh the social results at once, free, six times an hour per workspace (the bucket is the workspace's, so the
 * team and every social path share it); a refusal is 429 with Retry-After. The click, never the daily cron's read, counts
 * as activity for Dana's weekly-report routine (`ownersync:{scope}`). Rules 737 and 746 (A8, section 7): the social
 * snapshot v2, one part per platform with `null` for a figure not read, a v1 snapshot read as "not read yet" and due, and
 * the monthly history. Rules 733 and 741 (A2, B4): the previous period each social reader reads in the same run, and the
 * one 30-second deadline every reader shares. Rule 748 (B3): the LinkedIn page's own views. Composio is the shared fake; its
 * answers follow the Instagram, LinkedIn, GA4 and Search Console shapes the reader tests use.
 */
const NOW = new Date("2026-10-08T09:00:00Z");
const HOUR = 3600e3;

let calls: Call[];
let answers: Record<string, Answer>;
beforeEach(() => {
  const f = fakeComposio();
  ({ calls, answers } = f);
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "meta,linkedin,google");
  setComposioClientForTests(f.client);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

const via = (provider: string, data: Record<string, string>, meta: Record<string, string> = {}): Connection => ({ provider, data, meta: { via: "composio", ...meta }, connectedAt: NOW.toISOString() });
const igConn = (igId = "1784") => via("meta", { instagram: "ca_ig" }, { igId });
const liConn = () => via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc", liOrg: "urn:li:organization:42" });
const google = () => via("google", { google_analytics: "ca_ga", google_search_console: "ca_gsc" }, { gaProperty: "properties/987", gscSite: "sc-domain:roastery.example" });

/** An Instagram account with no posts in the window: four calls a read (the account, its two periods, its posts). */
function igAnswers() {
  answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "oud", followers_count: 1200 } });
  answers.INSTAGRAM_GET_USER_INSIGHTS = ok({ data: { data: [{ name: "reach", total_value: { value: 5400 } }, { name: "views", total_value: { value: 9100 } }] } });
  answers.INSTAGRAM_GET_IG_USER_MEDIA = ok({ data: { data: [] } });
}
/** The end LinkedIn was asked for, in ms, from the RestLi interval of a share-statistics call. */
const liEnd = (a: Record<string, unknown>) => Number(/end:(\d+)/.exec(String(a.time_intervals))?.[1]);
/** One day of the page's share statistics, dated `back` whole days before the end LinkedIn was asked for. */
const liDay = (end: number, back: number, impressionCount: number | string, clickCount = 0, likeCount = 0, commentCount = 0, shareCount = 0) =>
  ({ timeRange: { start: end - back * 864e5, end: end - (back - 1) * 864e5 }, totalShareStatistics: { impressionCount, clickCount, likeCount, commentCount, shareCount } });
/**
 * The page's last day only: inside the window whatever the read's date, so there is no previous period. The page's own
 * statistics answer no day, so its page views stay null (rule 748 sets them where a test reads them).
 */
function liAnswers() {
  answers.LINKEDIN_GET_SHARE_STATS = (a) => ok({ elements: [liDay(liEnd(a), 1, 900, 9, 4, 1, 0)] });
  answers.LINKEDIN_GET_NETWORK_SIZE = ok({ firstDegreeSize: 812 });
  answers.LINKEDIN_GET_ORG_PAGE_STATS = ok({ elements: [] });
}
const media = (n: number) => ({ id: `m${n}`, caption: `post ${n}`, media_type: "IMAGE", permalink: `https://www.instagram.com/p/${n}/`, timestamp: "2026-10-01T10:00:00+0000" });
function siteAnswers() {
  answers.GOOGLE_ANALYTICS_RUN_REPORT = ok({ rows: [] });
  answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = ok({ rows: [] });
}

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const post = (provider: string, body: Record<string, unknown>) => connRoute.POST(json(`/api/connect/${provider}`, "POST", body), ctx(provider));
/** Dana's weekly-report gate for one workspace, as the routine runner calls it: null opens it, "idle" keeps it shut. */
const danaGate = (scope: string, now = NOW) => ROUTINES.find((r) => r.id === "dana_weekly_report")!.gate({ scope, last: null, lite: [], now: now.getTime() });

describe("the owner's refresh of the social results (rule 735)", () => {
  it("sync_social is free, any member may press it, six an hour per workspace (735)", async () => {
    const owner = await newUser("socsync");
    await Promise.all([saveConnection(owner.email, igConn()), saveConnection(owner.email, liConn())]);
    igAnswers();
    liAnswers();
    const start = (await getUser(owner.email))!.credits;
    const member = await newMember(owner, "member");
    await signIn(member.email);
    for (let i = 0; i < 6; i++) {
      const r = await post("meta", { action: "sync_social" });
      expect(r.status, `click ${i + 1}`).toBe(200);
      expect(await r.json()).toEqual({ ok: true, read: true });
    }
    // Each click read every held part at once: Instagram and the LinkedIn page, six times.
    expect(calls.filter((c) => c.slug === "INSTAGRAM_GET_USER_INFO")).toHaveLength(6);
    expect(calls.filter((c) => c.slug === "LINKEDIN_GET_SHARE_STATS")).toHaveLength(6);

    // The seventh in the hour is refused for the whole workspace: the owner, and on the LinkedIn path too.
    calls.length = 0;
    vi.setSystemTime(NOW.getTime() + 600e3);
    await signIn(owner.email);
    for (const provider of ["meta", "linkedin"]) {
      const r = await post(provider, { action: "sync_social" });
      expect(r.status, provider).toBe(429);
      expect(r.headers.get("Retry-After")).toBe("3600");
      expect(await r.json()).toEqual({ ok: false, error: "slow_down" });
    }
    expect(calls, "a refused click reads nothing").toEqual([]);
    expect(await db.get(OWNER_SYNC_KEY(owner.email)), "nor is it activity: the mark is the last allowed click's").toBe(NOW.toISOString());
    expect((await getUser(owner.email))!.credits, "free: no credit leaves the account").toBe(start);

    // Another workspace has its own six; this one has six again once the hour is over.
    const other = await newUser("socsync2");
    await saveConnection(other.email, igConn());
    await signIn(other.email);
    expect((await post("meta", { action: "sync_social" })).status).toBe(200);
    vi.setSystemTime(NOW.getTime() + HOUR + 1000);
    await signIn(owner.email);
    expect((await post("linkedin", { action: "sync_social" })).status).toBe(200);
  });

  it("a refresh reads every held part at once, whatever the last read's age (735)", async () => {
    const owner = await newUser("socforce");
    await Promise.all([saveConnection(owner.email, igConn()), saveConnection(owner.email, liConn())]);
    igAnswers();
    liAnswers();
    // Read an hour ago: the daily run would not read again for 19 hours.
    await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, new Date(NOW.getTime() - HOUR));
    expect(await syncSocialIfDue(owner.email, NOW)).toBe(false);
    calls.length = 0;
    await signIn(owner.email);
    const r = await post("linkedin", { action: "sync_social" });
    expect(await r.json()).toEqual({ ok: true, read: true });
    expect(calls.map((c) => c.slug).sort()).toEqual(["INSTAGRAM_GET_IG_USER_MEDIA", "INSTAGRAM_GET_USER_INFO", "INSTAGRAM_GET_USER_INSIGHTS", "INSTAGRAM_GET_USER_INSIGHTS", "LINKEDIN_GET_NETWORK_SIZE", "LINKEDIN_GET_ORG_PAGE_STATS", "LINKEDIN_GET_SHARE_STATS"]);
    expect((await getSocialSnapshot(owner.email))?.at).toBe(NOW.toISOString());
  });

  it("sync_social on a provider that holds no part is 404 not_connected", async () => {
    const owner = await newUser("socnone");
    await signIn(owner.email);
    igAnswers();
    // No record at all.
    const none = await post("meta", { action: "sync_social" });
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ ok: false, error: "not_connected" });
    // A direct Meta record, a Facebook-only Composio record with no Page chosen (or an id that is not one), a LinkedIn
    // record with no page chosen, a YouTube record whose channel id is not one (rule 740 reads only a UC channel id
    // chosen at connect), and a TikTok record without its account or a direct one (rule 742): none holds a part this
    // path reads.
    const held: [string, Connection][] = [
      ["meta", { provider: "meta", data: { access_token: "t" }, meta: { pageId: "1", igId: "1784" }, connectedAt: NOW.toISOString() }],
      ["meta", via("meta", { facebook: "ca_fb" })],
      ["meta", via("meta", { facebook: "ca_fb" }, { pageId: "p-1" })],
      ["linkedin", via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc" })],
      ["youtube", via("youtube", { youtube: "ca_yt" }, { channelId: "UC1" })],
      ["tiktok", via("tiktok", {})],
      ["tiktok", { provider: "tiktok", data: { access_token: "t", tiktok: "x" }, meta: {}, connectedAt: NOW.toISOString() }],
    ];
    for (const [provider, c] of held) {
      await saveConnection(owner.email, c);
      const r = await post(provider, { action: "sync_social" });
      expect(r.status, provider).toBe(404);
      expect((await r.json()).error).toBe("not_connected");
    }
    // The action belongs to the social paths only: on Google's it is not an action at all.
    await saveConnection(owner.email, google());
    expect((await post("google", { action: "sync_social" })).status).toBe(400);
    await settle();
    expect(calls).toEqual([]);
    expect(await db.get(OWNER_SYNC_KEY(owner.email)), "a refused click is not activity").toBeNull();
    // None of the refusals spent the hour's six.
    await saveConnection(owner.email, igConn());
    for (let i = 0; i < 6; i++) expect((await post("meta", { action: "sync_social" })).status).toBe(200);
  });

  it("a refused token is converted inside syncSocialIfDue only, for the part that was refused (735)", async () => {
    const owner = await newUser("socrefused");
    await Promise.all([saveConnection(owner.email, igConn()), saveConnection(owner.email, liConn())]);
    await signIn(owner.email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const convert = vi.spyOn(fresh, "refusedToken");
    // Pressed on the LinkedIn path: Instagram's token is refused and the LinkedIn read fails, so nothing is read.
    answers.INSTAGRAM_GET_USER_INFO = { successful: false, error: "expired token" };
    answers.INSTAGRAM_GET_USER_INSIGHTS = { successful: false, error: "expired token" };
    answers.INSTAGRAM_GET_IG_USER_MEDIA = { successful: false, error: "expired token" };
    answers.LINKEDIN_GET_SHARE_STATS = { successful: false, error: "Internal error (500)" };
    answers.LINKEDIN_GET_NETWORK_SIZE = { successful: false, error: "Internal error (500)" };
    const r = await post("linkedin", { action: "sync_social" });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: "reconnect_required" });
    // The reader converted it with the refused part's provider; the route never converts with its path's provider.
    expect(convert.mock.calls.map((c) => c[1])).toEqual(["meta"]);
    const [meta, linkedin] = await Promise.all([getConnection(owner.email, "meta"), getConnection(owner.email, "linkedin")]);
    expect(meta?.needsReconnect).toBe(NOW.toISOString());
    expect(linkedin?.needsReconnect, "the path's own record is not asked to reconnect").toBeUndefined();
  });

  it("a read that saved the snapshot while one part's token was refused answers 200 with that part to reconnect (735)", async () => {
    const owner = await newUser("socpartial");
    await Promise.all([saveConnection(owner.email, igConn()), saveConnection(owner.email, liConn())]);
    await signIn(owner.email);
    igAnswers();
    answers.LINKEDIN_GET_SHARE_STATS = { successful: false, error: "token expired" };
    answers.LINKEDIN_GET_NETWORK_SIZE = { successful: false, error: "token expired" };
    const r = await post("meta", { action: "sync_social" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, read: true, reconnect: "linkedin" });
    const snap = await getSocialSnapshot(owner.email);
    expect(snap).toMatchObject({ v: 2, at: NOW.toISOString(), parts: { instagram: { followers: 1200 } } });
    expect(snap?.v === 2 && snap.parts.linkedin).toBeUndefined();
    const [meta, linkedin] = await Promise.all([getConnection(owner.email, "meta"), getConnection(owner.email, "linkedin")]);
    expect(linkedin?.needsReconnect).toBe(NOW.toISOString());
    expect(meta?.needsReconnect, "the part that read is not asked to reconnect").toBeUndefined();
    expect(await db.get(OWNER_SYNC_KEY(owner.email)), "the click counts").toBe(NOW.toISOString());

    // The daily run reads the same way and still reports the reconnect it needs.
    await saveConnection(owner.email, liConn());
    await expect(syncSocialIfDue(owner.email, NOW, true)).rejects.toThrow("reconnect_required");
    expect(await getSocialSnapshot(owner.email)).toMatchObject({ parts: { instagram: { followers: 1200 } } });
  });

  it("a read whose other parts were only known states is no read: a refused token stays 502 reconnect_required (735)", async () => {
    const owner = await newUser("socknownonly");
    await Promise.all([saveConnection(owner.email, igConn()), saveConnection(owner.email, liConn())]);
    await signIn(owner.email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Instagram answers that the account is not professional (a known state, no figure read); LinkedIn's token is refused.
    answers.INSTAGRAM_GET_USER_INFO = { successful: false, error: "(#100) Unsupported get request." };
    answers.LINKEDIN_GET_SHARE_STATS = { successful: false, error: "token expired" };
    answers.LINKEDIN_GET_NETWORK_SIZE = { successful: false, error: "token expired" };
    answers.LINKEDIN_GET_ORG_PAGE_STATS = { successful: false, error: "token expired" };
    const r = await post("meta", { action: "sync_social" });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: "reconnect_required" });
    expect((await getConnection(owner.email, "linkedin"))?.needsReconnect).toBe(NOW.toISOString());
    // The known state is still written, beside no part: the card says it, and nothing claims a read.
    expect(await getSocialSnapshot(owner.email)).toMatchObject({ v: 2, parts: {}, errors: { instagram: "ig_not_professional", linkedin: "read_failed" } });
    await expect(syncSocialIfDue(owner.email, NOW, true)).resolves.toBe(true);

    // One part actually read beside the refused one is a read: 200 with the part to reconnect.
    await saveConnection(owner.email, liConn());
    igAnswers();
    const read = await post("meta", { action: "sync_social" });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: true, read: true, reconnect: "linkedin" });
  });
});

describe("Dana's routine counts the owner's click, never the cron's read (rule 736)", () => {
  it("an owner click opens Dana's gate; the cron's site and social reads do not (736)", async () => {
    const owner = await newUser("socgate");
    await Promise.all([saveConnection(owner.email, igConn()), saveConnection(owner.email, google())]);
    igAnswers();
    siteAnswers();
    // The daily cron's reads, forced so both certainly run: the snapshots are fresh, and the gate stays shut.
    expect(await syncSiteIfDue(owner.email, NOW, true)).toBe(true);
    expect(await syncSocialIfDue(owner.email, NOW, true)).toBe(true);
    expect(await danaGate(owner.email)).toBe("idle");
    expect(await db.get(OWNER_SYNC_KEY(owner.email))).toBeNull();

    await signIn(owner.email);
    expect((await post("google", { action: "sync_site" })).status).toBe(200);
    expect(await db.get(OWNER_SYNC_KEY(owner.email))).toBe(NOW.toISOString());
    expect(await danaGate(owner.email)).toBeNull();
    // Seven days on the click no longer counts, and the mark itself is gone after eight.
    expect(await danaGate(owner.email, new Date(NOW.getTime() + 7 * 24 * HOUR + 1000))).toBe("idle");
    vi.setSystemTime(NOW.getTime() + 8 * 24 * HOUR + 1000);
    expect(await db.get(OWNER_SYNC_KEY(owner.email))).toBeNull();
  });

  it("a member's sync_social counts, even when the platform fails; another workspace's gate stays shut (736)", async () => {
    const owner = await newUser("socgate2");
    await saveConnection(owner.email, igConn());
    const member = await newMember(owner, "member");
    await signIn(member.email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    answers.INSTAGRAM_GET_USER_INFO = { successful: false, error: "Internal error (500)" };
    const r = await post("meta", { action: "sync_social" });
    expect(r.status).toBe(502);
    expect(await danaGate(owner.email)).toBeNull();
    const other = await newUser("socgate3");
    expect(await danaGate(other.email)).toBe("idle");
  });
});

describe("the social snapshot v2 and its history (rules 737, 746; amended 664, 667, 670)", () => {
  const part = (platform: Platform, over: Partial<PlatformPart> = {}): PlatformPart => ({
    platform, account: platform, range: { from: "2026-09-10", to: "2026-10-08" }, followers: 100, totals: { ...EMPTY_TOTALS, views: 10 }, posts: [], ...over,
  });
  /** A snapshot as the code before v2 wrote it: Instagram under `ig`, no `v`. */
  const legacyV1 = { at: NOW.toISOString(), ig: { user: "oud", followers: 1200, range: { from: "2026-09-10", to: "2026-10-08" }, reach: 5400, views: 0, posts: [] } };

  it("writes v2 with one part per read platform; null is not read (737)", async () => {
    const owner = await newUser("socv2");
    igAnswers();
    liAnswers();
    answers.INSTAGRAM_GET_USER_INSIGHTS = ok({ data: { data: [{ name: "reach", total_value: { value: 1200 } }, { name: "views", total_value: { value: 9100 } }] } });
    const s = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    expect(s.v).toBe(2);
    expect(s.parts.instagram?.totals.reach).toBe(1200);
    expect(s.parts.instagram?.totals.clicks).toBeNull();
    expect(s.parts.linkedin?.totals.views).toBe(900);
    expect(Object.keys(s.parts).sort()).toEqual(["instagram", "linkedin"]);
    expect(s.errors).toEqual({});
    // LinkedIn's actions are a count; the rate is worked out where it is shown, never stored.
    expect(s.parts.linkedin?.totals).toMatchObject({ clicks: 9, likes: 4, comments: 1, shares: 0, engagements: 14, pageViews: null, watchMinutes: null });
    expect(Object.keys(s.parts.linkedin!.totals)).not.toContain("engagement");
    // Nothing that was not read became 0: Instagram read reach and views only.
    expect(Object.entries(s.parts.instagram!.totals).filter(([, v]) => v !== null).map(([k]) => k).sort()).toEqual(["reach", "views"]);
    expect(await getSocialSnapshot(owner.email)).toEqual(s);
  });

  it("a v1 snapshot renders as not read and is due (Review Focus 2)", async () => {
    const owner = await newUser("socv1");
    await saveConnection(owner.email, igConn());
    igAnswers();
    await db.set(SOCIAL_KEY(owner.email), legacyV1);
    // Until the next read: Dana's block is empty, the card says not read yet without a figure, the followers tile stays shut.
    expect(await socialDataBlock(owner.email, NOW)).toBe("");
    const html = renderToStaticMarkup(createElement(SocialStats, { lang: "en", social: legacyV1 as never }));
    expect(html).toContain("Social results have not been read yet.");
    expect(html).not.toContain("1200");
    expect(html).not.toContain("@oud");
    expect(renderToStaticMarkup(createElement(SocialStats, { lang: "ar", social: legacyV1 as never }))).toContain("لم تُقرأ بعد");
    expect(socialRead(legacyV1 as never)).toBe(false);
    // Read at NOW, so the daily run would wait 20 hours; a v1 snapshot is read again at once, never migrated in place.
    expect(await syncSocialIfDue(owner.email, NOW)).toBe(true);
    expect(await getSocialSnapshot(owner.email)).toMatchObject({ v: 2, parts: { instagram: { account: "oud", followers: 1200 } } });
    expect(await syncSocialIfDue(owner.email, NOW), "a v2 read an instant old is not due").toBe(false);
  });

  it("history keeps one row per platform and month, newest 13 (746)", () => {
    let h: HistoryRow[] = [];
    for (let m = 0; m < 15; m++) h = upsertHistory(h, [part("instagram"), ...(m < 2 ? [part("linkedin")] : [])], new Date(Date.UTC(2025, m, 15)));
    expect(h.filter((r) => r.platform === "instagram")).toHaveLength(13);
    expect(h.filter((r) => r.platform === "instagram").map((r) => r.month).sort()[0], "the two oldest months went").toBe("2025-03");
    expect(h.filter((r) => r.platform === "linkedin"), "a platform not read since keeps its rows").toHaveLength(2);
    h = upsertHistory(h, [part("instagram", { followers: 9 })], new Date(Date.UTC(2026, 2, 20)));
    expect(h.filter((r) => r.month === "2026-03")).toHaveLength(1);
    expect(h.find((r) => r.month === "2026-03")).toEqual({ month: "2026-03", platform: "instagram", followers: 9, totals: { ...EMPTY_TOTALS, views: 10 } });
  });

  it("each read adds its UTC month to the stored history, and a part that failed keeps its rows (746)", async () => {
    const owner = await newUser("sochist");
    igAnswers();
    liAnswers();
    await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    // A month later LinkedIn fails: Instagram gets November's row, LinkedIn keeps October's.
    answers.LINKEDIN_GET_SHARE_STATS = { successful: false, error: "Internal error (500)" };
    const later = new Date(Date.UTC(2026, 10, 1, 0, 30));
    const s = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, later);
    expect(s.errors.linkedin).toBe("read_failed");
    expect(s.history.map((r) => `${r.month} ${r.platform}`).sort()).toEqual(["2026-10 instagram", "2026-10 linkedin", "2026-11 instagram"]);
    // A v1 snapshot has no history: the first v2 read starts one.
    await db.set(SOCIAL_KEY(owner.email), legacyV1);
    expect((await syncSocial(owner.email, { meta: igConn() }, NOW)).history.map((r) => r.platform)).toEqual(["instagram"]);
  });

  it("a part read from another account starts its platform's history again; a name not read keeps it (746)", async () => {
    const owner = await newUser("sochistacct");
    igAnswers();
    liAnswers();
    const months = async () => {
      const s = await getSocialSnapshot(owner.email);
      return s?.v === 2 ? s.history.map((r) => `${r.month} ${r.platform}`).sort() : [];
    };
    await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    // November: another Instagram account was connected (another igId); the company page is the same.
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1785", username: "rose", followers_count: 40 } });
    await syncSocial(owner.email, { meta: igConn("1785"), linkedin: liConn() }, new Date(Date.UTC(2026, 10, 1, 0, 30)));
    expect(await months(), "October's Instagram row was another account's").toEqual(["2026-10 linkedin", "2026-11 instagram", "2026-11 linkedin"]);
    // December: the owner chose another company page, and Instagram answered without its username.
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1785", followers_count: 41 } });
    const page43 = via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc", liOrg: "urn:li:organization:43" });
    const s = await syncSocial(owner.email, { meta: igConn("1785"), linkedin: page43 }, new Date(Date.UTC(2026, 11, 1, 0, 30)));
    expect(s.parts.linkedin?.account).toBe("Page 43");
    expect(await months()).toEqual(["2026-11 instagram", "2026-12 instagram", "2026-12 linkedin"]);
  });

  it("the stored account id decides a change of account; a part stored without one follows the name (746, 679)", async () => {
    const owner = await newUser("sochistid");
    igAnswers();
    liAnswers();
    const months = async () => {
      const s = await getSocialSnapshot(owner.email);
      return s?.v === 2 ? s.history.filter((r) => r.platform === "instagram").map((r) => r.month) : [];
    };
    const first = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    // Taken only from the stored connection, never from the platform's answer.
    expect(first.parts.instagram?.accountId).toBe("1784");
    expect(first.parts.linkedin?.accountId).toBe("urn:li:organization:42");
    // November: the same account (igId 1784) under a new username keeps its rows.
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "oud_ksa", followers_count: 1300 } });
    await syncSocial(owner.email, { meta: igConn() }, new Date(Date.UTC(2026, 10, 1, 0, 30)));
    expect(await months(), "renamed, not another account").toEqual(["2026-10", "2026-11"]);
    // December: another account (igId 1785) under the same username drops them.
    await syncSocial(owner.email, { meta: igConn("1785") }, new Date(Date.UTC(2026, 11, 1, 0, 30)));
    expect(await months(), "another account, the same name").toEqual(["2026-12"]);

    // A part stored before the id (the expand step, rule 679): the names decide, as before. The same name keeps the rows...
    const october = upsertHistory([], [part("instagram", { account: "oud" })], NOW);
    await db.set(SOCIAL_KEY(owner.email), { v: 2, at: NOW.toISOString(), parts: { instagram: part("instagram", { account: "oud" }) }, errors: {}, history: october });
    igAnswers();
    await syncSocial(owner.email, { meta: igConn() }, new Date(Date.UTC(2026, 10, 1, 0, 30)));
    expect(await months()).toEqual(["2026-10", "2026-11"]);
    // ...and another name drops them.
    await db.set(SOCIAL_KEY(owner.email), { v: 2, at: NOW.toISOString(), parts: { instagram: part("instagram", { account: "oud" }) }, errors: {}, history: october });
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "rose", followers_count: 40 } });
    await syncSocial(owner.email, { meta: igConn() }, new Date(Date.UTC(2026, 10, 1, 0, 30)));
    expect(await months()).toEqual(["2026-11"]);
  });

  it("the account id is never sent to the model or the page (746)", async () => {
    const owner = await newUser("sochistidout");
    igAnswers();
    liAnswers();
    await syncSocial(owner.email, { meta: igConn("17841400000000001"), linkedin: liConn() }, NOW);
    const stored = await getSocialSnapshot(owner.email);
    expect(JSON.stringify(stored)).toContain("17841400000000001");
    const block = await socialDataBlock(owner.email, NOW);
    expect(block).not.toMatch(/accountId|17841400000000001|urn:li:organization/);
    const page = socialForPage(stored);
    expect(JSON.stringify(page)).not.toMatch(/accountId|17841400000000001|urn:li:organization/);
    // Everything else the page shows stays as stored.
    expect(page).toMatchObject({ v: 2, parts: { instagram: { account: "oud", followers: 1200 }, linkedin: { followers: 812 } } });
    expect(socialForPage(null)).toBeNull();
    expect(socialForPage({ at: NOW.toISOString() })).toEqual({ at: NOW.toISOString() });
  });

  it("an Instagram username is stored as one clean line of at most 80 characters (737)", async () => {
    const owner = await newUser("socigname");
    igAnswers();
    // 100 characters with markup.
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "<b>oud</b>" + "x".repeat(90), followers_count: 1200 } });
    await syncSocial(owner.email, { meta: igConn() }, NOW);
    const s = await getSocialSnapshot(owner.email);
    const account = s?.v === 2 ? s.parts.instagram!.account : "";
    expect(account.length).toBeGreaterThan(0);
    expect(account.length).toBeLessThanOrEqual(80);
    expect(account).not.toContain("<");
  });

  it("the card lists one block per part in the order of PLATFORMS (670)", () => {
    // The card keeps its own list so the client bundle imports only types; a platform missing from it, or out of order, fails here.
    const social: SocialSnapshot = { v: 2, at: NOW.toISOString(), errors: {}, history: [], parts: Object.fromEntries(PLATFORMS.map((p) => [p, part(p, { account: `acct-${p}` })])) as SocialSnapshot["parts"] };
    const html = renderToStaticMarkup(createElement(SocialStats, { lang: "en", social }));
    const at = PLATFORMS.map((p) => html.indexOf(`acct-${p}`));
    expect(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), at.join(",")).toBe(true);
  });

  it("history goes with the account (746)", async () => {
    const owner = await newUser("socwipe");
    await db.set(SOCIAL_KEY(owner.email), { v: 2, at: NOW.toISOString(), parts: { instagram: part("instagram") }, errors: {}, history: upsertHistory([], [part("instagram"), part("linkedin")], NOW) });
    await wipeAccount(owner.email);
    expect(await getSocialSnapshot(owner.email)).toBeNull();
  });

  it("a Meta record with a Page counts as a social source; followers unlock on any part (664, 670)", () => {
    expect(connectedSources([{ provider: "meta", meta: { via: "composio", pageId: "1" } }])).toEqual(["meta"]);
    expect(socialRead({ v: 2, at: "", parts: { youtube: part("youtube") }, errors: {}, history: [] })).toBe(true);
    expect(socialRead({ v: 2, at: "", parts: {}, errors: { instagram: "ig_not_professional" }, history: [] })).toBe(false);
    // YouTube and TikTok are read through Composio only, X only on its direct connection (spec C3).
    expect(connectedSources([{ provider: "youtube", meta: { via: "composio", channelId: "UCddiUEpeqJcYeBxX1IVBKvQ" } }, { provider: "tiktok", meta: { via: "composio" } }, { provider: "x", meta: {} }])).toEqual(["youtube", "tiktok", "x"]);
    // A YouTube record counts only with the channel its reader reads (holdsYt's test): none, or one that is not a channel id, is no source.
    for (const channelId of [undefined, "", "UC1", "channel==MINE"]) {
      const meta: Record<string, string> = channelId == null ? { via: "composio" } : { via: "composio", channelId };
      expect(connectedSources([{ provider: "youtube", meta }]), String(channelId)).toEqual([]);
    }
    expect(reportSources(connectedSources([{ provider: "youtube", meta: { via: "composio" } }])).missing).toContain("social");
    expect(connectedSources([{ provider: "youtube", meta: {} }, { provider: "tiktok", meta: {} }, { provider: "x", meta: { via: "composio" } }])).toEqual([]);
    for (const p of ["youtube", "tiktok", "x"]) expect(reportSources([p]).read, p).toEqual(["social"]);
  });

  it("a social path holds a part exactly when one of its platform readers holds the record", () => {
    const yt = via("youtube", { youtube: "ca_yt" }, { channelId: "UC1" });
    expect(holdsSocial("meta", igConn())).toBe(true);
    expect(holdsSocial("linkedin", liConn())).toBe(true);
    expect(holdsSocial("linkedin", igConn())).toBe(false);
    // The Facebook Page holds once a Page is chosen (rule 739), the YouTube channel once its UC channel id is stored
    // (rule 740), the TikTok account once a Composio record carries it (rule 742).
    expect(holdsSocial("meta", via("meta", { facebook: "ca_fb" }, { pageId: "1" }))).toBe(true);
    expect(holdsSocial("meta", via("meta", { facebook: "ca_fb" }))).toBe(false);
    expect(holdsSocial("youtube", via("youtube", { youtube: "ca_yt" }, { channelId: "UCddiUEpeqJcYeBxX1IVBKvQ" }))).toBe(true);
    expect(holdsSocial("tiktok", via("tiktok", { tiktok: "ca_tt" }))).toBe(true);
    expect(holdsSocial("tiktok", via("tiktok", {}))).toBe(false);
    expect(READERS.tiktok.provider).toBe("tiktok");
    expect(holdsSocial("youtube", yt)).toBe(false);
    expect(READERS.youtube.provider).toBe("youtube");
    expect(READERS.facebook.provider).toBe("meta");
    // The answer is the readers': once YouTube's holds the record, the youtube path does too.
    vi.spyOn(READERS.youtube, "holds").mockReturnValue(true);
    expect(holdsSocial("youtube", yt)).toBe(true);
    expect(holdsSocial("tiktok", yt)).toBe(false);
  });

  it("publishing to Facebook, LinkedIn, YouTube, TikTok or X records the post id (667)", async () => {
    const owner = await newUser("socpub");
    vi.spyOn(publish, "publishTask").mockImplementation(async (_scope, _task, provider) => ({ url: "", id: `id-${provider}`, provider, status: "published" }));
    const t: Task = { id: "tsocpub1", type: "social", channel: "instagram", title: "t", body: "عود ملكي جديد", status: "approved", createdAt: NOW.toISOString(), lang: "ar" };
    await saveTask(owner.email, t, true);
    const providers = ["facebook", "linkedin", "youtube", "tiktok", "x", "telegram"];
    for (const p of providers) expect((await publishOnce(owner.email, t.id, p)).ok, p).toBe(true);
    for (const p of providers.slice(0, 5)) expect(await db.sismember(SOCIAL_PUB_KEY(owner.email), `id-${p}`), p).toBe(true);
    expect(await db.sismember(SOCIAL_PUB_KEY(owner.email), "id-telegram"), "Telegram has no results to mark").toBe(false);
    const other = await newUser("socpub2");
    expect(await db.smembers(SOCIAL_PUB_KEY(other.email))).toEqual([]);
  });
});

describe("the social previous period and the shared deadline (rules 733, 741; amended 665)", () => {
  const U = Math.floor(NOW.getTime() / 1000);
  const S = U - 28 * 86400;
  const igTotals = (reach: number, views: number) => ok({ data: { data: [{ name: "reach", total_value: { value: reach } }, { name: "views", total_value: { value: views } }] } });
  /** Instagram's account insights by window: the window's figures, and the 28 days before it answered by `prev`. */
  const igInsights = (prev: Answer): Answer => (a) => (a.since === S ? igTotals(5400, 9100) : typeof prev === "function" ? prev(a) : prev);

  it("Instagram reads the 28 days before the window as prev (733)", async () => {
    const owner = await newUser("socprevig");
    igAnswers();
    answers.INSTAGRAM_GET_USER_INSIGHTS = igInsights(igTotals(4500, 7000));
    const s = await syncSocial(owner.email, { meta: igConn() }, NOW);
    const ins = calls.filter((c) => c.slug === "INSTAGRAM_GET_USER_INSIGHTS");
    expect(ins.map((c) => [c.args.since, c.args.until])).toEqual([[S, U], [S - 28 * 86400, S]]);
    // The same metrics, period and type: only the dates differ.
    expect(ins[1].args).toEqual({ ...ins[0].args, since: S - 28 * 86400, until: S });
    expect(s.parts.instagram?.totals).toEqual({ ...EMPTY_TOTALS, reach: 5400, views: 9100 });
    expect(s.parts.instagram?.prev).toEqual({ range: { from: "2026-08-13", to: "2026-09-10" }, totals: { ...EMPTY_TOTALS, reach: 4500, views: 7000 } });
  });

  it("a previous read that fails or reads no figure leaves no prev, and the part stands (733)", async () => {
    const owner = await newUser("socprevigfail");
    igAnswers();
    answers.INSTAGRAM_GET_USER_INSIGHTS = igInsights({ successful: false, error: "Internal error (500)" });
    const failed = await syncSocial(owner.email, { meta: igConn() }, NOW);
    expect(failed.parts.instagram).toMatchObject({ followers: 1200, totals: { reach: 5400, views: 9100 } });
    expect(failed.parts.instagram).not.toHaveProperty("prev");
    expect(failed.errors).toEqual({});
    // An account with no figure for the earlier days (professional only since this month): no prev, so no "up from" either.
    answers.INSTAGRAM_GET_USER_INSIGHTS = igInsights(ok({ data: { data: [] } }));
    expect((await syncSocial(owner.email, { meta: igConn() }, NOW)).parts.instagram).not.toHaveProperty("prev");
    // A refused token on the previous read is still a refused token: thrown with its provider, never hidden as "no prev".
    answers.INSTAGRAM_GET_USER_INSIGHTS = igInsights({ successful: false, error: "token expired" });
    await expect(syncSocial(owner.email, { meta: igConn() }, NOW)).rejects.toMatchObject({ provider: "meta", message: expect.stringMatching(/ 401:/) });
  });

  it("an earlier period in which every figure read is 0 gives no prev (733)", async () => {
    const owner = await newUser("socprevzero");
    igAnswers();
    // Instagram: the window's figures, and 0 views and 0 reach for the 28 days before (no account activity yet).
    answers.INSTAGRAM_GET_USER_INSIGHTS = igInsights(igTotals(0, 0));
    // LinkedIn: the window's last day, and 28 earlier days answered with every statistic at 0.
    answers.LINKEDIN_GET_SHARE_STATS = (a) => ok({ elements: [liDay(liEnd(a), 1, 900, 9), ...Array.from({ length: 28 }, (_, i) => liDay(liEnd(a), 29 + i, 0))] });
    answers.LINKEDIN_GET_NETWORK_SIZE = ok({ firstDegreeSize: 812 });
    answers.LINKEDIN_GET_ORG_PAGE_STATS = ok({ elements: [] });
    const s = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    expect(s.parts.instagram).toMatchObject({ totals: { reach: 5400, views: 9100 } });
    expect(s.parts.linkedin).toMatchObject({ totals: { views: 900, clicks: 9 } });
    expect(s.parts.instagram, "Instagram").not.toHaveProperty("prev");
    expect(s.parts.linkedin, "LinkedIn").not.toHaveProperty("prev");
    // One figure above 0 in the earlier period is a prev, its zeros kept as read.
    answers.INSTAGRAM_GET_USER_INSIGHTS = igInsights(igTotals(0, 3));
    expect((await syncSocial(owner.email, { meta: igConn() }, NOW)).parts.instagram?.prev?.totals).toMatchObject({ reach: 0, views: 3 });
  });

  it("LinkedIn asks 56 whole days once and splits them by day (733)", async () => {
    const owner = await newUser("socprevli");
    const end = Date.UTC(2026, 9, 8);
    // Each of the 56 days asked: 20 impressions a day in the window, 10 in the 28 days before. A day after the window, one
    // before both periods and an undated row count in neither.
    answers.LINKEDIN_GET_SHARE_STATS = (a) => ok({ elements: [
      ...Array.from({ length: 56 }, (_, i) => liDay(liEnd(a), i + 1, i < 28 ? 20 : 10, 1)),
      liDay(liEnd(a), 0, 5000), liDay(liEnd(a), 57, 5000), { totalShareStatistics: { impressionCount: 5000 } },
    ] });
    answers.LINKEDIN_GET_NETWORK_SIZE = ok({ firstDegreeSize: 812 });
    const s = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    const asked = calls.filter((c) => c.slug === "LINKEDIN_GET_SHARE_STATS");
    expect(asked).toHaveLength(1);
    // Whole UTC days ending at today's midnight, so both periods are whole days however LinkedIn cuts its DAY rows.
    expect(asked[0].args).toEqual({ organizational_entity: "urn:li:organization:42", time_intervals: `(timeRange:(start:${end - 56 * 864e5},end:${end}),timeGranularityType:DAY)` });
    expect(s.parts.linkedin).toMatchObject({ range: { from: "2026-09-10", to: "2026-10-07" }, totals: { views: 560, clicks: 28, engagements: 28 } });
    expect(s.parts.linkedin?.prev).toEqual({ range: { from: "2026-08-13", to: "2026-09-09" }, totals: { ...EMPTY_TOTALS, views: 280, clicks: 28, likes: 0, comments: 0, shares: 0, engagements: 28 } });
  });

  it("a page with days only in the window has no prev; rows dated in neither period leave null figures, said once (733)", async () => {
    const owner = await newUser("socprevlinew");
    liAnswers();
    const s = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    expect(s.parts.linkedin?.totals.views).toBe(900);
    expect(s.parts.linkedin).not.toHaveProperty("prev");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    answers.LINKEDIN_GET_SHARE_STATS = ok({ elements: [{ totalShareStatistics: { impressionCount: 900 } }, { timeRange: { start: 0, end: 864e5 }, totalShareStatistics: { impressionCount: 900 } }] });
    const odd = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    expect(odd.parts.linkedin).toMatchObject({ followers: 812, totals: { views: null, clicks: null, engagements: null } });
    expect(odd.parts.linkedin).not.toHaveProperty("prev");
    expect(warn.mock.calls).toEqual([["li_no_day_rows"]]);
  });

  it("splitDays keeps the window's days and the same number of days just before it (733)", () => {
    const w = { from: "2026-09-10", to: "2026-10-07" };
    expect(rangeBefore(w)).toEqual({ from: "2026-08-13", to: "2026-09-09" });
    expect(rangeBefore({ from: "2026-10-01", to: "2026-10-01" })).toEqual({ from: "2026-09-30", to: "2026-09-30" });
    const rows = ["2026-08-12", "2026-08-13", "2026-09-09", "2026-09-10", "2026-10-07", "2026-10-08", "", "junk", "2026-09-20T00:00:00Z"].map((day, i) => ({ day, i }));
    const { cur, prev } = splitDays(rows, w);
    expect(cur.map((r) => r.day)).toEqual(["2026-09-10", "2026-10-07"]);
    expect(prev.map((r) => r.day)).toEqual(["2026-08-13", "2026-09-09"]);
  });

  it("the deadline is 30 s on the clock from the start of the read (741, amended 665)", () => {
    expect(SOCIAL_DEADLINE_MS).toBe(30_000);
    expect(() => beforeDeadline(Date.now() + 1)).not.toThrow();
    expect(() => beforeDeadline(Date.now())).toThrow("deadline");
  });

  it("a reader started past the deadline rejects with deadline and asks Composio nothing (741)", async () => {
    const owner = await newUser("socpastdeadline");
    // Answers that would make known states if they were asked: the deadline is not one of them.
    answers.INSTAGRAM_GET_USER_INFO = { successful: false, error: "(#100) Unsupported get request." };
    answers.LINKEDIN_GET_SHARE_STATS = { successful: false, error: "403 Forbidden" };
    const started = Date.now() - SOCIAL_DEADLINE_MS - 1;
    await expect(READERS.instagram.read(owner.email, igConn(), NOW, started + SOCIAL_DEADLINE_MS)).rejects.toThrow(/^deadline$/);
    await expect(READERS.linkedin.read(owner.email, liConn(), NOW, started + SOCIAL_DEADLINE_MS)).rejects.toThrow(/^deadline$/);
    expect(calls).toEqual([]);
  });

  it("every reader stops asking at 30 s; one slow platform never loses another (741)", async () => {
    const owner = await newUser("socdeadline");
    igAnswers();
    liAnswers();
    answers.INSTAGRAM_GET_IG_USER_MEDIA = ok({ data: { data: Array.from({ length: 9 }, (_, i) => media(i + 1)) } });
    // Each post read lands 31 s after the read began.
    answers.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = (a) => {
      vi.setSystemTime(NOW.getTime() + 31_000);
      return ok({ data: { data: (a.metric as string[]).map((name) => ({ name, values: [{ value: 7 }] })) } });
    };
    const s = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    expect(s.parts.linkedin?.totals.views).toBe(900);
    // Four post reads run at a time: the four asked before the clock passed 30 s land, and none is asked after.
    expect(calls.filter((c) => c.slug === "INSTAGRAM_GET_IG_MEDIA_INSIGHTS")).toHaveLength(4);
    expect(s.parts.instagram?.posts).toHaveLength(9);
    expect(s.parts.instagram?.posts.filter((p) => p.views === 7)).toHaveLength(4);
    expect(s.parts.instagram?.posts.filter((p) => p.views === null)).toHaveLength(5);
    expect(s.errors).toEqual({});

    // The clock reaches 30 s while Instagram's account is read: Instagram asks for nothing more (no totals, no previous
    // period, no posts) and keeps what it read; LinkedIn's reads were asked at the start and stand.
    calls.length = 0;
    vi.setSystemTime(NOW);
    answers.INSTAGRAM_GET_USER_INFO = () => {
      vi.setSystemTime(NOW.getTime() + SOCIAL_DEADLINE_MS);
      return ok({ data: { id: "1784", username: "oud", followers_count: 1200 } });
    };
    const late = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    expect(calls.map((c) => c.slug).sort()).toEqual(["INSTAGRAM_GET_USER_INFO", "LINKEDIN_GET_NETWORK_SIZE", "LINKEDIN_GET_ORG_PAGE_STATS", "LINKEDIN_GET_SHARE_STATS"]);
    expect(late.parts.instagram).toMatchObject({ account: "oud", followers: 1200, totals: EMPTY_TOTALS, posts: [] });
    expect(late.parts.instagram).not.toHaveProperty("prev");
    expect(late.parts.linkedin).toMatchObject({ followers: 812, totals: { views: 900 } });
  });
});

describe("LinkedIn page views (rule 748)", () => {
  /** One day of the page's own statistics, dated `back` whole days before the end LinkedIn was asked for. */
  const pageDay = (end: number, back: number, pageViews: unknown) =>
    ({ organization: "urn:li:organization:42", timeRange: { start: end - back * 864e5, end: end - (back - 1) * 864e5 }, totalPageStatistics: { views: { allPageViews: { pageViews, uniquePageViews: 1 } } } });
  const pageEnd = (a: Record<string, unknown>) => Number(a.timeRangeEnd);

  it("reads page views for the chosen page with fixed arguments over the same 56 days, split by day (748)", async () => {
    const owner = await newUser("socliviews");
    liAnswers();
    // In the window 300 and "10" (a number sent as a string); "N/A" and {} are not read. 120 in the 28 days before. A day
    // after the window and an undated row count in neither period.
    answers.LINKEDIN_GET_ORG_PAGE_STATS = (a) => ok({ elements: [
      pageDay(pageEnd(a), 1, 300), pageDay(pageEnd(a), 2, "10"), pageDay(pageEnd(a), 3, "N/A"), pageDay(pageEnd(a), 4, {}),
      pageDay(pageEnd(a), 29, 120), pageDay(pageEnd(a), 0, 5000), { totalPageStatistics: { views: { allPageViews: { pageViews: 5000 } } } },
    ] });
    const s = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    const asked = calls.filter((c) => c.slug === "LINKEDIN_GET_ORG_PAGE_STATS");
    expect(asked).toHaveLength(1);
    // The page from the connection, DAY granularity, and the share statistics' 56 whole UTC days ending at today's midnight.
    const end = Date.UTC(2026, 9, 8);
    expect(asked[0].args).toEqual({ organization: "urn:li:organization:42", timeRangeStart: end - 56 * 864e5, timeRangeEnd: end, timeGranularityType: "DAY" });
    expect(s.parts.linkedin?.totals).toMatchObject({ pageViews: 310, views: 900, engagements: 14 });
    // The share statistics answered no earlier day: the earlier page views alone make the prev.
    expect(s.parts.linkedin?.prev).toEqual({ range: { from: "2026-08-13", to: "2026-09-09" }, totals: { ...EMPTY_TOTALS, pageViews: 120 } });
    expect(s.history.find((r) => r.platform === "linkedin")?.totals.pageViews).toBe(310);
    // Dana reads them in the part's totals, told they are visits to the page itself, not its posts' impressions.
    const block = await socialDataBlock(owner.email, NOW);
    expect(block).toContain('"pageViews":310');
    expect(block).toContain("pageViews are visits to the page itself");
  });

  it("no day with a page-view figure leaves pageViews null, never 0; rows dated in neither period are said once a read (748)", async () => {
    const owner = await newUser("socliviewsnone");
    liAnswers();
    answers.LINKEDIN_GET_ORG_PAGE_STATS = (a) => ok({ elements: [pageDay(pageEnd(a), 1, "N/A"), pageDay(pageEnd(a), 2, {})] });
    expect((await syncSocial(owner.email, { linkedin: liConn() }, NOW)).parts.linkedin?.totals.pageViews).toBeNull();
    answers.LINKEDIN_GET_ORG_PAGE_STATS = ok({ elements: [] });
    expect((await syncSocial(owner.email, { linkedin: liConn() }, NOW)).parts.linkedin?.totals.pageViews).toBeNull();
    // Page-view rows dated in neither period are not summed and are said once, even when the share rows are odd too.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const odd = { totalPageStatistics: { views: { allPageViews: { pageViews: 5000 } } } };
    answers.LINKEDIN_GET_ORG_PAGE_STATS = ok({ elements: [odd, { ...odd, timeRange: { start: 0, end: 864e5 } }] });
    const s = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    expect(s.parts.linkedin).toMatchObject({ totals: { views: 900, pageViews: null } });
    expect(s.parts.linkedin).not.toHaveProperty("prev");
    answers.LINKEDIN_GET_SHARE_STATS = ok({ elements: [{ totalShareStatistics: { impressionCount: 900 } }] });
    await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    expect(warn.mock.calls).toEqual([["li_no_day_rows"], ["li_no_day_rows"]]);
  });

  it("a 403 on page views keeps the rest of the LinkedIn part; a refused token still ends the read (748)", async () => {
    const owner = await newUser("socliviews403");
    vi.spyOn(console, "error").mockImplementation(() => {});
    liAnswers();
    // The page-statistics read needs the ADMINISTRATOR role and rw_organization_admin; without them LinkedIn answers 403.
    answers.LINKEDIN_GET_ORG_PAGE_STATS = { successful: false, error: "403 Forbidden: Not enough permissions to access: organizationalPageStatistics" };
    const s = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    expect(s.parts.linkedin).toMatchObject({ followers: 812, totals: { views: 900, clicks: 9, engagements: 14, pageViews: null } });
    expect(s.errors, "the share statistics were read: the page is not li_no_page_access").toEqual({});
    // A token LinkedIn refused is not a missing scope: thrown with its provider, after nothing else was hidden.
    answers.LINKEDIN_GET_ORG_PAGE_STATS = { successful: false, error: "The token used in the request has expired" };
    await expect(syncSocial(owner.email, { linkedin: liConn() }, NOW)).rejects.toMatchObject({ provider: "linkedin", message: expect.stringMatching(/ 401:/) });
  });

  it("page views asked past the deadline are null; the rest of the part stands with no error (741, 748)", async () => {
    const owner = await newUser("socliviewslate");
    liAnswers();
    // The deadline passes at the read's third check, the page statistics': the share statistics and followers were asked.
    // The three checks run in readLi's order (share statistics, followers, page statistics) before any call is sent; the
    // asserts below name the one slug refused, so a change of that order or of the check fails here rather than passing.
    const clock = Date.now.bind(Date);
    let checks = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ((new Error().stack ?? "").includes("beforeDeadline") && ++checks === 3 ? Number.MAX_SAFE_INTEGER : clock()));
    const s = await syncSocial(owner.email, { linkedin: liConn() }, NOW);
    expect(checks, "one deadline check per LinkedIn call, through beforeDeadline").toBe(3);
    expect(calls.map((c) => c.slug), "the page statistics, and only they, were refused by the deadline").not.toContain("LINKEDIN_GET_ORG_PAGE_STATS");
    expect(calls.map((c) => c.slug).sort()).toEqual(["LINKEDIN_GET_NETWORK_SIZE", "LINKEDIN_GET_SHARE_STATS"]);
    expect(s.parts.linkedin).toMatchObject({ followers: 812, totals: { views: 900, clicks: 9, engagements: 14, pageViews: null } });
    expect(s.errors).toEqual({});
  });

  it("Instagram and LinkedIn figures are strict counts: a negative, an exponent, N/A or {} is not read, never a number (737)", async () => {
    const owner = await newUser("socjunk");
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "oud", followers_count: "-5" } });
    answers.INSTAGRAM_GET_USER_INSIGHTS = ok({ data: { data: [{ name: "reach", total_value: { value: "N/A" } }, { name: "views", total_value: { value: "1e3" } }] } });
    answers.INSTAGRAM_GET_IG_USER_MEDIA = ok({ data: { data: [] } });
    answers.LINKEDIN_GET_SHARE_STATS = (a) => {
      const d = liDay(liEnd(a), 1, 0);
      return ok({ elements: [{ ...d, totalShareStatistics: { impressionCount: "1e3", clickCount: -4, likeCount: {}, commentCount: "N/A", shareCount: "2" } }] });
    };
    answers.LINKEDIN_GET_NETWORK_SIZE = ok({ firstDegreeSize: -1 });
    answers.LINKEDIN_GET_ORG_PAGE_STATS = (a) => ok({ elements: [pageDay(pageEnd(a), 1, "-3"), pageDay(pageEnd(a), 2, "2e2")] });
    const s = await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, NOW);
    expect(s.parts.instagram).toMatchObject({ followers: null, totals: EMPTY_TOTALS });
    expect(s.parts.instagram, "no figure read for the earlier 28 days: no prev").not.toHaveProperty("prev");
    // Only the reposts were read: no impressions, so no engagements either.
    expect(s.parts.linkedin).toMatchObject({ followers: null, totals: { ...EMPTY_TOTALS, shares: 2 } });
    for (const part of [s.parts.instagram!, s.parts.linkedin!]) {
      for (const v of [part.followers, ...Object.values(part.totals)]) expect(v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0), `${part.platform} ${v}`).toBe(true);
    }
  });
});
