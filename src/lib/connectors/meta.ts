import type { Connection } from "./store";

/**
 * Facebook Pages and Instagram professional accounts through the Graph API. The host is fixed; nothing about a request
 * decides where a call goes. Flow, per Meta's documentation for Facebook Login and the Pages and Instagram content
 * publishing APIs:
 * 1. The OAuth code gives a short-lived user token; it is traded for a long-lived one (fb_exchange_token).
 * 2. GET /me/accounts lists the Pages the owner granted, each with its Page token and linked Instagram account. A Page
 *    token obtained from a long-lived user token does not expire, so the connection carries no expiry.
 * 3. A Facebook post is POST /{page}/feed (or /{page}/photos with an image). An Instagram post is a media container
 *    (POST /{ig}/media with image_url and caption), then POST /{ig}/media_publish once the container is ready.
 * Nothing here runs on a schedule: publishTask is reached only by the owner's click or an approved item in chat.
 */
export const GRAPH = "https://graph.facebook.com/v23.0";
const IG_CAPTION = 2200;

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number } };
export type MetaPage = { id: string; name: string; token: string; igId?: string; ig?: string };

/**
 * Graph answers a dead or revoked token with HTTP 400 and error code 190, and a missing permission with 10 or 200.
 * Those are reported as 401 and 403 so refusedToken asks the owner to reconnect, as it does for every other platform.
 */
async function graphError(r: Response, what: string): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as GraphError;
  const code = j.error?.code;
  const status = code === 190 ? 401 : code === 10 || code === 200 ? 403 : r.status;
  return new Error(`meta ${what} ${status}: ${(j.error?.message ?? "").slice(0, 160)}`);
}

async function graph<T>(path: string, token: string, init?: { body: Record<string, string> }): Promise<T> {
  const r = await fetch(`${GRAPH}${path}`, init
    ? { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(init.body) }
    : { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw await graphError(r, path.split("?")[0].split("/").pop() || "call");
  return (await r.json()) as T;
}

/** Short-lived user token → long-lived (about 60 days), with the app credentials in the POST body, never a URL. */
export async function longLivedToken(short: string): Promise<string> {
  const r = await fetch(`${GRAPH}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID ?? "", client_secret: process.env.META_APP_SECRET ?? "", fb_exchange_token: short }),
  });
  if (!r.ok) throw await graphError(r, "token");
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("meta token: no access_token");
  return j.access_token;
}

export async function listPages(userToken: string): Promise<MetaPage[]> {
  const j = await graph<{ data?: { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[] }>(
    "/me/accounts?fields=id,name,access_token,instagram_business_account%7Bid,username%7D&limit=50", userToken);
  return (j.data ?? []).filter((p) => p.id && p.access_token).map((p) => ({ id: p.id, name: p.name, token: p.access_token, igId: p.instagram_business_account?.id, ig: p.instagram_business_account?.username }));
}

/** What the connection stores for one chosen Page: the token in `data` (encrypted), the names in `meta`. */
export function pageChoice(pages: MetaPage[], pageId: string): { data: Record<string, string>; meta: Record<string, string> } | null {
  const p = pages.find((x) => x.id === pageId);
  if (!p) return null;
  const meta: Record<string, string> = { pageId: p.id, account: p.ig ? `${p.name} · @${p.ig}` : p.name };
  if (p.igId) meta.igId = p.igId;
  if (pages.length > 1) meta.pages = JSON.stringify(pages.map((x) => ({ id: x.id, name: x.name, ig: x.ig ?? "" })));
  return { data: { page_token: p.token }, meta };
}

/** After the code exchange: a long-lived token, the owner's Pages, and the first Page chosen until they pick another. */
export async function connectMeta(conn: Connection): Promise<Connection> {
  const user = await longLivedToken(conn.data.access_token);
  const pages = await listPages(user);
  if (!pages.length) throw new Error("meta_no_page");
  const first = pages.find((p) => p.igId) ?? pages[0];
  const choice = pageChoice(pages, first.id)!;
  return {
    ...conn,
    data: { access_token: user, pages: JSON.stringify(pages), ...choice.data },
    meta: { ...conn.meta, ...choice.meta },
    // Page tokens from a long-lived user token do not expire; a revoked one is caught by refusedToken on use.
    expiresAt: undefined,
  };
}

/** Switch the Page the connection publishes to. The id must be one of the Pages Meta returned, never a free value. */
export function selectPage(conn: Connection, pageId: string): Connection | null {
  let pages: MetaPage[] = [];
  try { pages = JSON.parse(conn.data.pages ?? "[]") as MetaPage[]; } catch { return null; }
  const choice = pageChoice(pages, pageId);
  if (!choice) return null;
  const meta = { ...conn.meta };
  delete meta.igId;
  return { ...conn, data: { ...conn.data, ...choice.data }, meta: { ...meta, ...choice.meta } };
}

const plain = (s: string) => s.replace(/^#{1,6}\s+/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();

export async function postToFacebook(c: Connection, text: string, imageUrl?: string): Promise<{ url: string; id: string }> {
  const page = c.meta?.pageId;
  if (!page || !c.data.page_token) throw new Error("meta_no_page");
  const j = imageUrl
    ? await graph<{ id: string; post_id?: string }>(`/${page}/photos`, c.data.page_token, { body: { url: imageUrl, caption: plain(text) } })
    : await graph<{ id: string }>(`/${page}/feed`, c.data.page_token, { body: { message: plain(text) } });
  const id = ("post_id" in j && typeof j.post_id === "string" ? j.post_id : undefined) ?? j.id;
  return { id, url: `https://www.facebook.com/${id}` };
}

export async function postToInstagram(c: Connection, text: string, imageUrl: string, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<{ url: string; id: string }> {
  const ig = c.meta?.igId;
  if (!ig || !c.data.page_token) throw new Error("meta_no_instagram");
  const token = c.data.page_token;
  const container = await graph<{ id: string }>(`/${ig}/media`, token, { body: { image_url: imageUrl, caption: plain(text).slice(0, IG_CAPTION) } });
  // Instagram fetches the image before the container can be published; an image usually takes a second or two.
  for (let i = 0; i < 8; i++) {
    const s = await graph<{ status_code?: string }>(`/${container.id}?fields=status_code`, token);
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`meta media ${s.status_code}`);
    if (i === 7) throw new Error("meta media not ready");
    await wait(1500);
  }
  const done = await graph<{ id: string }>(`/${ig}/media_publish`, token, { body: { creation_id: container.id } });
  const link = await graph<{ permalink?: string }>(`/${done.id}?fields=permalink`, token).catch(() => ({ permalink: undefined }));
  return { id: done.id, url: link.permalink ?? `https://www.instagram.com/` };
}
