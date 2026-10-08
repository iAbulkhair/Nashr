import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { jar, json, newUser, signIn } from "./helpers/session";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { getProvider } from "@/lib/connectors/registry";
import { READS_ADS } from "@/lib/connectors/working";
import { getPerf, syncAdsIfDue } from "@/lib/perf-store";
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
    expect(READS_ADS).toEqual(["meta_ads", "snapchat", "google_ads", "tiktok_ads"]);
    // Google Ads and TikTok Ads have no direct app: they connect through Composio or not at all.
    expect(getProvider("google_ads")!.oauth).toBeUndefined();
    expect(getProvider("tiktok_ads")!.oauth).toBeUndefined();
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
