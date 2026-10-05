import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { currentUser, sc, sessionCookie } from "@/lib/auth";
import { getProvider, isAvailable, routedViaComposio } from "@/lib/connectors/registry";
import { composioConnect } from "@/lib/connectors/composio";
import { PROVIDER_TOOLKITS } from "@/lib/connectors/composio-catalog";
import { authorizeUrl, pkcePair } from "@/lib/connectors/oauth";
import { OAUTH_COOKIE, saveState } from "@/lib/connectors/store";
import { SHOP_HOST } from "@/lib/connectors/shopify";
import { forbid } from "@/lib/roles";

/**
 * GET /api/connect/{provider}/start?shop=xxx.myshopify.com&lang=ar → redirect to provider.
 * Admin and owner only (src/lib/roles.ts "connectors"): a connection is what the workspace publishes through.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "connectors");
  if (no) return no;
  const { provider } = await ctx.params;
  const p = getProvider(provider);
  if (!p || p.kind !== "oauth") return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  if (!isAvailable(p)) return NextResponse.json({ ok: false, error: "provider_not_configured" }, { status: 503 });
  const url = new URL(req.url);
  const lang = url.searchParams.get("lang") === "en" ? "en" : "ar";
  if (routedViaComposio(p.id)) {
    // Through Composio (src/lib/connectors/composio.ts): one toolkit per flow, only one this provider lists. The pending
    // account id is kept in the server-side state, so the callback never takes an account id from its query.
    const toolkits = PROVIDER_TOOLKITS[p.id] ?? [];
    const toolkit = toolkits.find((t) => t === url.searchParams.get("toolkit")) ?? toolkits[0];
    if (!toolkit) return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
    const state = randomBytes(16).toString("hex");
    try {
      const { accountId, redirectUrl } = await composioConnect(sc(u), toolkit, state);
      await saveState(state, { email: sc(u), provider, lang, shop: "", verifier: "", actor: u.actor?.email ?? u.email, via: "composio", toolkit, accountId });
      (await cookies()).set(OAUTH_COOKIE, state, { ...(await sessionCookie(600)), path: "/api/connect" });
      return NextResponse.redirect(redirectUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      console.error("composio connect start failed", provider, toolkit, /^[a-z_]+$/.test(msg) ? msg : "error");
      return NextResponse.json({ ok: false, error: /^composio_rate_limited$|^provider_not_configured$/.test(msg) ? msg : "connect_failed" }, { status: msg === "composio_rate_limited" ? 429 : 502 });
    }
  }
  let shop = (url.searchParams.get("shop") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (p.oauth!.needsShop) {
    if (!shop) return NextResponse.json({ ok: false, error: "shop_required" }, { status: 400 });
    if (p.id === "shopify" && !shop.endsWith(".myshopify.com")) shop = `${shop.replace(/\.myshopify\.com$/, "")}.myshopify.com`;
    // The shop becomes the host of the authorize redirect: only a real Shopify store domain may go there (#39).
    if (p.id === "shopify" && !SHOP_HOST.test(shop)) return NextResponse.json({ ok: false, error: "bad_shop" }, { status: 400 });
  }
  const state = randomBytes(16).toString("hex");
  const pk = p.oauth!.pkce ? pkcePair() : null;
  // `actor` is the login that started the flow: the callback must be finished by the same person, not merely the same account.
  await saveState(state, { email: sc(u), provider, lang, shop, verifier: pk?.verifier ?? "", actor: u.actor?.email ?? u.email });
  // The callback completes only in the browser that started the flow: a leaked state alone cannot attach someone
  // else's platform account to this workspace (#37). Lax, so the provider's top-level redirect back still carries it.
  (await cookies()).set(OAUTH_COOKIE, state, { ...(await sessionCookie(600)), path: "/api/connect" });
  return NextResponse.redirect(authorizeUrl(p, state, { shop, challenge: pk?.challenge }));
}
