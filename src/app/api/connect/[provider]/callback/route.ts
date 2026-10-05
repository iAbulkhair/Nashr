import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/auth";
import { sameSecret } from "@/lib/rate";
import { getProvider } from "@/lib/connectors/registry";
import { exchangeCode } from "@/lib/connectors/oauth";
import { OAUTH_COOKIE, saveConnection, takeState, type Connection } from "@/lib/connectors/store";
import { xMe } from "@/lib/connectors/x";
import { sallaStore } from "@/lib/connectors/salla";
import { zidStore } from "@/lib/connectors/zid";
import { connectMeta } from "@/lib/connectors/meta";
import { connectAds, isAdProvider } from "@/lib/connectors/ads";
import { SHOP_HOST, validShopifyHmac } from "@/lib/connectors/shopify";
import { can } from "@/lib/roles";
import { appOrigin } from "@/lib/origin";
import { connectCalendar } from "@/lib/secretary-gcal";
import type { CalProvider } from "@/lib/connectors/registry";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  // The provider sends the browser to REDIRECT() (src/lib/connectors/oauth.ts), which is on appOrigin() too, so the way
  // back to the integrations page stays on the same origin and never follows the request's Host header.
  const origin = appOrigin();
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const jar = await cookies();
  const bound = jar.get(OAUTH_COOKIE)?.value;
  jar.delete(OAUTH_COOKIE);
  const st = await takeState(state);
  const lang = st?.lang === "en" ? "en" : "ar";
  const p = getProvider(provider);
  // A calendar for Reem (`secretary`) goes back to the Todo page with a fixed `cal_error` code, never to Integrations and
  // never with the provider's text. Decided by the provider in the URL, which is how a bad state is still answered there.
  const cal = !!p?.secretary;
  const back = (q: string) => NextResponse.redirect(`${origin}/${lang}/app/${cal ? "todo" : "integrations"}?${q}`);
  if (!st || !code) {
    const err = url.searchParams.get("error");
    if (cal) return back(`cal_error=${err === "access_denied" ? "denied" : "invalid_state"}`);
    return back(`error=${encodeURIComponent(err ?? "invalid_state")}`);
  }
  // A state names the provider it was issued for; it cannot complete another provider's flow (#38).
  if (st.provider !== provider) return back(cal ? "cal_error=invalid_state" : "error=invalid_state");
  if (!p) return back("error=unknown_provider");
  // Only the browser and the account that started the flow can finish it (#37). The connection still goes to the
  // workspace chosen at start (st.email), so switching brand mid-flow does not move it.
  const u = await currentUser();
  const mismatch = cal ? "cal_error=session_mismatch" : "error=session_mismatch";
  if (!sameSecret(bound, state) || !u || u.email !== st.email.split("#")[0]) return back(mismatch);
  // And by the same login within the account. A state from before the actor was recorded names only the account, which
  // is the owner's own login, so it still completes for the owner and for nobody else.
  if ((st.actor || u.email) !== (u.actor?.email ?? "")) return back(mismatch);
  // Re-checked here, not only at start: a role removed while the provider's page was open does not finish the connection.
  if (!can(u, cal ? "calendar.link" : "connectors")) return back(cal ? "cal_error=forbidden" : "error=forbidden");
  if (cal) {
    // The calendar link is written by `connectCalendar`; this branch always returns, so a calendar provider never reaches
    // `saveConnection` below (ruling R4). Only the exception's name is logged: its message can carry the provider's text.
    let data: Record<string, string>;
    try {
      data = await exchangeCode(p, code, { verifier: st.verifier || undefined });
    } catch (e) {
      console.error("calendar callback token exchange failed", e instanceof Error ? e.name : "error");
      return back("cal_error=token_failed");
    }
    try {
      const r = await connectCalendar(st.email, u.actor!.email, p.id as CalProvider, data, Date.now());
      return back(r.ok ? "cal=choose" : `cal_error=${r.code}`);
    } catch (e) {
      console.error("calendar callback failed", e instanceof Error ? e.name : "error");
      return back("cal_error=provider_error");
    }
  }
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
    let conn: Connection = { provider: p.id, data, meta, connectedAt: new Date().toISOString(), expiresAt };
    if (p.id === "x") { const me = await xMe(conn); if (me) meta.account = `@${me.username}`; }
    if (p.id === "salla") { const st2 = await sallaStore(conn); if (st2?.name) meta.account = st2.name; if (st2?.domain) meta.site = st2.domain; }
    if (p.id === "zid") { const z = await zidStore(conn); if (z?.id) meta.storeId = z.id; if (z?.name) meta.account = z.name; if (z?.url) meta.site = z.url; }
    if (p.id === "meta") conn = await connectMeta(conn);
    if (isAdProvider(p.id)) conn = await connectAds(conn);
    await saveConnection(st.email, conn);
    await track(st.email.split("#")[0], "connect");
    return back(`connected=${p.id}`);
  } catch (e) {
    console.error("oauth callback failed", e);
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message.slice(0, 120) : "token_failed")}`);
  }
}
