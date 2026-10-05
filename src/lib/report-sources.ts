import { READS_METRICS } from "./connectors/working";

/**
 * What the Reports page can say about platform numbers, from the connected providers alone. A source counts as read
 * only when one of its connected providers is in READS_METRICS: a stored connection with no reader behind it reads
 * nothing, so it must not silence the banner or unlock a metric. No other imports, so the client panel can use it.
 */
export type SourceKey = "analytics" | "ads" | "store" | "social";
export const SOURCES: { key: SourceKey; provs: string[] }[] = [
  { key: "analytics", provs: ["google"] },
  // Ad accounts only: "snapchat" is Snapchat Ads, and "google" is the site connection (analytics), never an ad account.
  { key: "ads", provs: ["meta_ads", "snapchat", "tiktok_ads", "google_ads"] },
  { key: "store", provs: ["shopify", "salla", "zid", "woocommerce"] },
  { key: "social", provs: ["instagram", "tiktok", "x", "linkedin"] },
];
export const PLATFORM_METRICS: { key: string; source: SourceKey }[] = [
  { key: "visitors", source: "analytics" }, { key: "sessions", source: "analytics" }, { key: "adSpend", source: "ads" }, { key: "roas", source: "ads" },
  { key: "orders", source: "store" }, { key: "revenue", source: "store" }, { key: "followers", source: "social" },
];

export function reportSources(connected: readonly string[]) {
  const readable = connected.filter((p) => READS_METRICS.includes(p));
  const read = SOURCES.filter((s) => s.provs.some((p) => readable.includes(p))).map((s) => s.key);
  const missing = SOURCES.filter((s) => !read.includes(s.key)).map((s) => s.key);
  /** "none": nothing is read, so every number on the page is the workspace's. "some": at least one source is read. */
  return { read, missing, banner: missing.length === 0 ? null : read.length === 0 ? ("none" as const) : ("some" as const) };
}
