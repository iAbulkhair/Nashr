import { db } from "./db";
import { adCodeIndex } from "./brand";
import { deleteFile, writeFile } from "./files";
import { analyze, learningsMarkdown, type PerfSnapshot } from "./perf-import";
import { AD_PROVIDERS, adRows, type AdProvider } from "./connectors/ads";
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
 * upload. The newest results, from a file or an account, are the ones Noor reads.
 */
export async function syncAds(scope: string, provider: AdProvider, c: Connection, now = new Date()): Promise<PerfSnapshot> {
  const [pull, codes] = await Promise.all([adRows(c, now), adCodeIndex(scope)]);
  if (!pull.rows.length) throw new Error("no_ad_results");
  const snap: PerfSnapshot = { ...analyze(pull.rows, `${pull.account}${pull.currency ? ` (${pull.currency})` : ""}`, pull.platform, pull.range, undefined, now.toISOString(), codes), source: provider };
  await Promise.all([savePerf(scope, snap), db.set(`adsync:${scope}:${provider}`, now.toISOString())]);
  return snap;
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
