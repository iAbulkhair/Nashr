import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/auth";
import { sameSecret } from "@/lib/rate";
import { getProvider } from "@/lib/connectors/registry";
import { exchangeCode } from "@/lib/connectors/oauth";
import { OAUTH_COOKIE, saveConnection, takeState } from "@/lib/connectors/store";
import { xMe } from "@/lib/connectors/x";
import { sallaStore } from "@/lib/connectors/salla";
import { zidStore } from "@/lib/connectors/zid";
import { SHOP_HOST, validShopifyHmac } from "@/lib/connectors/shopify";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const origin = process.env.APP_ORIGIN ?? `${url.protocol}//${url.host}`;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const jar = await cookies();
  const bound = jar.get(OAUTH_COOKIE)?.value;
  jar.delete(OAUTH_COOKIE);
  const st = await takeState(state);
  const lang = st?.lang === "en" ? "en" : "ar";
  const back = (q: string) => NextResponse.redirect(`${origin}/${lang}/app/integrations?${q}`);
  if (!st || !code) return back(`error=${encodeURIComponent(url.searchParams.get("error") ?? "invalid_state")}`);
  // A state names the provider it was issued for; it cannot complete another provider's flow (#38).
  if (st.provider !== provider) return back("error=invalid_state");
  const p = getProvider(provider);
  if (!p) return back("error=unknown_provider");
  // Only the browser and the account that started the flow can finish it (#37). The connection still goes to the
  // workspace chosen at start (st.email), so switching brand mid-flow does not move it.
  const u = await currentUser();
  if (!sameSecret(bound, state) || !u || u.email !== st.email.split("#")[0]) return back("error=session_mismatch");
  if (p.id === "shopify") {
    // Shopify signs its callback (#113), and the store must be the one the flow started for, never the unsigned query.
    if (!validShopifyHmac(url.searchParams, process.env[p.oauth!.clientSecretEnv])) return back("error=bad_hmac");
    if (!SHOP_HOST.test(st.shop ?? "") || url.searchParams.get("shop") !== st.shop) return back("error=bad_shop");
  }
  try {
    const shop = st.shop ?? "";
    const data = await exchangeCode(p, code, { shop, verifier: st.verifier || undefined });
    const meta: Record<string, string> = {};
    if (shop) meta.shop = shop;
    const expiresAt = data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined;
    const conn = { provider: p.id, data, meta, connectedAt: new Date().toISOString(), expiresAt };
    if (p.id === "x") { const me = await xMe(conn); if (me) meta.account = `@${me.username}`; }
    if (p.id === "salla") { const st2 = await sallaStore(conn); if (st2?.name) meta.account = st2.name; if (st2?.domain) meta.site = st2.domain; }
    if (p.id === "zid") { const z = await zidStore(conn); if (z?.id) meta.storeId = z.id; if (z?.name) meta.account = z.name; if (z?.url) meta.site = z.url; }
    await saveConnection(st.email, conn);
    await track(st.email.split("#")[0], "connect");
    return back(`connected=${p.id}`);
  } catch (e) {
    console.error("oauth callback failed", e);
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message.slice(0, 120) : "token_failed")}`);
  }
}
