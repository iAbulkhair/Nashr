import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { getProvider } from "@/lib/connectors/registry";
import { exchangeCode } from "@/lib/connectors/oauth";
import { saveConnection, takeState } from "@/lib/connectors/store";
import { xMe } from "@/lib/connectors/x";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const origin = process.env.APP_ORIGIN ?? `${url.protocol}//${url.host}`;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const st = await takeState(state);
  const lang = st?.lang === "en" ? "en" : "ar";
  const back = (q: string) => NextResponse.redirect(`${origin}/${lang}/app/integrations?${q}`);
  if (!st || !code) return back(`error=${encodeURIComponent(url.searchParams.get("error") ?? "invalid_state")}`);
  const p = getProvider(provider);
  if (!p) return back("error=unknown_provider");
  try {
    const shop = st.shop || (p.id === "shopify" ? url.searchParams.get("shop") ?? "" : "");
    const data = await exchangeCode(p, code, { shop, verifier: st.verifier || undefined });
    const meta: Record<string, string> = {};
    if (shop) meta.shop = shop;
    const expiresAt = data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined;
    const conn = { provider: p.id, data, meta, connectedAt: new Date().toISOString(), expiresAt };
    if (p.id === "x") { const me = await xMe(conn); if (me) meta.account = `@${me.username}`; }
    await saveConnection(st.email, conn);
    await track(st.email.split("#")[0], "connect");
    return back(`connected=${p.id}`);
  } catch (e) {
    console.error("oauth callback failed", e);
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message.slice(0, 120) : "token_failed")}`);
  }
}
