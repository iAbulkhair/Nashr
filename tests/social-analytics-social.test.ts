import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newMember, newUser, settle, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { setComposioClientForTests } from "@/lib/connectors/composio";
import { getSocialSnapshot, syncSocial, syncSocialIfDue } from "@/lib/social-stats";
import { syncSiteIfDue } from "@/lib/site-stats";
import { OWNER_SYNC_KEY, ROUTINES } from "@/lib/routines";
import * as connRoute from "@/app/api/connect/[provider]/route";
import { fakeComposio, ok, type Answer, type Call } from "./helpers/composio-fake";

/**
 * Rules 735 and 736 (spec docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md, A4 and A7): any member
 * may refresh the social results at once, free, six times an hour per workspace (the bucket is the workspace's, so the
 * team and every social path share it); a refusal is 429 with Retry-After. The click, never the daily cron's read, counts
 * as activity for Dana's weekly-report routine (`ownersync:{scope}`). Composio is the shared fake; its answers follow
 * the Instagram, LinkedIn, GA4 and Search Console shapes the reader tests use.
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
