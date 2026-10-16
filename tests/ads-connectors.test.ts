import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { jar, json, newUser, signIn } from "./helpers/session";
import { fakeComposio, ok, type Answer, type Call as ToolCall } from "./helpers/composio-fake";
import { db } from "@/lib/db";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { getProvider, isAvailable } from "@/lib/connectors/registry";
import { READS_ADS } from "@/lib/connectors/working";
import { composioWrite, setComposioClientForTests, TOOLKIT_VERSION } from "@/lib/connectors/composio";
import { PROVIDER_TOOLKITS, TOOLKITS } from "@/lib/connectors/composio-catalog";
import { adRowsVia, LI_ADS_FIELDS, linkedinAdsVia } from "@/lib/connectors/ads-via-composio";
import { connectViaComposio } from "@/lib/connectors/via-composio";
import { ADSTATS_KEY, type AdStats } from "@/lib/ad-stats";
import { getPerf, syncAds, syncAdsIfDue } from "@/lib/perf-store";
import { readFile } from "@/lib/files";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rules 87-89: ad results from Meta and Snapchat, read only, into the same analysis as a CSV upload. The platforms are
 * mocked in the shapes their documentation gives (Meta Marketing API Insights, Snap Marketing API measurement).
 */
const ENV = { META_APP_ID: "mid", META_APP_SECRET: "msecret", SNAP_CLIENT_ID: "sid", SNAP_CLIENT_SECRET: "ssecret" };
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ENV)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const SNAP_ACC = "8f3b1c2d-1111-2222-3333-444455556666";
const realFetch = globalThis.fetch;
type Call = { url: string; method: string; body: string };
let calls: Call[] = [];

/** Ten ads: offers clearly ahead. Meta reports both "omni_purchase" and the pixel count; only omni must be used. */
const META_ADS = Array.from({ length: 10 }, (_, i) => {
  const offer = i < 4;
  const purchases = offer ? 10 - i : i % 3;
  return {
    ad_id: String(1000 + i), ad_name: offer ? `خصم ${20 + i}% على القهوة` : `قصة المحمصة ${i}`,
    impressions: String(8000 + i * 100), inline_link_clicks: String(offer ? 300 - i * 10 : 80 - i), spend: String(250 + i * 5),
    actions: [{ action_type: "omni_purchase", value: String(purchases) }, { action_type: "offsite_conversion.fb_pixel_purchase", value: String(purchases * 2) }],
    action_values: [{ action_type: "omni_purchase", value: String(purchases * 120) }],
  };
});

function fake(opts: { revoked?: boolean; evilNext?: boolean; noAccounts?: boolean } = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    const u = new URL(url);
    if (u.host === "graph.facebook.com") {
      if (opts.revoked) return Response.json({ error: { message: "Error validating access token", code: 190 } }, { status: 400 });
      const path = u.pathname.replace(/^\/v[\d.]+/, "");
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (path === "/oauth/access_token") return Response.json(body.get("grant_type") === "fb_exchange_token" ? { access_token: "long-ads", expires_in: 5183944 } : { access_token: "short-ads", expires_in: 5400 });
      if (path === "/me/adaccounts") return Response.json({ data: opts.noAccounts ? [] : [{ id: "act_111", name: "Roastery Ads", currency: "SAR", account_status: 1 }, { id: "act_222", name: "Old account", currency: "SAR", account_status: 2 }, { id: "act_333", name: "Second brand", currency: "AED", account_status: 1 }] });
      if (path === "/act_111/insights") {
        const page2 = u.searchParams.get("after") === "c2";
        return Response.json({ data: page2 ? META_ADS.slice(5) : META_ADS.slice(0, 5), paging: page2 ? {} : { next: opts.evilNext ? "https://evil.example/steal?after=c2" : `https://graph.facebook.com/v23.0/act_111/insights?after=c2` } });
      }
      if (path === "/" && u.searchParams.get("ids")) return Response.json(Object.fromEntries(u.searchParams.get("ids")!.split(",").map((id) => [id, { creative: { body: Number(id) < 1004 ? "كود خصم للمشتركين" : "قهوة مختصة", title: "" } }])));
    }
    if (u.host === "accounts.snapchat.com") return Response.json({ access_token: "snap-access", refresh_token: "snap-refresh", expires_in: 1800 });
    if (u.host === "adsapi.snapchat.com") {
      if (opts.revoked) return Response.json({ request_status: "ERROR", debug_message: "Unauthorized" }, { status: 401 });
      if (u.pathname === "/v1/me/organizations") return Response.json({ organizations: [{ organization: { ad_accounts: [{ id: SNAP_ACC, name: "Roastery Snap", currency: "SAR", status: "ACTIVE" }] } }] });
      if (u.pathname === `/v1/adaccounts/${SNAP_ACC}/ads`) return Response.json({ ads: [{ ad: { id: "a1", name: "عرض الجمعة" } }, { ad: { id: "a2", name: "Behind the roast" } }] });
      if (u.pathname === `/v1/adaccounts/${SNAP_ACC}/stats`) return Response.json({ total_stats: [{ total_stat: { breakdown_stats: { ad: [
        { id: "a1", stats: { impressions: 12000, swipes: 480, spend: 150_000_000, conversion_purchases: 12, conversion_purchases_value: 1_800_000_000 } },
        { id: "a2", stats: { impressions: 9000, swipes: 90, spend: 140_000_000, conversion_purchases: 1, conversion_purchases_value: 90_000_000 } },
      ] } } }] });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const metaAdsConn = (): Connection => ({ provider: "meta_ads", connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 50 * 864e5).toISOString(), data: { access_token: "long-ads" }, meta: { adAccount: "act_111", account: "Roastery Ads", currency: "SAR", adAccounts: JSON.stringify([{ id: "act_111", name: "Roastery Ads", currency: "SAR" }, { id: "act_333", name: "Second brand", currency: "AED" }]) } });
const snapConn = (): Connection => ({ provider: "snapchat", connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 25 * 60e3).toISOString(), data: { access_token: "snap-access", refresh_token: "snap-refresh" }, meta: { adAccount: SNAP_ACC, account: "Roastery Snap", currency: "SAR" } });
async function oauth(provider: string, tag: string) {
  const u = await newUser(tag);
  await saveState(`s-${tag}`, { email: u.email, provider, lang: "en", shop: "", verifier: "" });
  await signIn(u.email);
  jar().set(OAUTH_COOKIE, `s-${tag}`);
  const res = await callback.GET(new Request(`https://app.test/api/connect/${provider}/callback?state=s-${tag}&code=c`), ctx(provider));
  return { u, res, q: new URL(res.headers.get("location")!).searchParams };
}
const act = (provider: string, body: unknown) => connectRoute.POST(json(`/api/connect/${provider}`, "POST", body), ctx(provider));

describe("connecting ad accounts (rule 87)", () => {
  it("Meta Ads is its own connection asking only for ads_read, and the Page connection's review pack is unchanged", () => {
    expect(getProvider("meta_ads")!.oauth!.scopes).toEqual(["ads_read"]);
    expect(getProvider("meta")!.oauth!.scopes).not.toContain("ads_read");
    expect(READS_ADS).toEqual(["meta_ads", "snapchat", "google_ads", "tiktok_ads", "linkedin_ads"]);
    // Google Ads, TikTok Ads and LinkedIn Ads have no direct app: they connect through Composio or not at all.
    expect(getProvider("google_ads")!.oauth).toBeUndefined();
    expect(getProvider("tiktok_ads")!.oauth).toBeUndefined();
    expect(getProvider("linkedin_ads")!.oauth).toBeUndefined();
  });

  it("Meta: keeps a long-lived token with its expiry, lists only active ad accounts, and never puts a token or the app secret in view", async () => {
    fake();
    const { u, q } = await oauth("meta_ads", "metaads");
    expect(q.get("connected")).toBe("meta_ads");
    const c = (await getConnection(u.email, "meta_ads"))!;
    expect(c.data).toEqual({ access_token: "long-ads" });
    expect(c.meta).toMatchObject({ adAccount: "act_111", account: "Roastery Ads", currency: "SAR" });
    expect(JSON.parse(c.meta!.adAccounts).map((a: { id: string }) => a.id)).toEqual(["act_111", "act_333"]);
    expect(Date.parse(c.expiresAt!) - Date.now()).toBeGreaterThan(55 * 864e5);
    expect(JSON.stringify(c.meta)).not.toMatch(/long-ads|short-ads/);
    expect(calls.every((k) => !k.url.includes("msecret"))).toBe(true);
  });

  it("Snapchat: keeps the refresh token and the first active ad account", async () => {
    fake();
    const { u, q } = await oauth("snapchat", "snapads");
    expect(q.get("connected")).toBe("snapchat");
    const c = (await getConnection(u.email, "snapchat"))!;
    expect(c.data).toMatchObject({ access_token: "snap-access", refresh_token: "snap-refresh" });
    expect(c.meta).toMatchObject({ adAccount: SNAP_ACC, account: "Roastery Snap" });
  });

  it("refuses a login with no active ad account instead of saving a connection that reads nothing", async () => {
    fake({ noAccounts: true });
    const { u, q } = await oauth("meta_ads", "metanone");
    expect(q.get("error")).toBe("no_ad_account");
    expect(await getConnection(u.email, "meta_ads")).toBeNull();
  });

  it("switches only to an ad account the platform listed", async () => {
    const u = await newUser("adsel");
    await saveConnection(u.email, metaAdsConn());
    await signIn(u.email);
    expect((await act("meta_ads", { action: "select_ad_account", accountId: "act_999" })).status).toBe(400);
    expect((await act("meta_ads", { action: "select_ad_account", accountId: "act_333" })).status).toBe(200);
    expect((await getConnection(u.email, "meta_ads"))!.meta).toMatchObject({ adAccount: "act_333", currency: "AED" });
  });
});

describe("reading results (rule 88)", () => {
  it("Meta: pages through insights, counts omni purchases once, reads the ad copy, and lands in Noor's memory, free", async () => {
    fake();
    const u = await newUser("metasync");
    await saveConnection(u.email, metaAdsConn());
    await signIn(u.email);
    const credits = u.credits;
    const res = await act("meta_ads", { action: "sync_ads" });
    expect(res.status).toBe(200);
    const snap = (await getPerf(u.email))!;
    expect(snap).toMatchObject({ source: "meta_ads", platform: "Meta Ads", rows: 10 });
    expect(snap.totals.conversions).toBe(META_ADS.reduce((s, a) => s + Number(a.actions[0].value), 0)); // omni only, never the pixel's double count
    expect(snap.findings.some((f) => f.kind === "pattern" && /offer/.test(f.text.en))).toBe(true);
    expect((await readFile(u.email, "performance-learnings.md"))!.content).toContain("Meta Ads");
    // Two pages for the window, and the same reader again for the 30 days before it (rule 733), which this fake answers
    // with the same two pages; Noor's analysis above holds the window's 10 ads only.
    const insights = calls.filter((k) => k.url.includes("/insights"));
    const since = (k: Call) => (JSON.parse(new URL(k.url).searchParams.get("time_range") ?? "{}") as { since?: string }).since;
    expect(insights).toHaveLength(4);
    expect(new Set(insights.filter(since).map(since)).size).toBe(2);
    expect(new URL(insights[0].url).searchParams.get("level")).toBe("ad");
    // The ad copy is read once, for the window: the previous read keeps totals only (totalsOnly).
    expect(calls.filter((k) => new URL(k.url).searchParams.has("ids"))).toHaveLength(1);
    expect((await (await import("@/lib/auth")).getUser(u.email))!.credits).toBe(credits);
  });

  it("Meta: never follows a paging link off the Graph host", async () => {
    fake({ evilNext: true });
    const u = await newUser("metaevil");
    await saveConnection(u.email, metaAdsConn());
    await signIn(u.email);
    expect((await act("meta_ads", { action: "sync_ads" })).status).toBe(200);
    expect(calls.some((k) => k.url.includes("evil.example"))).toBe(false);
    expect((await getPerf(u.email))!.rows).toBe(5);
  });

  it("Snapchat: converts micro-currency, names ads, and asks for one total broken down by ad", async () => {
    fake();
    const u = await newUser("snapsync");
    await saveConnection(u.email, snapConn());
    await signIn(u.email);
    expect((await act("snapchat", { action: "sync_ads" })).status).toBe(200);
    const snap = (await getPerf(u.email))!;
    expect(snap.totals).toMatchObject({ spend: 290, revenue: 1890, conversions: 13, impressions: 21000, clicks: 570 });
    expect(snap.top[0].name).toBe("عرض الجمعة");
    const stats = new URL(calls.find((k) => k.url.includes("/stats"))!.url);
    expect(stats.searchParams.get("granularity")).toBe("TOTAL");
    expect(stats.searchParams.get("breakdown")).toBe("ad");
    // Stats for the window and the 30 days before it (rule 733); the ad names are listed once, for the window only.
    expect(calls.filter((k) => k.url.includes("/stats"))).toHaveLength(2);
    expect(calls.filter((k) => new URL(k.url).pathname.endsWith("/ads"))).toHaveLength(1);
  });

  it("a revoked token asks the owner to reconnect instead of showing a raw error", async () => {
    fake({ revoked: true });
    const u = await newUser("adrevoked");
    await saveConnection(u.email, metaAdsConn());
    await signIn(u.email);
    const res = await act("meta_ads", { action: "sync_ads" });
    expect((await res.json()).error).toBe("reconnect_required");
    expect((await getConnection(u.email, "meta_ads"))!.needsReconnect).toBeTruthy();
  });

  it("six ad refreshes an hour per workspace, every ad platform together; the seventh asks no platform (735)", async () => {
    fake();
    const u = await newUser("adsyncrate");
    await Promise.all([saveConnection(u.email, metaAdsConn()), saveConnection(u.email, snapConn())]);
    await signIn(u.email);
    for (let i = 1; i <= 5; i++) expect((await act("meta_ads", { action: "sync_ads" })).status, `click ${i}`).toBe(200);
    expect((await act("snapchat", { action: "sync_ads" })).status, "click 6, another platform").toBe(200);
    calls = [];
    for (const provider of ["meta_ads", "snapchat"]) {
      const res = await act(provider, { action: "sync_ads" });
      expect(res.status, provider).toBe(429);
      expect(res.headers.get("Retry-After"), provider).toBe("3600");
      expect(await res.json(), provider).toMatchObject({ ok: false, error: "slow_down" });
    }
    expect(calls).toEqual([]);
  });

  it("the daily job reads a connected account once a day and never more", async () => {
    fake();
    const u = await newUser("addaily");
    await saveConnection(u.email, metaAdsConn());
    expect(await syncAdsIfDue(u.email)).toBe("meta_ads");
    expect(await syncAdsIfDue(u.email)).toBeNull();
    expect((await getPerf(u.email))!.source).toBe("meta_ads");
  });
});

describe("read only (rule 89)", () => {
  it("the ad readers send no POST except Meta's token exchange, and call fixed hosts only", () => {
    const src = readFileSync("src/lib/connectors/ads.ts", "utf8");
    expect(src.match(/method:\s*"POST"/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/method: "POST",\s*headers: \{ "Content-Type": "application\/x-www-form-urlencoded" \},\s*body: new URLSearchParams\(\{ grant_type: "fb_exchange_token"/);
    expect(src).not.toMatch(/method:\s*"(PUT|DELETE|PATCH)"/);
    for (const host of [...src.matchAll(/https:\/\/([a-z.]+)\//g)].map((m) => m[1])) expect(["graph.facebook.com", "adsapi.snapchat.com"]).toContain(host);
  });
});

/**
 * Rule 743: LinkedIn Ads results through Composio (spec C2). Read only: the toolkit lists no write; the ad account is
 * one LinkedIn listed at connect time, checked as digits before its URN is built; the analytics call is a constant whose
 * only variables are the account and the dates the code computed. Composio's client is the shared fake; answers follow
 * the shapes of LinkedIn's adAnalytics and adCampaigns responses.
 */
describe("LinkedIn Ads through Composio (rule 743)", () => {
  const NOW = new Date("2026-10-08T09:00:00Z");
  let tc: ToolCall[];
  let answers: Record<string, Answer>;
  beforeEach(() => {
    const f = fakeComposio();
    ({ calls: tc, answers } = f);
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubEnv("COMPOSIO_PROVIDERS", "linkedin_ads");
    vi.stubEnv("COMPOSIO_AUTH_LINKEDIN_ADS", "ac_test");
    setComposioClientForTests(f.client);
  });
  afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); });

  const liConn = (meta: Record<string, string> = {}): Connection => ({ provider: "linkedin_ads", connectedAt: NOW.toISOString(), data: { linkedin_ads: "ca_lia" }, meta: { via: "composio", adAccount: "5001", account: "Ward Ads", currency: "SAR", ...meta } });
  const date = (s: string) => { const [year, month, day] = s.split("-").map(Number); return { year, month, day }; };
  // The window (2026-09-08 to 2026-10-07): two campaigns delivered, one did not.
  const CUR = { elements: [
    { pivotValues: ["urn:li:sponsoredCampaign:901"], impressions: 12000, clicks: 300, costInLocalCurrency: "450.50", landingPageClicks: 250, externalWebsiteConversions: 9, dateRange: { start: date("2026-09-08"), end: date("2026-10-07") } },
    { pivotValues: ["urn:li:sponsoredCampaign:902"], impressions: 5000, clicks: 40, costInLocalCurrency: "120", landingPageClicks: 30, externalWebsiteConversions: 1 },
    { pivotValues: ["urn:li:sponsoredCampaign:903"], impressions: 0, clicks: 0, costInLocalCurrency: "0", externalWebsiteConversions: 0 },
  ] };
  // The 30 days before it (2026-08-09 to 2026-09-07).
  const PREV = { elements: [{ pivotValues: ["urn:li:sponsoredCampaign:901"], impressions: 8000, clicks: 150, costInLocalCurrency: "300", externalWebsiteConversions: 4 }] };
  const CAMPAIGNS = { elements: [{ id: 901, name: "عرض *الخريف*\nالجديد", account: "urn:li:sponsoredAccount:5001" }, { id: 902, name: "Brand awareness", account: "urn:li:sponsoredAccount:5001" }] };

  it("lists LinkedIn Ads reads only, with the spec's arguments, pinned (743)", async () => {
    expect(TOOLKITS.linkedin_ads).toEqual({
      provider: "linkedin_ads", authEnv: "COMPOSIO_AUTH_LINKEDIN_ADS",
      read: {
        LINKEDIN_ADS_SEARCH_AD_ACCOUNTS: ["status", "test", "page_size", "page_token"],
        LINKEDIN_ADS_GET_AD_ACCOUNT: ["ad_account_id"],
        LINKEDIN_ADS_GET_AD_ANALYTICS: ["q", "pivot", "fields", "accounts", "dateRange", "timeGranularity"],
        LINKEDIN_ADS_SEARCH_CAMPAIGNS: ["adAccountId", "pageSize", "pageToken"],
      },
      write: {},
    });
    expect(PROVIDER_TOOLKITS.linkedin_ads).toEqual(["linkedin_ads"]);
    expect(TOOLKIT_VERSION.linkedin_ads).toBe("20260826_00");
    expect(getProvider("linkedin_ads")).toMatchObject({ name: "LinkedIn Ads (results)", kind: "oauth", capabilities: ["ads"] });
    // Only through Composio: ready with the key, the provider listed and the auth config; never otherwise.
    expect(isAvailable(getProvider("linkedin_ads")!)).toBe(true);
    vi.stubEnv("COMPOSIO_PROVIDERS", "");
    expect(isAvailable(getProvider("linkedin_ads")!)).toBe(false);
    for (const slug of Object.keys(TOOLKITS.linkedin_ads.read)) await expect(composioWrite("s1", "linkedin_ads", slug, {}, "ca_lia")).rejects.toThrow("composio_tool_not_allowed");
    expect(tc).toEqual([]);
  });

  it("reads the chosen ad account with the constant analytics call and one campaign-name call (743)", async () => {
    answers.LINKEDIN_ADS_GET_AD_ANALYTICS = ok(CUR);
    answers.LINKEDIN_ADS_SEARCH_CAMPAIGNS = ok(CAMPAIGNS);
    const pull = await adRowsVia("s1", liConn(), NOW);
    expect(LI_ADS_FIELDS).toBe("impressions,clicks,costInLocalCurrency,landingPageClicks,externalWebsiteConversions,pivotValues,dateRange");
    expect(tc).toHaveLength(2);
    // The end date is inclusive at LinkedIn: the window's last whole day, yesterday.
    expect(tc.find((c) => c.slug === "LINKEDIN_ADS_GET_AD_ANALYTICS")?.args).toEqual({
      q: "analytics", pivot: "CAMPAIGN", timeGranularity: "ALL", accounts: ["urn:li:sponsoredAccount:5001"],
      dateRange: { start: { year: 2026, month: 9, day: 8 }, end: { year: 2026, month: 10, day: 7 } }, fields: LI_ADS_FIELDS,
    });
    expect(tc.find((c) => c.slug === "LINKEDIN_ADS_SEARCH_CAMPAIGNS")?.args).toEqual({ adAccountId: 5001, pageSize: 100 });
    expect(pull).toMatchObject({ platform: "LinkedIn Ads", account: "Ward Ads", currency: "SAR", range: { from: "2026-09-08", to: "2026-10-07" } });
    // Campaign names by id from pivotValues, cleaned; spend is costInLocalCurrency, conversions the website conversions,
    // revenue unknown (LinkedIn reports no value); a campaign that did not deliver is left out.
    expect(pull.rows).toEqual([
      { name: "عرض الخريف الجديد", text: "", group: "", impressions: 12000, clicks: 300, spend: 450.5, conversions: 9, revenue: null, sends: null, opens: null },
      { name: "Brand awareness", text: "", group: "", impressions: 5000, clicks: 40, spend: 120, conversions: 1, revenue: null, sends: null, opens: null },
    ]);
  });

  it("a failed campaign-name call keeps the results under the campaign ids; a missing figure stays null", async () => {
    answers.LINKEDIN_ADS_GET_AD_ANALYTICS = ok({ elements: [{ pivotValues: ["urn:li:sponsoredCampaign:901"], impressions: "12000", clicks: "N/A", costInLocalCurrency: "450.5" }] });
    const pull = await linkedinAdsVia("s1", liConn(), NOW);
    expect(pull.rows).toEqual([{ name: "Campaign 901", text: "", group: "", impressions: 12000, clicks: null, spend: 450.5, conversions: null, revenue: null, sends: null, opens: null }]);
  });

  it("refuses an ad account that is not digits before any call (743)", async () => {
    for (const bad of ["", "urn:li:sponsoredAccount:5001", "5001,5002", "abc", "1234567890123456"]) {
      await expect(linkedinAdsVia("s1", liConn({ adAccount: bad }), NOW)).rejects.toThrow("no_ad_account");
    }
    await expect(linkedinAdsVia("s1", { ...liConn(), data: {} }, NOW)).rejects.toThrow("not_connected");
    expect(tc).toEqual([]);
  });

  it("connect keeps only the active ad accounts LinkedIn listed; select_ad_account takes only one of them (743)", async () => {
    answers.LINKEDIN_ADS_SEARCH_AD_ACCOUNTS = ok({ elements: [
      { id: 5001, name: "Ward *Ads*", currency: "SAR", status: "ACTIVE", test: false },
      { id: 5002, name: "Old brand", currency: "SAR", status: "CANCELED" },
      { id: "urn:li:sponsoredAccount:5003", name: "Second brand", currency: "AED", status: "ACTIVE" },
      { id: "5004 OR 1", name: "junk", status: "ACTIVE" },
      { id: "12345678901234567", name: "too long", status: "ACTIVE" },
    ] });
    const c = await connectViaComposio("s1", "linkedin_ads", "linkedin_ads", "ca_lia", null);
    expect(tc).toEqual([{ slug: "LINKEDIN_ADS_SEARCH_AD_ACCOUNTS", args: { page_size: 100 } }]);
    expect(c.data).toEqual({ linkedin_ads: "ca_lia" });
    expect(c.meta).toMatchObject({ via: "composio", adAccount: "5001", account: "Ward Ads", currency: "SAR" });
    expect(JSON.parse(c.meta!.adAccounts).map((a: { id: string }) => a.id)).toEqual(["5001", "5003"]);

    const u = await newUser("liadsel");
    await saveConnection(u.email, c);
    await signIn(u.email);
    expect((await act("linkedin_ads", { action: "select_ad_account", accountId: "5002" })).status).toBe(400);
    expect((await act("linkedin_ads", { action: "select_ad_account", accountId: "urn:li:sponsoredAccount:5003" })).status).toBe(400);
    expect((await getConnection(u.email, "linkedin_ads"))!.meta).toMatchObject({ adAccount: "5001" });
    expect((await act("linkedin_ads", { action: "select_ad_account", accountId: "5003" })).status).toBe(200);
    expect((await getConnection(u.email, "linkedin_ads"))!.meta).toMatchObject({ adAccount: "5003", account: "Second brand", currency: "AED" });

    // A login with no active ad account is refused rather than saved.
    answers.LINKEDIN_ADS_SEARCH_AD_ACCOUNTS = ok({ elements: [{ id: 5002, name: "Old brand", status: "CANCELED" }] });
    await expect(connectViaComposio("s1", "linkedin_ads", "linkedin_ads", "ca_lia2", null)).rejects.toThrow("no_ad_account");
  });

  it("syncAds writes adstats:linkedin_ads with campaign names, spend, clicks and conversions, and the previous 30 days from the same call (733, 743)", async () => {
    answers.LINKEDIN_ADS_GET_AD_ANALYTICS = (a) => ok((a.dateRange as { start: { month: number } }).start.month === 9 ? CUR : PREV);
    answers.LINKEDIN_ADS_SEARCH_CAMPAIGNS = ok(CAMPAIGNS);
    const u = await newUser("liadsync");
    const snap = await syncAds(u.email, "linkedin_ads", liConn(), NOW);
    expect(snap).toMatchObject({ source: "linkedin_ads", platform: "LinkedIn Ads", rows: 2 });
    // The previous read is the same constant call over the 30 days before the window, totals only: no second names call.
    const analytics = tc.filter((c) => c.slug === "LINKEDIN_ADS_GET_AD_ANALYTICS");
    expect(analytics.map((c) => c.args.dateRange)).toEqual(expect.arrayContaining([
      { start: { year: 2026, month: 9, day: 8 }, end: { year: 2026, month: 10, day: 7 } },
      { start: { year: 2026, month: 8, day: 9 }, end: { year: 2026, month: 9, day: 7 } },
    ]));
    expect(analytics).toHaveLength(2);
    expect(tc.filter((c) => c.slug === "LINKEDIN_ADS_SEARCH_CAMPAIGNS")).toHaveLength(1);
    const st = (await db.get<AdStats>(ADSTATS_KEY(u.email, "linkedin_ads")))!;
    expect(st).toMatchObject({ provider: "linkedin_ads", account: "Ward Ads", currency: "SAR", range: { from: "2026-09-08", to: "2026-10-07" }, spend: 570.5, impressions: 17000, clicks: 340, conversions: 10, revenue: null });
    expect(st.top[0]).toEqual({ name: "عرض الخريف الجديد", spend: 450.5, clicks: 300, conversions: 9 });
    expect(st.prev).toEqual({ range: { from: "2026-08-09", to: "2026-09-07" }, spend: 300, impressions: 8000, clicks: 150, conversions: 4, revenue: null });
    expect(await db.get(`adsync:${u.email}:linkedin_ads`)).toBe(NOW.toISOString());
  });

  it("no previous period when the 30 days before delivered nothing or failed (733)", async () => {
    answers.LINKEDIN_ADS_GET_AD_ANALYTICS = (a) => (a.dateRange as { start: { month: number } }).start.month === 9 ? ok(CUR) : ok({ elements: [] });
    answers.LINKEDIN_ADS_SEARCH_CAMPAIGNS = ok(CAMPAIGNS);
    const u = await newUser("liadnoprev");
    await syncAds(u.email, "linkedin_ads", liConn(), NOW);
    expect((await db.get<AdStats>(ADSTATS_KEY(u.email, "linkedin_ads")))!.prev).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      answers.LINKEDIN_ADS_GET_AD_ANALYTICS = (a) => (a.dateRange as { start: { month: number } }).start.month === 9 ? ok(CUR) : { successful: false, error: "server error" };
      await syncAds(u.email, "linkedin_ads", liConn(), NOW);
      expect((await db.get<AdStats>(ADSTATS_KEY(u.email, "linkedin_ads")))!.prev).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("ad_prev_failed", { provider: "linkedin_ads", error: "linkedin_ads 502 ads_get_ad_analytics" });
    } finally { warn.mockRestore(); err.mockRestore(); }
  });
});
