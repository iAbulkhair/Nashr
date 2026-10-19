import type { Connection } from "./store";
import { providerTimeout } from "../fetch-timeout";
import { writeFile } from "../files";
import { safeFetch } from "../safe-fetch";
import { STORE_REPLY_BYTES, responseJson } from "../read-capped";

/** Key-based connectors that need no partner registration: Odoo, PrestaShop, Telegram, Brevo. */

// ---------- Odoo (JSON-RPC, per-customer API key) ----------
async function odooCall(c: Record<string, string>, model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const url = c.url.replace(/\/+$/, "") + "/jsonrpc";
  const auth = await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { service: "common", method: "authenticate", args: [c.db, c.username, c.apiKey, {}] } }) });
  const aj = (await responseJson(auth, STORE_REPLY_BYTES)) as { result?: number; error?: { message: string } };
  if (!aj.result) throw new Error(aj.error?.message ?? "odoo auth failed");
  const r = await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 2, params: { service: "object", method: "execute_kw", args: [c.db, aj.result, c.apiKey, model, method, args, kwargs] } }) });
  const j = (await responseJson(r, STORE_REPLY_BYTES)) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
export async function verifyOdoo(d: Record<string, string>) {
  try { await odooCall(d, "res.users", "search_count", [[]]); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "failed" }; }
}
export async function importOdoo(email: string, c: Connection) {
  const rows = (await odooCall(c.data, "product.template", "search_read", [[["sale_ok", "=", true]]], { fields: ["name", "list_price", "description_sale", "website_url"], limit: 60 })) as { name: string; list_price: number; description_sale?: string | false; website_url?: string | false }[];
  const md = [`# Product catalog (Odoo, ${new Date().toISOString().slice(0, 10)})`, "", ...rows.map((p) => `- **${p.name}** — ${p.list_price}${p.description_sale ? `\n  ${String(p.description_sale).slice(0, 200)}` : ""}${p.website_url ? `\n  ${c.data.url.replace(/\/+$/, "")}${p.website_url}` : ""}`)].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return rows.length;
}

// ---------- PrestaShop (Webservice key) ----------
function psAuth(d: Record<string, string>) { return "Basic " + Buffer.from(`${d.apiKey}:`).toString("base64"); }
export async function verifyPrestaShop(d: Record<string, string>) {
  try {
    const r = await safeFetch(`${d.site.replace(/\/+$/, "")}/api/products?limit=1&output_format=JSON`, { headers: { Authorization: psAuth(d) } });
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status} (enable Webservice + key with products GET permission)` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}
export async function importPrestaShop(email: string, c: Connection) {
  const base = c.data.site.replace(/\/+$/, "");
  const r = await safeFetch(`${base}/api/products?display=[id,name,price,link_rewrite,description_short]&limit=60&output_format=JSON`, { headers: { Authorization: psAuth(c.data) } });
  if (!r.ok) throw new Error(`prestashop ${r.status}`);
  const j = (await responseJson(r, STORE_REPLY_BYTES)) as { products?: { id: number; name: string | { value: string }[]; price: string; link_rewrite: string | { value: string }[]; description_short?: string | { value: string }[] }[] };
  const txt = (v: unknown) => (Array.isArray(v) ? String((v[0] as { value: string })?.value ?? "") : String(v ?? ""));
  const rows = j.products ?? [];
  const md = [`# Product catalog (PrestaShop, ${new Date().toISOString().slice(0, 10)})`, "", ...rows.map((p) => `- **${txt(p.name)}** — ${p.price}\n  ${txt(p.description_short).replace(/<[^>]+>/g, "").slice(0, 200)}\n  ${base}/${txt(p.link_rewrite)}`)].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return rows.length;
}

// ---------- Telegram (bot token + channel) ----------
export async function verifyTelegram(d: Record<string, string>) {
  try {
  const r = await fetch(`https://api.telegram.org/bot${d.botToken}/getChat?chat_id=${encodeURIComponent(d.chatId)}`, { signal: providerTimeout() });
  const j = (await r.json()) as { ok: boolean; result?: { title?: string; username?: string }; description?: string };
  return j.ok ? { ok: true, name: j.result?.title ?? j.result?.username } : { ok: false, error: j.description ?? "bot cannot see this chat (add the bot as channel admin)" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}
export async function postTelegram(c: Connection, text: string): Promise<{ id: string; url: string }> {
  // Bounded inside the publish route's 60 s: a timeout is reported as "result unknown" (publish-once.ts), never a kill.
  const r = await fetch(`https://api.telegram.org/bot${c.data.botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: c.data.chatId, text: text.slice(0, 4000) }), signal: AbortSignal.timeout(45_000) });
  // The status goes into the error so a publish can tell a refusal (4xx: the post was not made) from a server error or
  // an unreadable answer (it may have been), src/lib/publish-once.ts.
  const j = (await r.json().catch(() => null)) as { ok: boolean; error_code?: number; result?: { message_id: number; chat: { username?: string; id: number } }; description?: string } | null;
  if (!j) throw new Error(`telegram ${r.status}: unreadable answer`);
  if (!j.ok || !j.result) throw new Error(`telegram ${j.error_code ?? r.status}: ${j.description ?? "failed"}`);
  const u = j.result.chat.username;
  return { id: String(j.result.message_id), url: u ? `https://t.me/${u}/${j.result.message_id}` : `https://t.me/c/${String(j.result.chat.id).replace(/^-100/, "")}/${j.result.message_id}` };
}

// ---------- email drafts: Brevo and Klaviyo (API key, fixed hosts) ----------
// Never a send: Brevo gets a campaign with no recipients and no schedule, Klaviyo a template in its library. The owner
// picks the list and sends from their own account. The HTML is the body through render() (src/lib/md.ts).
const EMAIL_TIMEOUT_MS = 20_000;

async function jsonOf(r: Response): Promise<Record<string, unknown> | null> {
  return (await r.json().catch(() => null)) as Record<string, unknown> | null;
}

export async function draftBrevoCampaign(c: Connection, d: { name: string; subject: string; html: string }): Promise<{ id: string; url: string }> {
  const headers = { "api-key": c.data.apiKey, "Content-Type": "application/json", accept: "application/json" };
  const s = await fetch("https://api.brevo.com/v3/senders", { headers, signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS) });
  // A failed read means nothing was created: a refusal (4xx), whatever Brevo answered.
  if (!s.ok) throw new Error(`brevo ${s.status >= 500 ? 400 : s.status}: senders`);
  const senders = ((await jsonOf(s))?.senders ?? []) as { id?: number; active?: boolean }[];
  const sender = senders.find((x) => x.active !== false && typeof x.id === "number");
  if (!sender) throw new Error("brevo_no_sender");
  const r = await fetch("https://api.brevo.com/v3/emailCampaigns", {
    method: "POST", headers, signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    body: JSON.stringify({ name: d.name.slice(0, 120), subject: d.subject.slice(0, 150), sender: { id: sender.id }, htmlContent: d.html }),
  });
  const j = await jsonOf(r);
  if (!r.ok || typeof j?.id !== "number") throw new Error(`brevo ${r.ok ? 502 : r.status}: ${String(j?.message ?? "failed").slice(0, 120)}`);
  return { id: String(j.id), url: "https://app.brevo.com/marketing-campaign/list" };
}

export async function draftKlaviyoTemplate(c: Connection, d: { name: string; html: string }): Promise<{ id: string; url: string }> {
  const r = await fetch("https://a.klaviyo.com/api/templates", {
    method: "POST",
    headers: { Authorization: `Klaviyo-API-Key ${c.data.apiKey}`, revision: "2024-10-15", "Content-Type": "application/vnd.api+json", accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    body: JSON.stringify({ data: { type: "template", attributes: { name: d.name.slice(0, 120), editor_type: "CODE", html: d.html } } }),
  });
  const j = await jsonOf(r);
  const id = (j?.data as { id?: unknown } | undefined)?.id;
  if (!r.ok || typeof id !== "string") throw new Error(`klaviyo ${r.ok ? 502 : r.status}: template`);
  return { id, url: "https://www.klaviyo.com/email-templates" };
}

// ---------- Brevo (API key) ----------
export async function verifyBrevo(d: Record<string, string>) {
  try {
    const r = await fetch("https://api.brevo.com/v3/account", { headers: { "api-key": d.apiKey }, signal: providerTimeout() });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = (await r.json()) as { companyName?: string; email?: string };
    return { ok: true, name: j.companyName ?? j.email };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}
