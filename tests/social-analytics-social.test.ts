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
import { EMPTY_TOTALS, PLATFORMS, READERS, SOCIAL_KEY, SOCIAL_PUB_KEY, getSocialSnapshot, holdsSocial, socialDataBlock, syncSocial, syncSocialIfDue, upsertHistory, type HistoryRow, type Platform, type PlatformPart, type SocialSnapshot } from "@/lib/social-stats";
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
 * the monthly history. Composio is the shared fake; its answers follow the Instagram, LinkedIn, GA4 and Search Console
 * shapes the reader tests use.
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
const igConn = () => via("meta", { instagram: "ca_ig" }, { igId: "1784" });
const liConn = () => via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc", liOrg: "urn:li:organization:42" });
const google = () => via("google", { google_analytics: "ca_ga", google_search_console: "ca_gsc" }, { gaProperty: "properties/987", gscSite: "sc-domain:roastery.example" });

/** An Instagram account with no posts in the window: three calls a read. */
function igAnswers() {
  answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "oud", followers_count: 1200 } });
  answers.INSTAGRAM_GET_USER_INSIGHTS = ok({ data: { data: [{ name: "reach", total_value: { value: 5400 } }, { name: "views", total_value: { value: 9100 } }] } });
  answers.INSTAGRAM_GET_IG_USER_MEDIA = ok({ data: { data: [] } });
}
function liAnswers() {
  answers.LINKEDIN_GET_SHARE_STATS = ok({ elements: [{ totalShareStatistics: { impressionCount: 900, clickCount: 9, likeCount: 4, commentCount: 1, shareCount: 0 } }] });
  answers.LINKEDIN_GET_NETWORK_SIZE = ok({ firstDegreeSize: 812 });
}
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
    expect(calls.map((c) => c.slug).sort()).toEqual(["INSTAGRAM_GET_IG_USER_MEDIA", "INSTAGRAM_GET_USER_INFO", "INSTAGRAM_GET_USER_INSIGHTS", "LINKEDIN_GET_NETWORK_SIZE", "LINKEDIN_GET_SHARE_STATS"]);
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
    // A direct Meta record, a Facebook-only Composio record, a LinkedIn record with no page chosen, and a YouTube record
    // (its reader comes with rule 740): none holds a part this path reads.
    const held: [string, Connection][] = [
      ["meta", { provider: "meta", data: { access_token: "t" }, meta: { pageId: "1", igId: "1784" }, connectedAt: NOW.toISOString() }],
      ["meta", via("meta", { facebook: "ca_fb" }, { pageId: "1" })],
      ["linkedin", via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc" })],
      ["youtube", via("youtube", { youtube: "ca_yt" }, { channelId: "UC1" })],
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
    // November: another Instagram account was connected; the company page is the same.
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1785", username: "rose", followers_count: 40 } });
    await syncSocial(owner.email, { meta: igConn(), linkedin: liConn() }, new Date(Date.UTC(2026, 10, 1, 0, 30)));
    expect(await months(), "October's Instagram row was another account's").toEqual(["2026-10 linkedin", "2026-11 instagram", "2026-11 linkedin"]);
    // December: the owner chose another company page, and Instagram answered without its username.
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1785", followers_count: 41 } });
    const page43 = via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc", liOrg: "urn:li:organization:43" });
    const s = await syncSocial(owner.email, { meta: igConn(), linkedin: page43 }, new Date(Date.UTC(2026, 11, 1, 0, 30)));
    expect(s.parts.linkedin?.account).toBe("Page 43");
    expect(await months()).toEqual(["2026-11 instagram", "2026-12 instagram", "2026-12 linkedin"]);
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
    expect(connectedSources([{ provider: "youtube", meta: { via: "composio" } }, { provider: "tiktok", meta: { via: "composio" } }, { provider: "x", meta: {} }])).toEqual(["youtube", "tiktok", "x"]);
    expect(connectedSources([{ provider: "youtube", meta: {} }, { provider: "tiktok", meta: {} }, { provider: "x", meta: { via: "composio" } }])).toEqual([]);
    for (const p of ["youtube", "tiktok", "x"]) expect(reportSources([p]).read, p).toEqual(["social"]);
  });

  it("a social path holds a part exactly when one of its platform readers holds the record", () => {
    const yt = via("youtube", { youtube: "ca_yt" }, { channelId: "UC1" });
    expect(holdsSocial("meta", igConn())).toBe(true);
    expect(holdsSocial("linkedin", liConn())).toBe(true);
    expect(holdsSocial("linkedin", igConn())).toBe(false);
    // YouTube, TikTok and the Facebook Page hold nothing until their readers exist (rules 739, 740, 742).
    expect(holdsSocial("meta", via("meta", { facebook: "ca_fb" }, { pageId: "1" }))).toBe(false);
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
