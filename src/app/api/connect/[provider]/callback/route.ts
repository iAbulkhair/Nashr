import { track } from "@/lib/track";
import { errorTag } from "@/lib/log-safe";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/auth";
import { accountOfScope, acct } from "@/lib/account-id";
import { sameSecret } from "@/lib/rate";
import { getProvider } from "@/lib/connectors/registry";
import { exchangeCode, tokenExpiry } from "@/lib/connectors/oauth";
import { withConnectionLock } from "@/lib/connectors/fresh";
import { OAUTH_COOKIE, getConnection, saveConnection, takeState, type Connection } from "@/lib/connectors/store";
import { dropCookie, readCookie } from "@/lib/cookie-names";
import { composioDiscard, composioVerify } from "@/lib/connectors/composio";
import { isToolkit, PROVIDER_TOOLKITS } from "@/lib/connectors/composio-catalog";
import { connectViaComposio } from "@/lib/connectors/via-composio";
import { syncSite } from "@/lib/site-stats";
import { isSocialProvider, readSocialSoon } from "@/lib/social-stats";
import { xMe } from "@/lib/connectors/x";
import { sallaStore } from "@/lib/connectors/salla";
import { zidStore } from "@/lib/connectors/zid";
import { connectMeta } from "@/lib/connectors/meta";
import { connectAds, isAdProvider } from "@/lib/connectors/ads";
import { SHOP_HOST, subscribeUninstall, UNINSTALL_HOOK_META, validShopifyHmac } from "@/lib/connectors/shopify";
import { can } from "@/lib/roles";
import { appOrigin } from "@/lib/origin";
import { brandIdOfScope } from "@/lib/brands";
import { settingsPath } from "@/lib/settings-nav";
import { dropSnapshotIfStoreChanged, storeIdentity } from "@/lib/store-sales";
import { connectCalendar, connectCalendarVia } from "@/lib/secretary-gcal";
import type { CalProvider } from "@/lib/connectors/registry";
import { appHrefIn } from "@/lib/ws-href";
import { appHref } from "@/lib/ws-path";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  // The provider sends the browser to REDIRECT() (src/lib/connectors/oauth.ts), which is on appOrigin() too, so the way
  // back to the integrations page stays on the same origin and never follows the request's Host header.
  const origin = appOrigin();
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const jar = await cookies();
  // New name first, then a flow started before the rename (rule 1810); both are cleared.
  const bound = readCookie(jar, OAUTH_COOKIE);
  dropCookie(jar, OAUTH_COOKIE);
  const st = await takeState(state);
  const lang = st?.lang === "en" ? "en" : "ar";
  const p = getProvider(provider);
  // A calendar for Reem (`secretary`) goes back to the Todo page with a fixed `cal_error` code, never to Integrations and
  // never with the provider's text. Decided by the provider in the URL, which is how a bad state is still answered there.
  const cal = !!p?.secretary;
  // The page it returns to is the brand's whose page started the flow: the brand of the scope in the stored state (`st.email`,
  // written by `start`, the scope the connection goes to), never a value from this request and never the session's stored
  // choice, which can be another brand by now. Without a state (an error before it is read) there is no brand to name, so the
  // old path stays and the `[...legacy]` page sends it to the session's brand. The workspace is that scope's account's too.
  const brand = st?.email ? brandIdOfScope(st.email) : null;
  const page = cal ? "/todo" : brand ? settingsPath("connections") : "/integrations";
  const back = (q: string) => NextResponse.redirect(`${origin}${st ? appHrefIn(st.email, lang, `${page}?${q}`, brand) : appHref(lang, `${page}?${q}`)}`);
  // A Composio flow comes back with no code: the account was created at start and is verified below.
  if (!st || (!code && st.via !== "composio")) {
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
  if (!sameSecret(bound, state) || !u || acct(u) !== accountOfScope(st.email)) return back(mismatch);
  // And by the same login within the account. A state from before the actor was recorded names only the account, which
  // is the owner's own login, so it still completes for the owner and for nobody else.
  if ((st.actor || u.email) !== (u.actor?.email ?? "")) return back(mismatch);
  // Re-checked here, not only at start: a role removed while the provider's page was open does not finish the connection.
  if (!can(u, cal ? "calendar.link" : "connectors")) return back(cal ? "cal_error=forbidden" : "error=forbidden");
  if (cal && st.via === "composio") {
    // Reem's calendar through Composio (rule 4260): the account is checked ACTIVE and this workspace's, then `connectCalendarVia`
    // writes the link. Like the direct branch below it always returns, so this provider never reaches `saveConnection`.
    const toolkit = st.toolkit ?? "";
    if (!isToolkit(toolkit) || !(PROVIDER_TOOLKITS[p.id] ?? []).includes(toolkit) || !st.accountId) return back("cal_error=invalid_state");
    let linked = false;
    try {
      await composioVerify(st.email, toolkit, st.accountId);
      const r = await connectCalendarVia(st.email, u.actor!.email, st.accountId, Date.now());
      linked = r.ok;
      // Not linked: the account Composio made would otherwise stay ACTIVE there with nothing in our records.
      if (!r.ok) await composioDiscard(st.accountId);
      return back(r.ok ? "cal=choose" : `cal_error=${r.code}`);
    } catch (e) {
      if (!linked) await composioDiscard(st.accountId);
      const msg = e instanceof Error ? e.message : "";
      console.error("calendar composio callback failed", /^[a-z_]+$/.test(msg) ? msg : "error");
      return back(msg === "connect_failed" ? "cal_error=token_failed" : "cal_error=provider_error");
    }
  }
  if (cal) {
    // The calendar link is written by `connectCalendar`; this branch always returns, so a calendar provider never reaches
    // `saveConnection` below (ruling R4). Only the exception's name is logged: its message can carry the provider's text.
    let data: Record<string, string>;
    try {
      data = await exchangeCode(p, code!, { verifier: st.verifier || undefined });
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
  if (st.via === "composio") {
    // Everything comes from the saved state: the toolkit must be one this provider lists, and the account is checked to
    // be ACTIVE and to belong to this workspace's Composio user before anything is stored.
    const toolkit = st.toolkit ?? "";
    if (!isToolkit(toolkit) || !(PROVIDER_TOOLKITS[p.id] ?? []).includes(toolkit) || !st.accountId) return back("error=invalid_state");
    let saved = false;
    try {
      await composioVerify(st.email, toolkit, st.accountId);
      // Read and saved under the connection lock (rule 2931), so a token refresh in flight never writes over it.
      const conn = await withConnectionLock(st.email, p.id, async () => {
        const made = await connectViaComposio(st.email, p.id, toolkit, st.accountId!, await getConnection(st.email, p.id));
        await saveConnection(st.email, made);
        return made;
      });
      saved = true;
      // A first read so Dana's next report has the site's figures; the daily run retries whatever fails here.
      if (p.id === "google") await syncSite(st.email, conn).catch(() => console.error("site first read failed"));
      // And the social card's first figures, after the redirect: any social record (Instagram or the Facebook Page on Meta,
      // the LinkedIn page once one is chosen, the YouTube channel, the TikTok account). It reads only the parts held.
      if (isSocialProvider(p.id)) readSocialSoon(st.email);
      await track(accountOfScope(st.email), "connect");
      return back(`connected=${p.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Composio's OAuth went through, but nothing was stored: the new account would otherwise stay ACTIVE there.
      if (!saved) await composioDiscard(st.accountId);
      console.error("composio callback failed", p.id, toolkit, /^[a-z_]+$/.test(msg) ? msg : "error");
      return back(`error=${/^[a-z_]+$/.test(msg) ? msg : "connect_failed"}`);
    }
  }
  if (!code) return back("error=invalid_state");
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
    const expiresAt = tokenExpiry(data);
    let conn: Connection = { provider: p.id, data, meta, connectedAt: new Date().toISOString(), expiresAt };
    if (p.id === "x") { const me = await xMe(conn); if (me) meta.account = `@${me.username}`; }
    if (p.id === "salla") { const st2 = await sallaStore(conn); if (st2?.name) meta.account = st2.name; if (st2?.domain) meta.site = st2.domain; }
    if (p.id === "zid") { const z = await zidStore(conn); if (z?.id) meta.storeId = z.id; if (z?.name) meta.account = z.name; if (z?.url) meta.site = z.url; }
    if (p.id === "meta") conn = await connectMeta(conn);
    if (isAdProvider(p.id)) conn = await connectAds(conn);
    // Best effort: Shopify then tells us when the store uninstalls the app (rule 2203). Never throws; the mark saved with
    // the connection tells the stores cron this store needs no second try (rule 2204).
    if (p.id === "shopify" && (await subscribeUninstall(conn, origin))) meta[UNINSTALL_HOOK_META] = new Date().toISOString();
    // Another store of the same platform replaces this one: its totals go before the new store's first sync (rule 2207).
    // Under the connection lock the token refresh takes (rule 2931): a refresh of the old grant in flight finishes first and,
    // reading again before its save, never writes the old grant's tokens over this one. A lock held through every wait
    // throws `ConnectionBusy`, answered below as `error=busy`; nothing is saved and the owner connects again.
    await withConnectionLock(st.email, p.id, async () => {
      const before = storeIdentity(conn) ? await getConnection(st.email, p.id).catch(() => null) : null;
      await saveConnection(st.email, conn);
      await dropSnapshotIfStoreChanged(st.email, before, conn);
    });
    await track(accountOfScope(st.email), "connect");
    return back(`connected=${p.id}`);
  } catch (e) {
    console.error("oauth callback failed", p.id, errorTag(e));
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message.slice(0, 120) : "token_failed")}`);
  }
}
