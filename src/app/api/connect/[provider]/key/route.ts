import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getProvider } from "@/lib/connectors/registry";
import { saveConnection } from "@/lib/connectors/store";
import { verifyWordPress } from "@/lib/connectors/wordpress";
import { verifyWoo } from "@/lib/connectors/woocommerce";

/** POST key-based credentials → verify → store encrypted */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  const p = getProvider(provider);
  if (!p || p.kind !== "key") return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
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
  } else if (provider === "klaviyo") {
    const r = await fetch("https://a.klaviyo.com/api/accounts/", { headers: { Authorization: `Klaviyo-API-Key ${data.apiKey}`, revision: "2024-10-15" } });
    if (!r.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: `HTTP ${r.status}` }, { status: 400 });
  }
  await saveConnection(u.email, { provider, data, meta, connectedAt: new Date().toISOString() });
  return NextResponse.json({ ok: true, meta });
}
