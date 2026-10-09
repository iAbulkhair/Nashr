import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getProvider } from "@/lib/connectors/registry";
import { saveConnection } from "@/lib/connectors/store";
import { verifyWordPress } from "@/lib/connectors/wordpress";
import { verifyWoo } from "@/lib/connectors/woocommerce";
import { verifyBrevo, verifyOdoo, verifyPrestaShop, verifyTelegram } from "@/lib/connectors/keyed";
import { forbid } from "@/lib/roles";

/** POST key-based credentials → verify → store encrypted. Admin and owner only (src/lib/roles.ts "connectors"). */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "connectors");
  if (no) return no;
  const { provider } = await ctx.params;
  const p = getProvider(provider);
  // A calendar provider of Reem (`secretary`) is never a stored connection, whatever its kind (ruling R4).
  if (!p || p.secretary || p.kind !== "key") return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const data: Record<string, string> = {};
  for (const f of p.keyFields ?? []) {
    const v = (b[f.name] ?? "").toString().trim();
    if (!v) return NextResponse.json({ ok: false, error: `missing_${f.name}` }, { status: 400 });
    data[f.name] = f.type === "url" ? (v.startsWith("http") ? v : "https://" + v) : v;
  }
  const meta: Record<string, string> = {};
  if (provider === "wordpress") {
    const v = await verifyWordPress(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.site;
    meta.account = v.name ?? data.username;
  } else if (provider === "woocommerce") {
    const v = await verifyWoo(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.site;
  } else if (provider === "odoo") {
    const v = await verifyOdoo(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.url;
  } else if (provider === "prestashop") {
    const v = await verifyPrestaShop(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.site;
  } else if (provider === "telegram") {
    const v = await verifyTelegram(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.account = v.name ?? data.chatId;
  } else if (provider === "brevo") {
    const v = await verifyBrevo(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.account = v.name ?? "";
  } else if (provider === "klaviyo") {
    const r = await fetch("https://a.klaviyo.com/api/accounts/", { headers: { Authorization: `Klaviyo-API-Key ${data.apiKey}`, revision: "2024-10-15" } });
    if (!r.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: `HTTP ${r.status}` }, { status: 400 });
  }
  await saveConnection(sc(u), { provider, data, meta, connectedAt: new Date().toISOString() });
  await track(u.email, "connect");
  return NextResponse.json({ ok: true, meta });
}
