import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { currentUser } from "@/lib/auth";
import { getProvider, isAvailable } from "@/lib/connectors/registry";
import { authorizeUrl, pkcePair } from "@/lib/connectors/oauth";
import { saveState } from "@/lib/connectors/store";

/** GET /api/connect/{provider}/start?shop=xxx.myshopify.com&lang=ar → redirect to provider */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  const p = getProvider(provider);
  if (!p || p.kind !== "oauth") return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  if (!isAvailable(p)) return NextResponse.json({ ok: false, error: "provider_not_configured" }, { status: 503 });
  const url = new URL(req.url);
  const lang = url.searchParams.get("lang") === "en" ? "en" : "ar";
  let shop = (url.searchParams.get("shop") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (p.oauth!.needsShop) {
    if (!shop) return NextResponse.json({ ok: false, error: "shop_required" }, { status: 400 });
    if (p.id === "shopify" && !shop.endsWith(".myshopify.com")) shop = `${shop.replace(/\.myshopify\.com$/, "")}.myshopify.com`;
  }
  const state = randomBytes(16).toString("hex");
  const pk = p.oauth!.pkce ? pkcePair() : null;
  await saveState(state, { email: u.email, provider, lang, shop, verifier: pk?.verifier ?? "" });
  return NextResponse.redirect(authorizeUrl(p, state, { shop, challenge: pk?.challenge }));
}
