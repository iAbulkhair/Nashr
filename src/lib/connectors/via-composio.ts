import type { Connection } from "./store";
import { composioRead, composioRevoke, composioWrite } from "./composio";
import { PROVIDER_TOOLKITS, type Toolkit } from "./composio-catalog";
import { plain } from "./meta";
import { accountOf as account, isComposio, listOf, pick } from "./composio-shape";
import { accountMeta } from "./ads";
import { adAccountsVia } from "./ads-via-composio";

export { isComposio, pick };

/**
 * Publishing and connecting through Composio (docs/superpowers/specs/2026-10-05-meta-via-composio-design.md, generalised
 * to X, LinkedIn and TikTok in the plan's addendum). A Composio connection record is the usual `conn:{scope}:{provider}`
 * with `meta.via = "composio"` and, in its encrypted `data`, one Composio account id per toolkit (`data.facebook`,
 * `data.instagram`, `data.twitter`, `data.linkedin`, `data.tiktok`). No platform token is ever stored or seen here.
 *
 * Results are read with a tolerant search (`pick`) because Composio wraps the platform's answer differently per tool;
 * the measured run (plan Task 8) pins the exact shapes.
 */

/** Every Composio account id the record holds, for revoke on disconnect and on account deletion. */
export function composioAccountIds(c: Connection): string[] {
  if (!isComposio(c)) return [];
  const toolkits = PROVIDER_TOOLKITS[c.provider] ?? [];
  return toolkits.map((t) => c.data[t]).filter((v): v is string => typeof v === "string" && v.length > 0);
}

// ---------- publish ----------

export async function postToFacebookVia(scope: string, c: Connection, text: string, imageUrl?: string): Promise<{ url: string; id: string }> {
  const page = c.meta?.pageId;
  if (!page) throw new Error("meta_no_page");
  const acc = account(c, "facebook");
  const r = imageUrl
    ? await composioWrite(scope, "facebook", "FACEBOOK_CREATE_PHOTO_POST", { page_id: page, url: imageUrl, message: plain(text), published: true }, acc)
    : await composioWrite(scope, "facebook", "FACEBOOK_CREATE_POST", { page_id: page, message: plain(text), published: true }, acc);
  const id = pick(r, ["post_id", "id"]);
  if (!id) throw new Error("meta create_post 502: no id");
  return { id, url: `https://www.facebook.com/${id}` };
}

const IG_CAPTION = 2200;

export async function postToInstagramVia(scope: string, c: Connection, text: string, imageUrl: string): Promise<{ url: string; id: string }> {
  const ig = c.meta?.igId;
  if (!ig) throw new Error("meta_no_instagram");
  const acc = account(c, "instagram");
  // Instagram allows a fixed number of API posts a day. A failed read is not a reason to stop: it is only a courtesy check.
  const limit = await composioRead(scope, "instagram", "INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT", { ig_user_id: ig, fields: "quota_usage,config" }, acc).catch(() => null);
  const used = Number(pick(limit, ["quota_usage"]));
  const total = Number(pick(limit, ["quota_total"]));
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= total) throw new Error("instagram_limit_reached");
  // A container is not a post: any failure here (a timeout included) means nothing went out, so it is a refusal unless
  // the platform refused the token, which must still ask the owner to reconnect.
  let container: string | undefined;
  try {
    container = pick(await composioWrite(scope, "instagram", "INSTAGRAM_POST_IG_USER_MEDIA", { ig_user_id: ig, image_url: imageUrl, caption: plain(text).slice(0, IG_CAPTION) }, acc), ["id", "creation_id"]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/^meta [\w-]+ 401\b/.test(msg)) throw e;
    throw new Error(/image|aspect|ratio|format|media|download|fetch/i.test(msg) ? "meta media 400: image_rejected" : "meta media 400: container_failed");
  }
  if (!container) throw new Error("meta media 400: container_failed");
  const done = await composioWrite(scope, "instagram", "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", { ig_user_id: ig, creation_id: container, max_wait_seconds: 20 }, acc);
  const id = pick(done, ["id", "media_id"]);
  if (!id) throw new Error("meta media_publish 502: no id");
  return { id, url: pick(done, ["permalink"]) ?? "https://www.instagram.com/" };
}

export async function postToXVia(scope: string, c: Connection, text: string): Promise<{ url: string; id: string }> {
  let r: unknown;
  try {
    r = await composioWrite(scope, "twitter", "TWITTER_CREATION_OF_A_POST", { text: text.slice(0, 280) }, account(c, "twitter"));
  } catch (e) {
    // A repeated post is a refusal of this text, not of the token (x.ts).
    if (e instanceof Error && /duplicate/i.test(e.message)) throw new Error("x_duplicate");
    throw e;
  }
  const id = pick(r, ["id", "id_str"]);
  if (!id) throw new Error("x 502: no id");
  return { id, url: `https://x.com/i/status/${id}` };
}

const LI_TEXT = 3000;
/** LinkedIn's commentary is "little text": these characters are markup unless escaped. */
export const liEscape = (s: string) => s.replace(/[\\|{}@[\]()<>#*_~]/g, (ch) => `\\${ch}`);

export async function postToLinkedInVia(scope: string, c: Connection, text: string): Promise<{ url: string; id: string }> {
  const author = c.meta?.author;
  if (!author) throw new Error("linkedin_no_author");
  const r = await composioWrite(scope, "linkedin", "LINKEDIN_CREATE_LINKED_IN_POST", { author, commentary: liEscape(plain(text).slice(0, LI_TEXT)), visibility: "PUBLIC", lifecycleState: "PUBLISHED" }, account(c, "linkedin"));
  const id = pick(r, ["id", "x-restli-id", "urn", "post_urn"]);
  if (!id) throw new Error("linkedin 502: no id");
  return { id, url: `https://www.linkedin.com/feed/update/${id}/` };
}

/**
 * TikTok gets the image in the owner's TikTok inbox as a draft (MEDIA_UPLOAD), never a direct post: a direct post needs
 * TikTok's own audit of the app, and the owner finishes the post (sound, privacy) in the TikTok app.
 */
export async function postToTikTokVia(scope: string, c: Connection, text: string, imageUrl: string): Promise<{ url: string; id: string }> {
  const body = plain(text);
  const r = await composioWrite(scope, "tiktok", "TIKTOK_POST_PHOTO", { photo_images: [imageUrl], photo_cover_index: 0, post_mode: "MEDIA_UPLOAD", title: body.split("\n")[0].slice(0, 90), description: body.slice(0, 4000) }, account(c, "tiktok"));
  const id = pick(r, ["publish_id", "id"]);
  if (!id) throw new Error("tiktok 502: no id");
  return { id, url: "https://www.tiktok.com/" };
}

// ---------- connect ----------

type Page = { id: string; name: string };

/** Facebook: the Pages the account manages, names only. `fields` is fixed so no Page token is ever returned. */
async function managedPages(scope: string, acc: string): Promise<Page[]> {
  const r = await composioRead(scope, "facebook", "FACEBOOK_LIST_MANAGED_PAGES", { fields: "id,name", limit: 50 }, acc);
  return listOf(r).map((p) => ({ id: String(p.id), name: typeof p.name === "string" ? p.name : String(p.id) })).filter((p) => /^\d+$/.test(p.id));
}

/** GA4: the properties the login can read, `properties/{digits}` only. */
async function gaProperties(scope: string, acc: string): Promise<Page[]> {
  const r = await composioRead(scope, "google_analytics", "GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES", { pageSize: 50 }, acc);
  return listOf(r, "propertySummaries").flatMap((a) => (Array.isArray(a.propertySummaries) ? a.propertySummaries : []) as Record<string, unknown>[])
    .map((p) => ({ id: String(p.property ?? ""), name: typeof p.displayName === "string" ? p.displayName.slice(0, 80) : String(p.property ?? "") }))
    .filter((p) => /^properties\/\d+$/.test(p.id));
}

/** Search Console: the sites the login has verified access to; an unverified listing has no data to read. */
async function gscSites(scope: string, acc: string): Promise<string[]> {
  const r = await composioRead(scope, "google_search_console", "GOOGLE_SEARCH_CONSOLE_LIST_SITES", {}, acc);
  return listOf(r, "siteUrl").filter((x) => x.permissionLevel !== "siteUnverifiedUser").map((x) => String(x.siteUrl))
    .filter((u) => /^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+)$/i.test(u) && u.length <= 200);
}

const metaLabel = (pageName?: string, ig?: string) => [pageName, ig ? `@${ig}` : ""].filter(Boolean).join(" · ") || "Meta";

/**
 * The record after one toolkit was connected and verified (composioVerify). Starts a new Composio record, or adds the
 * toolkit to the existing one; a direct-OAuth record of the same provider is replaced. The account id comes from the
 * saved OAuth state, never from the callback's query.
 */
export async function connectViaComposio(scope: string, provider: string, toolkit: Toolkit, accountId: string, existing: Connection | null): Promise<Connection> {
  const base: Connection = existing && isComposio(existing)
    ? { ...existing, data: { ...existing.data }, meta: { ...existing.meta }, needsReconnect: undefined }
    : { provider, data: {}, meta: { via: "composio" }, connectedAt: new Date().toISOString() };
  const before = base.data[toolkit];
  base.data[toolkit] = accountId;
  const meta = base.meta!;
  if (toolkit === "facebook") {
    const pages = await managedPages(scope, accountId);
    if (!pages.length) throw new Error("meta_no_page");
    meta.pageId = pages[0].id;
    meta.pageName = pages[0].name;
    if (pages.length > 1) meta.pages = JSON.stringify(pages.map((p) => ({ id: p.id, name: p.name, ig: "" })));
    else delete meta.pages;
  }
  if (toolkit === "instagram") {
    const me = await composioRead(scope, "instagram", "INSTAGRAM_GET_USER_INFO", { fields: "id,username" }, accountId);
    const id = pick(me, ["id", "ig_user_id"]);
    if (!id) throw new Error("meta_no_instagram");
    meta.igId = id;
    const user = pick(me, ["username"]);
    if (user) meta.ig = user;
  }
  if (provider === "meta") meta.account = metaLabel(meta.pageName, meta.ig);
  if (toolkit === "twitter") {
    const user = pick(await composioRead(scope, "twitter", "TWITTER_USER_LOOKUP_ME", {}, accountId), ["username"]);
    meta.account = user ? `@${user}` : "X";
  }
  if (toolkit === "linkedin") {
    const me = await composioRead(scope, "linkedin", "LINKEDIN_GET_MY_INFO", {}, accountId);
    const urn = pick(me, ["author_id", "urn", "person_urn"]);
    const sub = pick(me, ["sub", "id"]);
    const author = urn?.startsWith("urn:li:") ? urn : sub ? `urn:li:person:${sub}` : undefined;
    if (!author) throw new Error("linkedin_no_author");
    meta.author = author;
    meta.account = pick(me, ["name", "localizedFirstName"]) ?? "LinkedIn";
  }
  if (toolkit === "tiktok") meta.account = "TikTok";
  if (toolkit === "metaads" || toolkit === "snapchat" || toolkit === "googleads" || toolkit === "tiktok_ads") {
    // Read only: the ad accounts this login can read, the first chosen until the owner picks another (select_ad_account).
    const accounts = await adAccountsVia(scope, provider, accountId);
    if (!accounts.length) throw new Error("no_ad_account");
    delete meta.adAccounts;
    delete meta.currency;
    Object.assign(meta, accountMeta(accounts, accounts[0].id));
  }
  if (toolkit === "google_analytics") {
    const props = await gaProperties(scope, accountId);
    if (!props.length) throw new Error("no_ga_property");
    meta.gaProperty = props[0].id;
    meta.gaName = props[0].name;
    if (props.length > 1) meta.gaProperties = JSON.stringify(props.slice(0, 50));
    else delete meta.gaProperties;
  }
  if (toolkit === "google_search_console") {
    const sites = await gscSites(scope, accountId);
    if (!sites.length) throw new Error("no_gsc_site");
    meta.gscSite = sites[0];
    if (sites.length > 1) meta.gscSites = JSON.stringify(sites.slice(0, 50));
    else delete meta.gscSites;
  }
  if (provider === "google") meta.account = [meta.gaName, meta.gscSite?.replace(/^sc-domain:|^https?:\/\/|\/$/g, "")].filter(Boolean).join(" · ") || "Google";
  // A reconnected toolkit leaves its old Composio account behind; it is revoked, quietly, after the new one is in hand.
  if (before && before !== accountId) await composioRevoke(scope, before).catch(() => console.error("composio revoke of replaced account failed"));
  return { ...base, meta, expiresAt: undefined };
}

/** Switch the Facebook Page a Composio Meta record posts to. The id must be one Composio listed at connect time. */
export function selectPageVia(c: Connection, pageId: string): Connection | null {
  let pages: Page[] = [];
  try { pages = JSON.parse(c.meta?.pages ?? "[]") as Page[]; } catch { return null; }
  const p = pages.find((x) => x.id === pageId);
  if (!p) return null;
  const meta: Record<string, string> = { ...c.meta, pageId: p.id, pageName: p.name };
  meta.account = metaLabel(p.name, meta.ig);
  return { ...c, meta };
}

/**
 * Revoke every Composio account of a record. Resolves with the ids that could not be revoked; an account Composio no
 * longer knows counts as revoked.
 */
export async function revokeAll(scope: string, c: Connection): Promise<string[]> {
  const ids = composioAccountIds(c);
  const results = await Promise.allSettled(ids.map((id) => composioRevoke(scope, id)));
  return ids.filter((_, i) => {
    const r = results[i];
    return r.status === "rejected" && !/not.?found|\b404\b/i.test(r.reason instanceof Error ? r.reason.message : String(r.reason));
  });
}
