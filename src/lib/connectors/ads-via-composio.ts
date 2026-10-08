import type { Connection } from "./store";
import { clean, type Row } from "../perf-import";
import { pmap } from "../parallel";
import { composioRead } from "./composio";
import { accountOf, at, listOf, num, pick } from "./composio-shape";
import { adWindow, MAX_ROWS, micro, PAGES, prevNow, purchases, type AdAccount, type AdPull, type MetaAction } from "./ads";
import type { AdPrev } from "../ad-stats";

/**
 * Ad results read through Composio, as the same rows the CSV import and the direct readers produce (ads.ts), so every
 * source goes through one analysis and one learnings file for Noor.
 *
 * Read only, by construction: the catalog lists no write tool for metaads, snapchat, googleads or tiktok_ads, so nothing
 * here can create, edit, pause or fund an ad (the founder's rule of 2026-10-05). The ad account id is always one the
 * platform listed for this connection at connect time, never a value from a request; Google's query text is a constant
 * below with dates the code computed.
 *
 * Shapes follow Composio's output schemas read on 2026-10-05 (Snapchat's account stats on 2026-10-08); tests mock them,
 * and the measured run on real accounts (plan Task 8) is the real check. TikTok's revenue is spend × payment ROAS.
 */

const ACT = /^act_\d+$/;
const SNAP_ID = /^[0-9a-f-]{36}$/i;
const GADS_ID = /^\d{6,12}$/;
const TT_ID = /^\d{6,25}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Snap has no account-wide breakdown tool on Composio: stats are read per ad, for at most this many ads. */
const SNAP_ADS_READ = 50;
const GOOGLE_CUSTOMERS = 10;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/**
 * Run `fn` over `items` and keep what succeeded. One failed item is skipped; when every item failed, the first error is
 * thrown so a refused token still reaches refusedToken (fresh.ts) and asks the owner to reconnect.
 */
async function settle<T, R>(items: readonly T[], fn: (x: T) => Promise<R>, limit: number): Promise<R[]> {
  const out = await pmap(items, (x) => fn(x).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })), limit);
  const ok = out.flatMap((r) => (r.ok ? [r.v] : []));
  const failed = out.find((r) => !r.ok);
  if (!ok.length && failed && !failed.ok) throw failed.e;
  return ok;
}

// ---------- ad accounts, at connect time ----------

const GOOGLE_CUSTOMER_Q = "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1";

/** The ad accounts the connected login can read, names only. Closed, disabled and manager accounts are left out. */
export async function adAccountsVia(scope: string, provider: string, accountId: string): Promise<AdAccount[]> {
  if (provider === "meta_ads") {
    const r = await composioRead(scope, "metaads", "METAADS_GET_AD_ACCOUNTS", { fields: "id,name,currency,account_status", limit: 100 }, accountId);
    // 1 is ACTIVE; closed and disabled accounts have nothing to learn from.
    return listOf(r).filter((a) => ACT.test(str(a.id)) && (a.account_status == null || num(a.account_status) === 1))
      .map((a) => ({ id: str(a.id), name: clean(str(a.name) || str(a.id), 80), currency: str(a.currency) || undefined }));
  }
  if (provider === "snapchat") {
    const r = await composioRead(scope, "snapchat", "SNAPCHAT_LIST_ORGANIZATIONS", { with_ad_accounts: true }, accountId);
    return listOf(r, "organization").flatMap((o) => arr(at(o, "organization.ad_accounts")))
      .filter((a) => SNAP_ID.test(str(a.id)) && (!a.status || a.status === "ACTIVE"))
      .map((a) => ({ id: str(a.id), name: clean(str(a.name) || str(a.id), 80), currency: str(a.currency) || undefined }));
  }
  if (provider === "google_ads") {
    const r = await composioRead(scope, "googleads", "GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS", {}, accountId);
    const ids = [...new Set([...JSON.stringify(r ?? {}).matchAll(/customers\/(\d{6,12})/g)].map((m) => m[1]))].slice(0, GOOGLE_CUSTOMERS);
    const found = await settle(ids, async (id): Promise<AdAccount | null> => {
      const row = listOf(await composioRead(scope, "googleads", "GOOGLEADS_SEARCH_STREAM_GAQL", { query: GOOGLE_CUSTOMER_Q, customer_id: id }, accountId), "customer")[0];
      // A manager account holds no ads of its own; its client accounts are listed separately.
      if (!row || at(row, "customer.manager") === true) return null;
      const name = str(at(row, "customer.descriptiveName", "customer.descriptive_name")) || id;
      return { id, name: clean(name, 80), currency: str(at(row, "customer.currencyCode", "customer.currency_code")) || undefined };
    }, 4);
    return found.filter((a): a is AdAccount => !!a);
  }
  if (provider === "tiktok_ads") {
    const r = await composioRead(scope, "tiktok_ads", "TIKTOK_ADS_GET_ADVERTISER_ACCOUNTS", {}, accountId);
    return listOf(r, "advertiser_id").filter((a) => TT_ID.test(str(a.advertiser_id)) && (!a.status || /ENABLE/.test(str(a.status))))
      .map((a) => ({ id: str(a.advertiser_id), name: clean(str(a.name) || str(a.advertiser_id), 80), currency: str(a.currency) || undefined }));
  }
  throw new Error("not_an_ad_provider");
}

// ---------- results ----------

async function metaVia(scope: string, c: Connection, now: Date): Promise<AdPull> {
  const account = c.meta?.adAccount;
  if (!account || !ACT.test(account)) throw new Error("no_ad_account");
  const acc = accountOf(c, "metaads");
  const w = adWindow(now);
  const out: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let i = 0; i < PAGES && out.length < MAX_ROWS; i++) {
    const r = await composioRead(scope, "metaads", "METAADS_GET_INSIGHTS", {
      object_id: account, level: "ad", fields: "ad_id,ad_name,impressions,inline_link_clicks,spend,actions,action_values",
      time_range: { since: w.range.from, until: w.range.to }, limit: 500, ...(after ? { after } : {}),
    }, acc);
    out.push(...listOf(r, "ad_id"));
    // Meta sends `paging.next` only while more pages exist; the cursor goes back to Composio, never to a URL we fetch.
    after = at(r, "paging.next") ? str(at(r, "paging.cursors.after")) || undefined : undefined;
    if (!after) break;
  }
  // No ad copy here: reading creatives is not on the allowlist, so wording patterns come from the ad names only.
  const rows: Row[] = out.slice(0, MAX_ROWS).map((x) => ({
    name: clean(str(x.ad_name) || str(x.ad_id) || "ad"), text: "", group: "",
    impressions: num(x.impressions), clicks: num(x.inline_link_clicks), spend: num(x.spend),
    conversions: purchases(x.actions as MetaAction[] | undefined), revenue: purchases(x.action_values as MetaAction[] | undefined), sends: null, opens: null,
  })).filter((r) => r.name);
  return { rows, range: w.range, platform: "Meta Ads", account: c.meta?.account ?? account, currency: c.meta?.currency };
}

const SNAP_FIELDS = "impressions,swipes,spend,conversion_purchases,conversion_purchases_value";

async function snapVia(scope: string, c: Connection, now: Date): Promise<AdPull> {
  const account = c.meta?.adAccount;
  if (!account || !SNAP_ID.test(account)) throw new Error("no_ad_account");
  const acc = accountOf(c, "snapchat");
  const w = adWindow(now);
  const ads: { id: string; name: string; active: boolean }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGES; i++) {
    const r = await composioRead(scope, "snapchat", "SNAPCHAT_LIST_ADS_BY_ACCOUNT", { ad_account_id: account, limit: 1000, ...(cursor ? { cursor } : {}) }, acc);
    for (const x of listOf(r, "ad")) {
      const ad = x.ad as Record<string, unknown> | undefined;
      if (ad && SNAP_ID.test(str(ad.id)) && ad.deleted !== true) ads.push({ id: str(ad.id), name: str(ad.name) || str(ad.id), active: ad.status === "ACTIVE" });
    }
    const link = str(at(r, "paging.next_link"));
    if (!link) break;
    try { cursor = new URL(link).searchParams.get("cursor") ?? undefined; } catch { cursor = undefined; }
    if (!cursor) break;
  }
  // Running ads first: when there are more than the cap, the ones spending now matter most.
  const chosen = [...ads.filter((a) => a.active), ...ads.filter((a) => !a.active)].slice(0, SNAP_ADS_READ);
  const stats = await settle(chosen, async (a) => {
    const r = await composioRead(scope, "snapchat", "SNAPCHAT_GET_AD_STATS", { ad_id: a.id, fields: SNAP_FIELDS, granularity: "TOTAL", start_time: w.start.toISOString(), end_time: w.end.toISOString() }, acc);
    // Snap nests the figures as total_stats[].total_stat.stats, under Composio's own wrapper: deeper than pick's default.
    const v = (k: string) => num(pick(r, [k], 7));
    return { a, impressions: v("impressions"), swipes: v("swipes"), spend: v("spend"), purchases: v("conversion_purchases"), value: v("conversion_purchases_value") };
  }, 5);
  const rows: Row[] = stats.filter((s) => s.impressions || s.spend).map((s) => ({
    name: clean(s.a.name), text: "", group: "",
    impressions: s.impressions, clicks: s.swipes, spend: micro(s.spend), conversions: s.purchases, revenue: micro(s.value), sends: null, opens: null,
  }));
  return { rows, range: w.range, platform: "Snapchat Ads", account: c.meta?.account ?? account, currency: c.meta?.currency };
}

/**
 * The ad account's spend over the 30 days before the window (rule 733), in one account-level call: Snap serves only
 * spend at this level, so the other previous figures stay null, and a second per-ad pass (up to 50 more calls) is not
 * run. The same id check and time format as snapVia. No spend figure, junk or zero spend gives no previous period: a new
 * account has nothing to compare with, so no change is ever written from it.
 */
export async function snapPrevSpendVia(scope: string, c: Connection, now: Date): Promise<AdPrev | null> {
  const account = c.meta?.adAccount;
  if (!account || !SNAP_ID.test(account)) throw new Error("no_ad_account");
  const w = adWindow(prevNow(now));
  const r = await composioRead(scope, "snapchat", "SNAPCHAT_GET_AD_ACCOUNTS_STATS", { ad_account_id: account, fields: "spend", granularity: "TOTAL", start_time: w.start.toISOString(), end_time: w.end.toISOString() }, accountOf(c, "snapchat"));
  // Micro-currency, under Composio's wrapper as total_stats[].total_stat.stats: deeper than pick's default.
  const spend = micro(num(pick(r, ["spend"], 7)));
  if (spend == null || spend <= 0) return null;
  return { range: w.range, spend: Math.round(spend * 100) / 100, impressions: null, clicks: null, conversions: null, revenue: null };
}

/** Google Ads results per ad over the window. The text is fixed; only the two dates (computed, checked) vary. */
export function googleQuery(from: string, to: string): string {
  if (!DATE.test(from) || !DATE.test(to)) throw new Error("bad_range");
  return "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group.name, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value"
    + ` FROM ad_group_ad WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0 LIMIT ${MAX_ROWS}`;
}

async function googleVia(scope: string, c: Connection, now: Date): Promise<AdPull> {
  const customer = c.meta?.adAccount;
  if (!customer || !GADS_ID.test(customer)) throw new Error("no_ad_account");
  const w = adWindow(now);
  const r = await composioRead(scope, "googleads", "GOOGLEADS_SEARCH_STREAM_GAQL", { query: googleQuery(w.range.from, w.range.to), customer_id: customer }, accountOf(c, "googleads"));
  const rows: Row[] = listOf(r, "metrics").slice(0, MAX_ROWS).map((x) => {
    const id = str(at(x, "adGroupAd.ad.id", "ad_group_ad.ad.id"));
    const campaign = str(at(x, "campaign.name"));
    const group = str(at(x, "adGroup.name", "ad_group.name"));
    // Search ads usually have no name of their own: the campaign and ad group name them.
    const name = str(at(x, "adGroupAd.ad.name", "ad_group_ad.ad.name")) || [campaign, group].filter(Boolean).join(" / ") + (id ? ` #${id.slice(-4)}` : "");
    const cost = num(at(x, "metrics.costMicros", "metrics.cost_micros"));
    return {
      name: clean(name || id || "ad"), text: "", group: clean(campaign, 80),
      impressions: num(at(x, "metrics.impressions")), clicks: num(at(x, "metrics.clicks")), spend: cost == null ? null : cost / 1e6,
      conversions: num(at(x, "metrics.conversions")), revenue: num(at(x, "metrics.conversionsValue", "metrics.conversions_value")), sends: null, opens: null,
    };
  });
  return { rows, range: w.range, platform: "Google Ads", account: c.meta?.account ?? customer, currency: c.meta?.currency };
}

const TT_METRICS = ["ad_name", "campaign_name", "spend", "impressions", "clicks", "complete_payment", "complete_payment_roas"];

async function tiktokVia(scope: string, c: Connection, now: Date): Promise<AdPull> {
  const advertiser = c.meta?.adAccount;
  if (!advertiser || !TT_ID.test(advertiser)) throw new Error("no_ad_account");
  const acc = accountOf(c, "tiktok_ads");
  const w = adWindow(now);
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= PAGES && out.length < MAX_ROWS; page++) {
    const r = await composioRead(scope, "tiktok_ads", "TIKTOK_ADS_GET_REPORT_INTEGRATED", {
      report_type: "BASIC", advertiser_id: advertiser, data_level: "AUCTION_AD", dimensions: ["ad_id"], metrics: TT_METRICS,
      start_date: w.range.from, end_date: w.range.to, page, page_size: 1000,
    }, acc);
    out.push(...listOf(r, "metrics"));
    const total = num(at(r, "page_info.total_page"));
    if (at(r, "has_more") !== true && !(total != null && total > page)) break;
  }
  const rows: Row[] = out.slice(0, MAX_ROWS).map((x) => {
    const m = (x.metrics ?? {}) as Record<string, unknown>;
    const spend = num(m.spend);
    const roas = num(m.complete_payment_roas);
    return {
      name: clean(str(m.ad_name) || str(at(x, "dimensions.ad_id")) || "ad"), text: "", group: clean(str(m.campaign_name), 80),
      impressions: num(m.impressions), clicks: num(m.clicks), spend, conversions: num(m.complete_payment),
      revenue: spend != null && roas != null ? Math.round(spend * roas * 100) / 100 : null, sends: null, opens: null,
    };
  }).filter((r) => r.impressions || r.spend);
  return { rows, range: w.range, platform: "TikTok Ads", account: c.meta?.account ?? advertiser, currency: c.meta?.currency };
}

/** The last 30 whole days of a Composio ad record, one reader per platform. */
export function adRowsVia(scope: string, c: Connection, now = new Date()): Promise<AdPull> {
  if (c.provider === "meta_ads") return metaVia(scope, c, now);
  if (c.provider === "snapchat") return snapVia(scope, c, now);
  if (c.provider === "google_ads") return googleVia(scope, c, now);
  if (c.provider === "tiktok_ads") return tiktokVia(scope, c, now);
  return Promise.reject(new Error("not_an_ad_provider"));
}
