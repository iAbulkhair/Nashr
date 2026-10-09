import { READS_METRICS } from "./connectors/working";
import type { StoredSocial } from "./social-stats";

/**
 * What the Reports page can say about platform numbers, from the connected providers alone. A source counts as read
 * only when one of its connected providers is in READS_METRICS: a stored connection with no reader behind it reads
 * nothing, so it must not silence the banner or unlock a metric. No other imports but a type, so the client panel can use it.
 */
export type SourceKey = "analytics" | "ads" | "store" | "social";
export const SOURCES: { key: SourceKey; provs: string[] }[] = [
  { key: "analytics", provs: ["google"] },
  // Ad accounts only: "snapchat" is Snapchat Ads, "linkedin_ads" LinkedIn Ads (the company page is "linkedin", social),
  // and "google" is the site connection (analytics), never an ad account.
  { key: "ads", provs: ["meta_ads", "snapchat", "tiktok_ads", "google_ads", "linkedin_ads"] },
  { key: "store", provs: ["shopify", "salla", "zid", "woocommerce"] },
  // "meta" is the Facebook and Instagram connection; through Composio it reads the Instagram account and the Facebook
  // Page, "linkedin" the chosen company page, "youtube" the channel and "tiktok" the account. "x" is read directly.
  { key: "social", provs: ["meta", "instagram", "tiktok", "x", "linkedin", "youtube"] },
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

type Conn = { provider: string; meta?: Record<string, string>; needsReconnect?: string };

/** Providers whose figures are read only through Composio (site-stats.ts, social-stats.ts). */
export const READ_VIA_COMPOSIO = ["google", "meta", "linkedin", "youtube", "tiktok"];

/**
 * A YouTube channel id as the connect stores it (social-read/youtube.ts `CHANNEL_ID`, UC and 10 to 40 more characters),
 * kept here so this file stays client-safe.
 */
const YT_CHANNEL = /^UC[\w-]{10,40}$/;

/**
 * The connected providers that can be read, for reportSources. A Google, Meta, LinkedIn, YouTube or TikTok record counts
 * only through Composio, and only once its part exists: Meta needs an Instagram account or a Facebook Page (`igId` or
 * `pageId`), LinkedIn a chosen company page (`liOrg`) and YouTube the channel chosen at connect (a `UC` `channelId`, the
 * reader's own test). X is read only on its direct record, on a member's paid click (rule 744, docs/system/flows.md
 * section 50 steps 17 and 19). Anything less would silence the social warning with nothing behind it. `socialRead` keeps
 * the followers tile shut until a snapshot part was read.
 */
export function connectedSources(conns: readonly Conn[]): string[] {
  return conns
    .filter((c) => {
      if (c.provider === "x") return c.meta?.via !== "composio";
      if (!READ_VIA_COMPOSIO.includes(c.provider)) return true;
      if (c.meta?.via !== "composio") return false;
      if (c.provider === "meta") return !!(c.meta.igId || c.meta.pageId);
      if (c.provider === "linkedin") return !!c.meta.liOrg;
      if (c.provider === "youtube") return YT_CHANNEL.test(c.meta.channelId ?? "");
      return true;
    })
    .map((c) => c.provider);
}

/**
 * Followers unlock only once some platform part was actually read, not when a record merely exists. A snapshot from
 * before v2 reads as not read yet (rule 737).
 */
export const socialRead = (s: StoredSocial | null | undefined) => s?.v === 2 && Object.values(s.parts ?? {}).some(Boolean);

/**
 * A LinkedIn connection through Composio with no company page chosen reads nothing, so the social card asks for a page.
 * A direct LinkedIn record has no reader at all.
 */
export const liNeedsPage = (conns: readonly Conn[]) =>
  conns.some((c) => c.provider === "linkedin" && c.meta?.via === "composio" && !c.meta?.liOrg);

/**
 * The social providers, in the order of `SOCIAL_PROVIDERS` in social-stats.ts (tests/composio-social.test.ts checks it),
 * kept here so this file stays client-safe.
 */
export const SOCIAL_PATHS = ["meta", "linkedin", "youtube", "tiktok"] as const;

/**
 * The provider path the Reports card's Refresh posts `sync_social` to (rule 735): the first social provider a reader
 * reads (`connectedSources`) whose record does not wait for a reconnect. The route reads every part the workspace holds
 * whatever the path, so any one will do. Null when there is none: the card then shows no Refresh, since the read would
 * find nothing to read.
 */
export function socialRefreshPath(conns: readonly Conn[]): string | null {
  const read = connectedSources(conns);
  return SOCIAL_PATHS.find((p) => read.includes(p) && !conns.find((c) => c.provider === p)?.needsReconnect) ?? null;
}

/** A direct X record that does not wait for a reconnect: the only X record `sync_x` reads (rule 744). */
export const xDirect = (conns: readonly Conn[]) => conns.some((c) => c.provider === "x" && c.meta?.via !== "composio" && !c.needsReconnect);

export type SiteChoices = { ga: { id: string; name: string }[]; gsc: string[]; gaCurrent?: string; gscCurrent?: string };

/** A stored JSON list, or [] when it is missing or malformed. */
function list(s: string | undefined): unknown[] {
  try {
    const v: unknown = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * The GA4 properties and Search Console sites listed at connect on the Composio Google record, for the site card's
 * selectors (rule 734), with the ones chosen; null without such a record. A malformed list reads as empty, an entry
 * without a string id is dropped, and a name is cut to 80 characters (the page renders it as text). At most 50 of each.
 */
export function siteChoices(conns: readonly Conn[]): SiteChoices | null {
  const meta = conns.find((c) => c.provider === "google" && c.meta?.via === "composio")?.meta;
  if (!meta) return null;
  const ga = list(meta.gaProperties).flatMap((p) => {
    const o = (p && typeof p === "object" ? p : {}) as { id?: unknown; name?: unknown };
    if (typeof o.id !== "string" || !o.id) return [];
    return [{ id: o.id, name: (typeof o.name === "string" && o.name ? o.name : o.id).slice(0, 80) }];
  });
  const gsc = list(meta.gscSites).filter((s): s is string => typeof s === "string" && !!s);
  const out: SiteChoices = { ga: ga.slice(0, 50), gsc: gsc.slice(0, 50) };
  if (meta.gaProperty) out.gaCurrent = meta.gaProperty;
  if (meta.gscSite) out.gscCurrent = meta.gscSite;
  return out;
}
