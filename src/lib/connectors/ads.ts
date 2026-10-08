import type { Connection } from "./store";
import { clean, type Row } from "../perf-import";

/**
 * Ad results read from Meta and Snapchat, as the same rows the CSV import produces (src/lib/perf-import.ts), so live
 * results and an uploaded export go through one analysis and one learnings file.
 *
 * Read only. Nothing here creates, edits, pauses or funds an ad; the only permissions asked for are Meta's `ads_read`
 * and Snapchat's `snapchat-marketing-api` (which Snap grants as one scope; only GET endpoints are called). The hosts
 * are fixed and the ad account id is always one the platform listed for this connection, never a value from a request.
 *
 * Shapes follow the platforms' documentation as of 2026-09 (Meta Marketing API v23 Insights, Snap Marketing API v1
 * measurement). Tests mock those shapes; the first call against a live account is the real check.
 */
export const META_ADS = "https://graph.facebook.com/v23.0";
export const SNAP_ADS = "https://adsapi.snapchat.com/v1";
/** google_ads and tiktok_ads connect only through Composio (src/lib/connectors/ads-via-composio.ts). */
export const AD_PROVIDERS = ["meta_ads", "snapchat", "google_ads", "tiktok_ads"] as const;
export type AdProvider = (typeof AD_PROVIDERS)[number];
export const isAdProvider = (p: string): p is AdProvider => (AD_PROVIDERS as readonly string[]).includes(p);
export type AdAccount = { id: string; name: string; currency?: string };
export type AdPull = { rows: Row[]; range: { from: string; to: string }; platform: string; account: string; currency?: string };

const DAYS = 30;
export const MAX_ROWS = 2000;
export const PAGES = 10;

/** 401/403 in the message make refusedToken (fresh.ts) mark the connection for reconnecting, as for every platform. */
async function fail(r: Response, who: string, what: string): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: number }; request_status?: string; debug_message?: string; display_message?: string };
  const code = j.error?.code;
  const status = code === 190 ? 401 : code === 10 || code === 200 || code === 294 ? 403 : r.status;
  return new Error(`${who} ${what} ${status}: ${(j.error?.message ?? j.debug_message ?? j.display_message ?? "").slice(0, 160)}`);
}
async function get<T>(url: string, token: string, who: string, what: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw await fail(r, who, what);
  return (await r.json()) as T;
}
export const n = (v: unknown): number | null => { const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : null; };
const day = (d: Date) => d.toISOString().slice(0, 10);
export function adWindow(now = new Date()) {
  // Whole UTC days ending yesterday: today is still filling in and would drag every rate down.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - DAYS * 864e5);
  return { start, end, range: { from: day(start), to: day(new Date(end.getTime() - 864e5)) } };
}
/**
 * The moment whose window is the 30 days before `now`'s: `adWindow(prevNow(now))` ends the day before
 * `adWindow(now)` starts, back to back and the same length, so a previous period is read with the same reader, the same
 * constant query and the same date checks (rule 733).
 */
export const prevNow = (now: Date) => new Date(now.getTime() - DAYS * 864e5);
/**
 * `totalsOnly` (the previous period, rule 733): the same results query, without the calls whose output only Noor's
 * analysis uses, Meta's creative copy and Snapchat's ad names, since only that read's totals are kept.
 */
export type ReadOpts = { totalsOnly?: boolean };

// ---------- Meta ----------

/** The code's short-lived token → long-lived (about 60 days, no refresh token), app secret in the POST body only. */
export async function metaLongLived(short: string): Promise<{ token: string; expiresAt?: string }> {
  const r = await fetch(`${META_ADS}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID ?? "", client_secret: process.env.META_APP_SECRET ?? "", fb_exchange_token: short }),
  });
  if (!r.ok) throw await fail(r, "meta_ads", "token");
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("meta_ads token: no access_token");
  return { token: j.access_token, expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : undefined };
}

export async function metaAdAccounts(token: string): Promise<AdAccount[]> {
  const j = await get<{ data?: { id: string; name?: string; currency?: string; account_status?: number }[] }>(`${META_ADS}/me/adaccounts?fields=id,name,currency,account_status&limit=100`, token, "meta_ads", "adaccounts");
  // 1 is ACTIVE; closed and disabled accounts are listed but have nothing to learn from.
  return (j.data ?? []).filter((a) => /^act_\d+$/.test(a.id) && (a.account_status == null || a.account_status === 1)).map((a) => ({ id: a.id, name: clean(a.name ?? a.id, 80), currency: a.currency }));
}

export type MetaAction = { action_type?: string; value?: string };
/** Purchases, preferring Meta's de-duplicated "omni" count over the pixel-only one so a sale is not counted twice. */
const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
export function purchases(list: MetaAction[] | undefined): number | null {
  for (const t of PURCHASE) { const a = list?.find((x) => x.action_type === t); if (a) return n(a.value); }
  return null;
}

export async function metaRows(c: Connection, now = new Date(), opts: ReadOpts = {}): Promise<AdPull> {
  const account = c.meta?.adAccount;
  if (!account || !/^act_\d+$/.test(account)) throw new Error("no_ad_account");
  const token = c.data.access_token;
  const w = adWindow(now);
  const q = new URLSearchParams({ level: "ad", fields: "ad_id,ad_name,impressions,inline_link_clicks,spend,actions,action_values", time_range: JSON.stringify({ since: w.range.from, until: w.range.to }), limit: "500" });
  type Ins = { ad_id?: string; ad_name?: string; impressions?: string; inline_link_clicks?: string; spend?: string; actions?: MetaAction[]; action_values?: MetaAction[] };
  const out: Ins[] = [];
  let url: string | undefined = `${META_ADS}/${account}/insights?${q}`;
  for (let i = 0; url && i < PAGES && out.length < MAX_ROWS; i++) {
    const j: { data?: Ins[]; paging?: { next?: string } } = await get(url, token, "meta_ads", "insights");
    out.push(...(j.data ?? []));
    // Follow Meta's own cursor only while it stays on the Graph host.
    url = j.paging?.next?.startsWith(`${META_ADS}/`) ? j.paging.next : undefined;
  }
  // The ad's own words make the wording patterns work; one read for the ads on this page of results.
  const ids = [...new Set(out.map((x) => x.ad_id).filter((x): x is string => !!x && /^\d+$/.test(x)))].slice(0, 50);
  const copy = new Map<string, string>();
  if (ids.length && !opts.totalsOnly) {
    try {
      const j = await get<Record<string, { creative?: { body?: string; title?: string } }>>(`${META_ADS}/?ids=${ids.join(",")}&fields=creative%7Bbody,title%7D`, token, "meta_ads", "ads");
      for (const [id, v] of Object.entries(j)) copy.set(id, [v.creative?.title, v.creative?.body].filter(Boolean).join(" "));
    } catch { /* copy is a bonus; the numbers stand without it */ }
  }
  const rows: Row[] = out.slice(0, MAX_ROWS).map((x) => ({
    name: clean(x.ad_name || x.ad_id || "ad"), text: clean(copy.get(x.ad_id ?? "") ?? "", 300), group: "",
    impressions: n(x.impressions), clicks: n(x.inline_link_clicks), spend: n(x.spend), conversions: purchases(x.actions), revenue: purchases(x.action_values), sends: null, opens: null,
  })).filter((r) => r.name);
  return { rows, range: w.range, platform: "Meta Ads", account: c.meta?.account ?? account, currency: c.meta?.currency };
}

// ---------- Snapchat ----------

export async function snapAdAccounts(token: string): Promise<AdAccount[]> {
  const j = await get<{ organizations?: { organization?: { ad_accounts?: { id: string; name?: string; currency?: string; status?: string }[] } }[] }>(`${SNAP_ADS}/me/organizations?with_ad_accounts=true`, token, "snapchat", "organizations");
  return (j.organizations ?? []).flatMap((o) => o.organization?.ad_accounts ?? []).filter((a) => /^[0-9a-f-]{36}$/i.test(a.id) && (!a.status || a.status === "ACTIVE")).map((a) => ({ id: a.id, name: clean(a.name ?? a.id, 80), currency: a.currency }));
}

type SnapStats = { impressions?: number; swipes?: number; spend?: number; conversion_purchases?: number; conversion_purchases_value?: number };
/** Snap reports money in micro-currency: 1,000,000 is one unit of the account's currency. */
export const micro = (v: unknown) => { const x = n(v); return x == null ? null : x / 1e6; };

export async function snapRows(c: Connection, now = new Date(), opts: ReadOpts = {}): Promise<AdPull> {
  const account = c.meta?.adAccount;
  if (!account || !/^[0-9a-f-]{36}$/i.test(account)) throw new Error("no_ad_account");
  const token = c.data.access_token;
  const w = adWindow(now);
  // Names first: stats carry only ids. A totals-only read keeps the ids, which nothing shows.
  const names = new Map<string, string>();
  let url: string | undefined = opts.totalsOnly ? undefined : `${SNAP_ADS}/adaccounts/${account}/ads?limit=1000`;
  for (let i = 0; url && i < PAGES; i++) {
    const j: { ads?: { ad?: { id: string; name?: string } }[]; paging?: { next_link?: string } } = await get(url, token, "snapchat", "ads");
    for (const a of j.ads ?? []) if (a.ad?.id) names.set(a.ad.id, a.ad.name ?? a.ad.id);
    url = j.paging?.next_link?.startsWith(`${SNAP_ADS}/`) ? j.paging.next_link : undefined;
  }
  const q = new URLSearchParams({ granularity: "TOTAL", breakdown: "ad", fields: "impressions,swipes,spend,conversion_purchases,conversion_purchases_value", start_time: w.start.toISOString(), end_time: w.end.toISOString() });
  const j = await get<{ total_stats?: { total_stat?: { breakdown_stats?: { ad?: { id: string; stats?: SnapStats }[] } } }[] }>(`${SNAP_ADS}/adaccounts/${account}/stats?${q}`, token, "snapchat", "stats");
  const per = j.total_stats?.[0]?.total_stat?.breakdown_stats?.ad ?? [];
  const rows: Row[] = per.slice(0, MAX_ROWS).map((x) => ({
    name: clean(names.get(x.id) ?? x.id), text: "", group: "",
    impressions: n(x.stats?.impressions), clicks: n(x.stats?.swipes), spend: micro(x.stats?.spend), conversions: n(x.stats?.conversion_purchases), revenue: micro(x.stats?.conversion_purchases_value), sends: null, opens: null,
  }));
  return { rows, range: w.range, platform: "Snapchat Ads", account: c.meta?.account ?? account, currency: c.meta?.currency };
}

/** After the code exchange: the ad accounts the owner can read, and the first one chosen until they pick another. */
export async function connectAds(conn: Connection): Promise<Connection> {
  let data = conn.data, expiresAt = conn.expiresAt;
  if (conn.provider === "meta_ads") {
    const t = await metaLongLived(conn.data.access_token);
    data = { access_token: t.token };
    // No refresh token: when this lapses, fresh.ts asks the owner to connect again.
    expiresAt = t.expiresAt;
  }
  const accounts = conn.provider === "meta_ads" ? await metaAdAccounts(data.access_token) : await snapAdAccounts(data.access_token);
  if (!accounts.length) throw new Error("no_ad_account");
  return { ...conn, data, expiresAt, meta: { ...conn.meta, ...accountMeta(accounts, accounts[0].id)! } };
}

/** Names only in `meta` (plain); tokens stay in `data` (encrypted). */
export function accountMeta(accounts: AdAccount[], id: string): Record<string, string> | null {
  const a = accounts.find((x) => x.id === id);
  if (!a) return null;
  const m: Record<string, string> = { adAccount: a.id, account: a.name };
  if (a.currency) m.currency = a.currency.slice(0, 3);
  if (accounts.length > 1) m.adAccounts = JSON.stringify(accounts.slice(0, 50).map((x) => ({ id: x.id, name: x.name, currency: x.currency })));
  return m;
}

/** Switch the account read from. The id must be one the platform listed at connect time, never a free value. */
export function selectAdAccount(conn: Connection, id: string): Connection | null {
  let list: AdAccount[] = [];
  try { list = JSON.parse(conn.meta?.adAccounts ?? "[]") as AdAccount[]; } catch { return null; }
  const m = accountMeta(list, id);
  if (!m) return null;
  const meta = { ...conn.meta };
  delete meta.currency;
  return { ...conn, meta: { ...meta, ...m } };
}

/** Direct-OAuth records only; a Composio record is read by adRowsVia (perf-store.ts picks). */
export const adRows = (c: Connection, now?: Date, opts?: ReadOpts) => (c.provider === "meta_ads" ? metaRows(c, now, opts) : snapRows(c, now, opts));
