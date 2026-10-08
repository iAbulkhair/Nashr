import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { newUser, settle } from "./helpers/session";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { setComposioClientForTests } from "@/lib/connectors/composio";
import { getSiteSnapshot, readSiteSoon, siteDataBlock, syncSite, syncSiteIfDue, type SiteSnapshot } from "@/lib/site-stats";
import SiteStats from "@/components/app/SiteStats";
import { fakeComposio, ok, type Answer, type Call } from "./helpers/composio-fake";

/**
 * Rules 733 and 737, site part (spec docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md, A2 and A3):
 * GA4 and Search Console read the 28 days before their window in the same run, only from ranges Google returned; a
 * figure Google did not return is null, never 0; `force` reads again at once. Composio is the shared fake; its answers
 * follow GA4's runReport and Search Console's searchAnalytics.query shapes.
 */
const NOW = new Date("2026-10-08T09:00:00Z");
/** GA4's window ends yesterday; Search Console's three days before the read (its figures settle late). */
const GA_CUR = { from: "2026-09-10", to: "2026-10-07" };
const GA_PREV = { from: "2026-08-13", to: "2026-09-09" };
const GSC_CUR = { from: "2026-09-08", to: "2026-10-05" };
const GSC_PREV = { from: "2026-08-11", to: "2026-09-07" };
const SITE = "sc-domain:roastery.example";
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

let calls: Call[];
let answers: Record<string, Answer>;
beforeEach(() => {
  const f = fakeComposio();
  ({ calls, answers } = f);
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "google");
  setComposioClientForTests(f.client);
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

const google = (meta: Record<string, string> = {}): Connection => ({
  provider: "google", connectedAt: NOW.toISOString(), data: { google_analytics: "ca_ga", google_search_console: "ca_gsc" },
  meta: { via: "composio", gaProperty: "properties/987", gaName: "roastery.example", gscSite: SITE, ...meta },
});
/** Metric values in request order; null is a value GA4 left out. */
const mv = (m: (string | null)[]) => m.map((value) => (value == null ? {} : { value }));
/** A GA4 row: the requested dimension, then the date range GA4 appends (the name we sent), then the metrics. */
const gaRow = (dim: string, range: string, ...m: (string | null)[]) => ({ dimensionValues: [{ value: dim }, { value: range }], metricValues: mv(m) });
const dims = (c: Call) => (c.args.dimensions as { name: string }[]).map((d) => d.name);

/**
 * The channel report (sessions, users, engagement rate, key events, revenue): 100 sessions in the window and 80 before
 * it, the rows of both ranges interleaved as GA4 sorts them. The page report: the previous range's busiest page comes
 * first and must not reach the window's pages.
 */
const gaReport = (args: Record<string, unknown>) => (args.dimensions as { name: string }[])[0].name === "landingPage"
  ? ok({ rows: [gaRow("/old-offer", "prev", "500", "9"), gaRow("/oud", "cur", "300", "6"), gaRow("/bakhoor", "cur", "100", "2")] })
  : ok({ dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }, { name: "dateRange" }], rows: [
    gaRow("Organic Search", "cur", "60", "50", "0.5", "12", "1500.5"),
    gaRow("Organic Search", "prev", "50", "45", "0.4", "10", "1000"),
    gaRow("Paid Social", "cur", "40", "38", "0.25", "3", "0"),
    gaRow("Paid Social", "prev", "30", "29", "0.2", "2", "0"),
  ] });
/** Search Console by date: the window and the 28 days before it, told apart by the dates asked for. */
const gscQuery = (args: Record<string, unknown>) => {
  if ((args.dimensions as string[])[0] === "query") return ok({ rows: [{ keys: ["قهوة مختصة"], clicks: 20, impressions: 150, position: 3.14 }] });
  return args.start_date === GSC_CUR.from
    ? ok({ rows: [{ keys: ["2026-10-01"], clicks: 10, impressions: 100, position: 4 }, { keys: ["2026-10-02"], clicks: 30, impressions: 300, position: 8 }] })
    : ok({ rows: [{ keys: ["2026-09-01"], clicks: 20, impressions: 400, position: 10 }] });
};

describe("the previous 28 days beside each site read (rule 733)", () => {
  it("GA4 asks for both named ranges and doubles the limits (733)", async () => {
    const u = await newUser("sitega");
    answers.GOOGLE_ANALYTICS_RUN_REPORT = gaReport;
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = gscQuery;
    await syncSite(u.email, google(), NOW);
    const reports = calls.filter((c) => c.slug === "GOOGLE_ANALYTICS_RUN_REPORT");
    expect(reports).toHaveLength(2);
    for (const r of reports) {
      expect(r.args.dateRanges).toEqual([{ startDate: GA_CUR.from, endDate: GA_CUR.to, name: "cur" }, { startDate: GA_PREV.from, endDate: GA_PREV.to, name: "prev" }]);
      expect((r.args.dateRanges as { name: string }[]).map((d) => d.name)).toEqual(["cur", "prev"]);
    }
    // 20 channels and 10 pages per range, as before: the limits double because each range returns its own rows.
    expect(Object.fromEntries(reports.map((r) => [dims(r)[0], r.args.limit]))).toEqual({ sessionDefaultChannelGroup: 40, landingPage: 20 });
    expect(GA_PREV.to).toBe(dayBefore(GA_CUR.from));
  });

  it("rows split by the dateRange column; the previous totals land in prev (733)", async () => {
    const u = await newUser("sitesplit");
    answers.GOOGLE_ANALYTICS_RUN_REPORT = (args) => {
      const r = gaReport(args);
      // A row GA4 did not label with one of our ranges counts in neither period.
      if (dims({ slug: "", args })[0] !== "landingPage") (r.data as { rows: unknown[] }).rows.push({ dimensionValues: [{ value: "Direct" }], metricValues: mv(["999", "999", "1", "99", "99"]) });
      return r;
    };
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = gscQuery;
    const snap = await syncSite(u.email, google(), NOW);
    expect(snap.ga).toMatchObject({ range: GA_CUR, sessions: 100, keyEvents: 15, revenue: 1500.5, engagementRate: 0.4 });
    // (50 × 0.4 + 30 × 0.2) / 80, weighted by sessions like the window's rate.
    expect(snap.ga?.prev).toEqual({ range: GA_PREV, sessions: 80, keyEvents: 12, revenue: 1000, engagementRate: 0.325 });
    expect(snap.ga?.channels.map((c) => [c.name, c.sessions])).toEqual([["Organic Search", 60], ["Paid Social", 40]]);
    expect(snap.ga?.pages).toEqual([{ path: "/oud", sessions: 300, keyEvents: 6 }, { path: "/bakhoor", sessions: 100, keyEvents: 2 }]);
  });

  it("Search Console reads the previous range by date (733)", async () => {
    const u = await newUser("sitegsc");
    answers.GOOGLE_ANALYTICS_RUN_REPORT = gaReport;
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = gscQuery;
    const snap = await syncSite(u.email, google(), NOW);
    const queries = calls.filter((c) => c.slug === "GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY").map((c) => c.args);
    expect(queries).toHaveLength(3);
    expect(queries).toEqual(expect.arrayContaining([
      { site_url: SITE, start_date: GSC_CUR.from, end_date: GSC_CUR.to, dimensions: ["date"], row_limit: 100 },
      { site_url: SITE, start_date: GSC_CUR.from, end_date: GSC_CUR.to, dimensions: ["query"], row_limit: 15 },
      // The one extra query: by date, ending the day before the window starts, the same length.
      { site_url: SITE, start_date: GSC_PREV.from, end_date: dayBefore(GSC_CUR.from), dimensions: ["date"], row_limit: 100 },
    ]));
    expect(snap.gsc).toMatchObject({ range: GSC_CUR, clicks: 40, impressions: 400, ctr: 0.1, position: 7 });
    expect(snap.gsc?.prev).toEqual({ range: GSC_PREV, clicks: 20, impressions: 400, ctr: 0.05, position: 10 });
    expect(snap.gsc?.queries).toEqual([{ query: "قهوة مختصة", clicks: 20, impressions: 150, position: 3.1 }]);
  });

  it("a failed previous Search Console read leaves no prev and never fails the sync (733)", async () => {
    const u = await newUser("siteprevfail");
    answers.GOOGLE_ANALYTICS_RUN_REPORT = gaReport;
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = (args) => (args.start_date === GSC_PREV.from ? { successful: false, error: "Internal error (500)" } : gscQuery(args));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const snap = await syncSite(u.email, google(), NOW);
    expect(snap.gsc).toMatchObject({ clicks: 40, impressions: 400 });
    expect(snap.gsc?.prev).toBeUndefined();
    expect(snap.gscError).toBeUndefined();
    expect((await getSiteSnapshot(u.email))?.gsc?.prev).toBeUndefined();
  });

  it("an empty previous period leaves no prev, so no change can be written (733)", async () => {
    const u = await newUser("siteprevempty");
    // A new property and a new site: Google returns rows for the window only.
    answers.GOOGLE_ANALYTICS_RUN_REPORT = (args) => ok({ rows: ((gaReport(args).data as { rows: { dimensionValues: { value: string }[] }[] }).rows).filter((r) => r.dimensionValues[1]?.value === "cur") });
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = (args) => (args.start_date === GSC_PREV.from ? ok({ rows: [] }) : gscQuery(args));
    const snap = await syncSite(u.email, google(), NOW);
    expect(snap.ga?.sessions).toBe(100);
    expect(snap.ga?.prev).toBeUndefined();
    expect(snap.gsc?.prev).toBeUndefined();
    expect(await siteDataBlock(u.email, NOW)).not.toMatch(/"prev":/);
  });
});

describe("a site figure not read is null, never 0 (rule 737)", () => {
  it("a figure not read is null, not zero (737)", async () => {
    const u = await newUser("sitenull");
    // Rows without key events or revenue, one with junk sessions; Search Console days with junk and empty figures.
    answers.GOOGLE_ANALYTICS_RUN_REPORT = (args) => dims({ slug: "", args })[0] === "landingPage"
      ? ok({ rows: [gaRow("/oud", "cur", "300", null)] })
      : ok({ rows: [gaRow("Organic Search", "cur", "600", "500", "0.5"), gaRow("Referral", "cur", "N/A", "", "0.9")] });
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = (args) => (args.dimensions as string[])[0] === "query"
      ? ok({ rows: [{ keys: ["oud"], clicks: "5" }] })
      : ok({ rows: [{ keys: ["2026-10-01"], impressions: "N/A" }, { keys: ["2026-10-02"], clicks: {} }] });
    const snap = await syncSite(u.email, google(), NOW);
    // The junk row carries no sessions, so it weighs nothing in the rate.
    expect(snap.ga).toMatchObject({ sessions: 600, keyEvents: null, revenue: null, engagementRate: 0.5 });
    expect(snap.ga?.channels).toEqual([
      { name: "Organic Search", sessions: 600, users: 500, keyEvents: null, revenue: null },
      { name: "Referral", sessions: null, users: null, keyEvents: null, revenue: null },
    ]);
    expect(snap.ga?.pages).toEqual([{ path: "/oud", sessions: 300, keyEvents: null }]);
    expect(snap.gsc).toMatchObject({ clicks: null, impressions: null, ctr: null, position: null });
    expect(snap.gsc?.queries).toEqual([{ query: "oud", clicks: 5, impressions: null, position: null }]);
    expect(JSON.stringify(await getSiteSnapshot(u.email))).not.toMatch(/NaN/);

    const data = JSON.parse((await siteDataBlock(u.email, NOW)).match(/<site_data>(.*)<\/site_data>/)![1]);
    expect(data.analytics).toMatchObject({ sessions: 600, key_events: null, purchase_revenue: null });
    expect(data.search).toMatchObject({ clicks: null, impressions: null, ctr: null, average_position: null });
  });

  it("a part Google returned no rows for has null totals, not 0 (737)", async () => {
    const u = await newUser("siteempty");
    answers.GOOGLE_ANALYTICS_RUN_REPORT = ok({ rows: [] });
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = ok({ rows: [] });
    const snap = await syncSite(u.email, google(), NOW);
    expect(snap.ga).toMatchObject({ sessions: null, keyEvents: null, revenue: null, engagementRate: null, channels: [], pages: [] });
    expect(snap.gsc).toMatchObject({ clicks: null, impressions: null, ctr: null, position: null, queries: [] });
    expect(snap.ga?.prev).toBeUndefined();
    expect(snap.gsc?.prev).toBeUndefined();
  });
});

describe("a site read at once (A3)", () => {
  it("force reads again inside 20 hours", async () => {
    const u = await newUser("siteforce");
    await saveConnection(u.email, google());
    answers.GOOGLE_ANALYTICS_RUN_REPORT = gaReport;
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = gscQuery;
    expect(await syncSiteIfDue(u.email, NOW)).toBe(true);
    const hourLater = new Date(NOW.getTime() + 3600e3);
    expect(await syncSiteIfDue(u.email, hourLater)).toBe(false);
    expect(await syncSiteIfDue(u.email, NOW, true)).toBe(true);
    expect(await syncSiteIfDue(u.email, hourLater, true)).toBe(true);
    expect((await getSiteSnapshot(u.email))?.at).toBe(hourLater.toISOString());

    // Force never reads a record waiting for a reconnect, nor a direct one.
    calls.length = 0;
    await saveConnection(u.email, { ...google(), needsReconnect: NOW.toISOString() });
    expect(await syncSiteIfDue(u.email, hourLater, true)).toBe(false);
    await saveConnection(u.email, { provider: "google", data: { access_token: "t" }, meta: {}, connectedAt: NOW.toISOString() });
    expect(await syncSiteIfDue(u.email, hourLater, true)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("readSiteSoon reads after the response whatever the last read's age, and a failure only logs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const u = await newUser("sitesoon");
    await saveConnection(u.email, google());
    answers.GOOGLE_ANALYTICS_RUN_REPORT = gaReport;
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = gscQuery;
    await syncSite(u.email, google(), new Date(NOW.getTime() - 3600e3));
    calls.length = 0;
    readSiteSoon(u.email);
    await settle();
    expect(calls).toHaveLength(5);
    expect((await getSiteSnapshot(u.email))?.at).toBe(NOW.toISOString());

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    answers.GOOGLE_ANALYTICS_RUN_REPORT = { successful: false, error: "Internal error (500)" };
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = { successful: false, error: "Internal error (500)" };
    readSiteSoon(u.email);
    await settle();
    expect(err).toHaveBeenCalledWith("site read failed");
    expect((await getSiteSnapshot(u.email))?.ga?.sessions).toBe(100);
  });
});

describe("Dana's <site_data> and the site card (rules 733, 737)", () => {
  it("prints prev for each part and says to compare only with it", async () => {
    const u = await newUser("siteblock");
    answers.GOOGLE_ANALYTICS_RUN_REPORT = gaReport;
    answers.GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY = gscQuery;
    await syncSite(u.email, google(), NOW);
    const block = await siteDataBlock(u.email, NOW);
    const data = JSON.parse(block.match(/<site_data>(.*)<\/site_data>/)![1]);
    expect(data.analytics.prev).toEqual({ from: GA_PREV.from, to: GA_PREV.to, sessions: 80, key_events: 12, purchase_revenue: 1000, engagement_rate: 0.325 });
    expect(data.search.prev).toEqual({ from: GSC_PREV.from, to: GSC_PREV.to, clicks: 20, impressions: 400, ctr: 0.05, average_position: 10 });
    expect(block).toContain("compare only with prev; without prev write [رقم] and say it needs a second read");
    expect(block).toMatch(/null is a figure that was not read/);
    expect(block).toMatch(/never invent a change over time/);
  });

  const site: SiteSnapshot = {
    at: NOW.toISOString(),
    ga: {
      property: "properties/987", name: "roastery.example", range: GA_CUR, sessions: 100, keyEvents: null, revenue: null, engagementRate: 0.4,
      channels: [{ name: "Organic Search", sessions: null, users: 50, keyEvents: null, revenue: null }], pages: [],
      prev: { range: GA_PREV, sessions: 80, keyEvents: 12, revenue: null, engagementRate: 0.3 },
    },
    gsc: { site: SITE, range: GSC_CUR, clicks: 40, impressions: 400, ctr: 0.1, position: null, queries: [] },
  };

  it("the card shows a dash for a figure not read and a change only where prev exists", () => {
    const html = renderToStaticMarkup(createElement(SiteStats, { lang: "en", site }));
    expect(html).toMatch(/Key events<\/p><p[^>]*>—<\/p>/);
    expect(html).toMatch(/Average position<\/p><p[^>]*>—<\/p>/);
    expect(html).toMatch(/Organic Search<\/span><span[^>]*>—<\/span>/);
    expect(html).not.toMatch(/>0<\//);
    // Sessions 100 against 80; key events have no current figure, Search Console no prev: no change for either.
    expect(html).toContain("+25%");
    expect(html.match(/vs the previous 28 days/g)).toHaveLength(1);

    const ar = renderToStaticMarkup(createElement(SiteStats, { lang: "ar", site: { ...site, ga: { ...site.ga!, prev: undefined } } }));
    expect(ar).not.toMatch(/%/);
  });
});
