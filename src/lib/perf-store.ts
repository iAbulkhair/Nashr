import { db } from "./db";
import { adCodeIndex } from "./brand";
import { deleteFile, writeFile } from "./files";
import { analyze, learningsMarkdown, type PerfSnapshot } from "./perf-import";
import { ADSTATS_KEY, adStatsFrom, totalsOf, type AdPrev } from "./ad-stats";
import { AD_PROVIDERS, adRows, prevNow, type AdProvider, type AdPull } from "./connectors/ads";
import { adRowsVia, snapPrevSpendVia } from "./connectors/ads-via-composio";
import { isComposio } from "./connectors/composio-shape";
import { getFreshConnection, refusedToken } from "./connectors/fresh";
import { getConnection, type Connection } from "./connectors/store";

export const LEARNINGS_FILE = "performance-learnings.md";
const KEY = (scope: string) => `perfimport:${scope}`;

/** The latest campaign import for this workspace, or null. One at a time: a new upload replaces the last. */
export async function getPerf(scope: string) {
  return db.get<PerfSnapshot>(KEY(scope));
}

/** Keep the findings and hand Noor the same findings as performance-learnings.md, which her memory reads. */
export async function savePerf(scope: string, snap: PerfSnapshot) {
  await Promise.all([db.set(KEY(scope), snap), writeFile(scope, LEARNINGS_FILE, learningsMarkdown(snap), "noor")]);
}

export async function clearPerf(scope: string) {
  await Promise.all([db.del(KEY(scope)), deleteFile(scope, LEARNINGS_FILE)]);
}

/**
 * Read the last 30 days of ad results from a connected ad account and run them through the same analysis as an
 * upload. The newest results, from a file or an account, are the ones Noor reads. The account's own totals also go to
 * `adstats:{scope}:{provider}` (src/lib/ad-stats.ts, rule 731), built from the raw rows, so reading one platform never
 * erases another's figures from Dana's reports. Beside them, the 30 days before the window (`prevOf`, rule 733): only
 * for those totals, never for Noor's analysis; a failed previous read leaves no `prev` and never fails the sync (it is
 * logged by its code alone, `failCode`), while a failed current read throws as before.
 */
export async function syncAds(scope: string, provider: AdProvider, c: Connection, now = new Date()): Promise<PerfSnapshot> {
  const read = (at: Date, totalsOnly = false) => (isComposio(c) ? adRowsVia(scope, c, at) : adRows(c, at, { totalsOnly }));
  const [pull, prev, codes] = await Promise.all([
    read(now),
    prevOf(scope, c, read, now).catch((e) => {
      console.warn("ad_prev_failed", provider, failCode(e));
      return null;
    }),
    adCodeIndex(scope),
  ]);
  if (!pull.rows.length) throw new Error("no_ad_results");
  const snap: PerfSnapshot = { ...analyze(pull.rows, `${pull.account}${pull.currency ? ` (${pull.currency})` : ""}`, pull.platform, pull.range, undefined, now.toISOString(), codes), source: provider };
  await Promise.all([savePerf(scope, snap), db.set(`adsync:${scope}:${provider}`, now.toISOString()), db.set(ADSTATS_KEY(scope, provider), adStatsFrom(provider, pull, prev, now))]);
  return snap;
}

/**
 * The previous period for an ad read (rule 733): the same reader, with the same constant query and date checks, over
 * the 30 days before the window (`prevNow`), totals only (`totalsOnly`: no ad copy or names, which nothing here keeps).
 * Totals only from the rows that delivered, with impressions or spend above zero: Snapchat's direct per-ad breakdown
 * lists every ad of the account, with zeros for the ones that did not run, and a window of zeros is no previous period.
 * None is null, so a new account with nothing before never reads as "up 100%" or "up from 0". Snapchat through Composio
 * has no account-wide per-ad breakdown, so its account's spend is read in one call (`snapPrevSpendVia`) instead of a
 * second per-ad pass.
 */
async function prevOf(scope: string, c: Connection, read: (at: Date, totalsOnly?: boolean) => Promise<AdPull>, now: Date): Promise<AdPrev | null> {
  if (c.provider === "snapchat" && isComposio(c)) return snapPrevSpendVia(scope, c, now);
  return read(prevNow(now), true).then((p) => {
    const rows = p.rows.filter((r) => r.impressions || r.spend);
    return rows.length ? { range: p.range, ...totalsOf(rows) } : null;
  });
}

/**
 * A failed previous read's reason for the log: the error's first words where they are a code ("meta_ads insights 500",
 * "snapchat 502 get_ad_accounts_stats", "no_ad_account"), never the platform's own text, a token or a URL.
 */
export function failCode(e: unknown): string {
  const words = (e instanceof Error ? e.message : "").split(/\s+/, 3).map((w) => w.replace(/:$/, ""));
  return words.filter((w) => /^[a-z0-9_]{1,40}$/.test(w)).join(" ") || "error";
}

/** Daily: refresh from the first connected ad account whose last read is older than 20 hours. One platform a day. */
export async function syncAdsIfDue(scope: string): Promise<string | null> {
  const found = await Promise.all(AD_PROVIDERS.map(async (p) => ({ p, c: await getConnection(scope, p), last: await db.get<string>(`adsync:${scope}:${p}`) })));
  const due = found.filter((x) => x.c && !x.c.needsReconnect && (!x.last || Date.now() - Date.parse(x.last) > 20 * 36e5)).sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""))[0];
  if (!due) return null;
  try {
    const c = await getFreshConnection(scope, due.p);
    if (!c) return null;
    await syncAds(scope, due.p, c);
  } catch (e) {
    // A revoked token marks the connection for reconnecting, exactly as a click on Sync would.
    throw await refusedToken(scope, due.p, e);
  }
  return due.p;
}
