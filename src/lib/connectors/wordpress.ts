import type { Connection } from "./store";
import { safeFetch } from "../safe-fetch";
import { STORE_REPLY_BYTES, responseBytes, responseJson, responseText } from "../read-capped";

function auth(c: Connection) {
  return "Basic " + Buffer.from(`${c.data.username}:${c.data.appPassword.replace(/\s+/g, "")}`).toString("base64");
}
function base(c: Connection) {
  return c.data.site.replace(/\/+$/, "");
}

export async function verifyWordPress(data: Record<string, string>): Promise<{ ok: boolean; name?: string; error?: string }> {
  const c = { provider: "wordpress", data, connectedAt: "" } as Connection;
  try {
    const r = await safeFetch(`${base(c)}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: auth(c) } });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = (await responseJson(r, STORE_REPLY_BYTES)) as { name?: string; capabilities?: Record<string, boolean> };
    if (j.capabilities && !j.capabilities.publish_posts && !j.capabilities.edit_posts) return { ok: false, error: "user cannot publish posts" };
    return { ok: true, name: j.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}

/** Markdown-ish → HTML good enough for WP (headings, bold, lists, paragraphs). */
export function mdToHtml(md: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const lines = md.split("\n");
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push("<ul>" + list.map((l) => `<li>${l}</li>`).join("") + "</ul>"); list = []; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
    if (/^#{1,6}\s/.test(l)) { flush(); const n = l.match(/^#+/)![0].length; out.push(`<h${Math.min(n + 1, 4)}>${inline(l.replace(/^#+\s*/, ""))}</h${Math.min(n + 1, 4)}>`); }
    else if (/^\s*[-*]\s+/.test(l)) list.push(inline(l.replace(/^\s*[-*]\s+/, "")));
    else if (!l.trim()) flush();
    else { flush(); out.push(`<p>${inline(l)}</p>`); }
  }
  flush();
  return out.join("\n");
}

/** Image types WordPress accepts as media and Thakeen's image models produce. Anything else is not uploaded. */
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Copy the item's artwork into the site's media library and answer the media id, or null when it could not be done: the
 * draft is then made without a featured image (the caller says so). The image URL is the item's own and still goes
 * through safeFetch, https only; only a known image type under 8 MB is sent on. Needs the `upload_files` capability.
 */
async function uploadFeaturedImage(c: Connection, imageUrl: string): Promise<number | null> {
  try {
    const img = await safeFetch(imageUrl, { signal: AbortSignal.timeout(15_000) }, { httpsOnly: true });
    const type = (img.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!img.ok || !ext) return null;
    const bytes = await responseBytes(img, MAX_IMAGE_BYTES);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const r = await safeFetch(`${base(c)}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: { Authorization: auth(c), "Content-Type": type, "Content-Disposition": `attachment; filename="thakeen-${Date.now()}.${ext}"` },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j = (await responseJson(r, STORE_REPLY_BYTES).catch(() => null)) as { id?: unknown } | null;
    return typeof j?.id === "number" ? j.id : null;
  } catch {
    return null;
  }
}

/** Whether the connected user may publish (not only draft). Unknown when the site does not report capabilities. */
async function canPublishLive(c: Connection): Promise<boolean> {
  try {
    const r = await safeFetch(`${base(c)}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: auth(c) } });
    if (!r.ok) return true; // the publish itself will say what the site refuses
    const j = (await responseJson(r, STORE_REPLY_BYTES)) as { capabilities?: Record<string, boolean> };
    return j.capabilities ? !!j.capabilities.publish_posts : true;
  } catch {
    return true;
  }
}

export type WordPressPost = {
  title: string;
  body: string;
  /** "draft" unless the owner confirmed this one item for the live site. */
  status?: "draft" | "publish";
  /** The item's artwork, uploaded as the featured image on a new post. */
  imageUrl?: string;
  /** The post this item went to before: update it in place instead of making a second one. */
  updateId?: string;
};

export type WordPressResult = { url: string; id: number; status: "draft" | "published"; notes?: string[] };

/**
 * A new post, or the earlier post updated in place. A new post is a draft unless `status` says "publish". An update
 * never sends a status unless the owner asked to go live: whatever the owner did in WordPress since (published it, left
 * it a draft) stays. An update does not touch the featured image: the first send put it there. When the earlier post
 * is gone (404, nothing was changed) a new draft is made instead.
 */
export async function publishWordPress(c: Connection, post: WordPressPost): Promise<WordPressResult> {
  const live = post.status === "publish";
  if (live && !(await canPublishLive(c))) throw new Error("wordpress_cannot_publish_live");
  const content = mdToHtml(post.body);
  const headers = { Authorization: auth(c), "Content-Type": "application/json" };
  const result = (j: { id: number; link: string; status?: string }, notes: string[]): WordPressResult => ({ url: j.link, id: j.id, status: j.status ? (j.status === "publish" ? "published" : "draft") : live ? "published" : "draft", ...(notes.length ? { notes } : {}) });

  if (post.updateId && /^\d{1,12}$/.test(post.updateId)) {
    const r = await safeFetch(`${base(c)}/wp-json/wp/v2/posts/${post.updateId}`, { method: "POST", headers, body: JSON.stringify({ title: post.title, content, ...(live ? { status: "publish" } : {}) }) });
    if (r.ok) return result((await responseJson(r, STORE_REPLY_BYTES)) as { id: number; link: string; status?: string }, []);
    if (r.status !== 404) throw new Error(`wordpress ${r.status}: ${(await responseText(r, STORE_REPLY_BYTES)).slice(0, 200)}`);
  }

  const notes: string[] = [];
  let media: number | null = null;
  if (post.imageUrl) {
    media = await uploadFeaturedImage(c, post.imageUrl);
    if (media == null) notes.push("image_failed");
  }
  const r = await safeFetch(`${base(c)}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: post.title, content, status: live ? "publish" : "draft", ...(media != null ? { featured_media: media } : {}) }),
  });
  if (!r.ok) throw new Error(`wordpress ${r.status}: ${(await responseText(r, STORE_REPLY_BYTES)).slice(0, 200)}`);
  return result((await responseJson(r, STORE_REPLY_BYTES)) as { id: number; link: string; status?: string }, notes);
}
