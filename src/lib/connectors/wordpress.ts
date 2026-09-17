import type { Connection } from "./store";

function auth(c: Connection) {
  return "Basic " + Buffer.from(`${c.data.username}:${c.data.appPassword.replace(/\s+/g, "")}`).toString("base64");
}
function base(c: Connection) {
  return c.data.site.replace(/\/+$/, "");
}

export async function verifyWordPress(data: Record<string, string>): Promise<{ ok: boolean; name?: string; error?: string }> {
  const c = { provider: "wordpress", data, connectedAt: "" } as Connection;
  try {
    const r = await fetch(`${base(c)}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: auth(c) } });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = (await r.json()) as { name?: string; capabilities?: Record<string, boolean> };
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

export async function publishWordPress(c: Connection, post: { title: string; body: string; status?: "draft" | "publish" }): Promise<{ url: string; id: number }> {
  const r = await fetch(`${base(c)}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { Authorization: auth(c), "Content-Type": "application/json" },
    body: JSON.stringify({ title: post.title, content: mdToHtml(post.body), status: post.status ?? "draft" }),
  });
  if (!r.ok) throw new Error(`wordpress ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { id: number; link: string };
  return { url: j.link, id: j.id };
}
