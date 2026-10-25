import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { deleteConnection, getConnection } from "@/lib/connectors/store";
import { isComposio, liOrgName, postAsVia, revokeAll, selectOrgVia, selectPageVia, selectProjectVia, selectPropertyVia } from "@/lib/connectors/via-composio";
import { recordActivity } from "@/lib/activity";
import { PartlyRead, holdsSocial, isSocialProvider, readSocialSoon, syncSocialIfDue } from "@/lib/social-stats";
import { holdsSite, readSiteSoon, syncSiteIfDue } from "@/lib/site-stats";
import { holdsProduct, readProductSoon, syncProductIfDue } from "@/lib/product-stats";
import { X_RETRY_DEFAULT_S, dropXStats, refreshX, xForPage } from "@/lib/x-stats";
import { markOwnerSync } from "@/lib/routines";
import { CATALOG_IMPORTS_PER_HOUR, STORE_SYNCS_PER_HOUR, WINDOW, allow, retryAfter, retryLater } from "@/lib/rate";
import { wsKey } from "@/lib/keys";
import { byOf } from "@/lib/actor";
import { BUSY_RETRY_S, ConnectionBusy, RefreshBusy, getFreshConnection, refusedToken, withConnectionLock } from "@/lib/connectors/fresh";
import { importShopify } from "@/lib/connectors/shopify";
import { importWoo } from "@/lib/connectors/woocommerce";
import { importSalla } from "@/lib/connectors/salla";
import { importZid } from "@/lib/connectors/zid";
import { dropSalesSnapshot, syncSales } from "@/lib/store-sales";
import { SALES_PROVIDERS, type SalesProvider } from "@/lib/connectors/sales";
import { importOdoo, importPrestaShop } from "@/lib/connectors/keyed";
import { selectPage } from "@/lib/connectors/meta";
import { isAdProvider, selectAdAccount } from "@/lib/connectors/ads";
import { syncAds } from "@/lib/perf-store";
import { saveConnection } from "@/lib/connectors/store";
import { getProvider } from "@/lib/connectors/registry";
import { forbid, type Action } from "@/lib/roles";

export const maxDuration = 120;

const isSalesProvider = (p: string): p is SalesProvider => (SALES_PROVIDERS as readonly string[]).includes(p);

export async function DELETE(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  // Reem's calendar providers are not connectors: they are linked and unlinked only through /api/secretary/calendar-link.
  if (getProvider(provider)?.secretary) return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  const no = forbid(u, "connectors");
  if (no) return no;
  // Under the connection lock the token refresh takes (rule 2931): a refresh in flight finishes and saves before the
  // record goes, and never saves it back afterwards. A lock held through every wait answers 409 `busy`, nothing deleted.
  try {
    return await withConnectionLock(sc(u), provider, async () => {
      // A Composio connection is revoked at the platform first. If that fails the record stays, marked, so the owner can
      // try again: deleting it would leave a live grant Thakeen can no longer find.
      const c = await getConnection(sc(u), provider);
      if (c && isComposio(c)) {
        const left = await revokeAll(sc(u), c).catch(() => ["all"]);
        if (left.length) {
          await saveConnection(sc(u), { ...c, needsReconnect: "revoke_failed" });
          return NextResponse.json({ ok: false, error: "revoke_failed" }, { status: 502 });
        }
      }
      // X's stored read goes with its connection (rule 747): another account connected later must never show this one's
      // results or history, and its first read is its own. A store's sales snapshot, its failure note and store-sales.md go
      // the same way when they came from this store's platform (rule 2206), so Dana never reports on a store that is gone;
      // the owner's products.md stays.
      await Promise.all([
        deleteConnection(sc(u), provider),
        provider === "x" ? dropXStats(sc(u)) : null,
        isSalesProvider(provider) ? dropSalesSnapshot(sc(u), provider) : null,
      ]);
      return NextResponse.json({ ok: true });
    });
  } catch (e) {
    if (e instanceof ConnectionBusy) return NextResponse.json({ ok: false, error: "busy" }, { status: 409, headers: retryAfter(BUSY_RETRY_S) });
    throw e;
  }
}

/**
 * What each action needs (src/lib/roles.ts). Choosing the page or ad account a connection posts to, or the GA4 property
 * and Search Console site it reads, is connector setup, admin and owner only, and so is overwriting products.md from the
 * store. The syncs only pull the platform's own numbers into the reports, which any member may refresh. X's refresh
 * spends a credit of the account (rule 744), so it needs what any spending needs, `generate` (any member). An action not
 * listed here is refused.
 */
const ACTION_ROLE: Record<string, Action> = { select_page: "connectors", select_org: "connectors", post_as: "connectors", select_ad_account: "connectors", select_property: "connectors", select_project: "connectors", import_products: "catalog.import", sync_ads: "read", sync_sales: "read", sync_site: "read", sync_product: "read", sync_social: "read", sync_x: "generate" };

/** Refreshes of the site, the social results, the ad results or X one workspace may ask for in an hour, the team together (rule 735). */
const OWNER_SYNCS_PER_HOUR = 6;

/**
 * An owner's refresh (rules 735, 736): the read, forced whatever the last read's age, and the mark Dana's routine counts
 * as activity, side by side. The click counts even when the platform fails. The readers convert a refused token
 * themselves (syncSiteIfDue for Google, syncSocialIfDue with the refused part's own provider), so a read's failure is
 * answered here and never reaches the route's refusedToken, which would use the path's provider. A social read that saved the
 * snapshot while one part's token was refused is a read: 200 with the part to reconnect.
 */
/** Another request held the token's refresh through every wait (rule 2192): nothing was read or spent, try again shortly. */
const refreshBusy = () => NextResponse.json({ ok: false, error: "busy" }, { status: 503, headers: retryAfter(BUSY_RETRY_S) });

async function ownerRefresh(scope: string, read: () => Promise<boolean>) {
  const [r, mark] = await Promise.allSettled([read(), markOwnerSync(scope)]);
  if (mark.status === "rejected") console.error("owner sync mark failed");
  if (r.status === "fulfilled") return NextResponse.json({ ok: true, read: r.value });
  if (r.reason instanceof PartlyRead) return NextResponse.json({ ok: true, read: true, reconnect: r.reason.provider });
  if (r.reason instanceof RefreshBusy) return refreshBusy();
  return NextResponse.json({ ok: false, error: r.reason instanceof Error ? r.reason.message : "failed" }, { status: 502 });
}

/** POST {action:"import_products"}, for Salla, Shopify, WooCommerce and Zid {action:"sync_sales"}, for Meta {action:"select_page", pageId}, for LinkedIn {action:"select_org", org} and {action:"post_as", value:"me"|"org"}, for Google {action:"select_property", kind:"ga4"|"gsc", id} and {action:"sync_site"}, for Meta, LinkedIn, YouTube and TikTok {action:"sync_social"}, for X {action:"sync_x"} (1 credit, at most once a UTC day) */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  if (getProvider(provider)?.secretary) return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; pageId?: string; accountId?: string; org?: string; value?: string; kind?: string; id?: string };
  const need = Object.prototype.hasOwnProperty.call(ACTION_ROLE, String(b.action)) ? ACTION_ROLE[String(b.action)] : null;
  if (!need) return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const no = forbid(u, need);
  if (no) return no;
  try {
    const c = await getFreshConnection(sc(u), provider);
    if (!c) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
    if (b.action === "import_products") {
      // Every import reads the whole catalog from the store (a user-supplied host for WooCommerce, Odoo and PrestaShop)
      // and rewrites products.md, so six an hour per workspace; the click counts even when the store fails (rule 2243).
      if (!(await allow(wsKey.catalogImportBucket(sc(u)), CATALOG_IMPORTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      const n = provider === "shopify" ? await importShopify(sc(u), c) : provider === "woocommerce" ? await importWoo(sc(u), c) : provider === "odoo" ? await importOdoo(sc(u), c) : provider === "prestashop" ? await importPrestaShop(sc(u), c) : provider === "salla" ? await importSalla(sc(u), c) : provider === "zid" ? await importZid(sc(u), c) : 0;
      return NextResponse.json({ ok: true, count: n });
    }
    if (b.action === "select_page" && provider === "meta") {
      const next = isComposio(c) ? selectPageVia(c, String(b.pageId ?? "")) : selectPage(c, String(b.pageId ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_page" }, { status: 400 });
      await saveConnection(sc(u), next);
      // A direct Meta record has no social reader. On a Composio record the new Page's results (rule 739) are read at once
      // only while the workspace's six social reads an hour last (the sync_social bucket), else the daily run or a later
      // refresh reads it.
      if (!isComposio(c)) return NextResponse.json({ ok: true, account: next.meta?.account });
      const read = await allow(`socialsync:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour);
      if (read) readSocialSoon(sc(u));
      return NextResponse.json({ ok: true, account: next.meta?.account, read });
    }
    // The LinkedIn company page whose results are read (rule 671); only a page listed at connect time. The new page is
    // read at once only while the workspace's six social reads an hour last (the sync_social bucket, like select_page),
    // else the daily run or a later refresh reads it.
    if (b.action === "select_org" && provider === "linkedin" && isComposio(c)) {
      const next = selectOrgVia(c, String(b.org ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_org" }, { status: 400 });
      // A new page posts as the member until the owner says otherwise; leaving the page's posting is logged like post_as.
      await Promise.all([
        saveConnection(sc(u), next),
        c.meta?.liPostAs === "org" ? recordActivity(sc(u), [{ at: new Date().toISOString(), kind: "connector_changed", by: byOf(u), via: "app", outcome: "linkedin:post_as:me", note: "" }]) : null,
      ]);
      const read = await allow(`socialsync:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour);
      if (read) readSocialSoon(sc(u));
      return NextResponse.json({ ok: true, account: next.meta?.account, read });
    }
    // Publish to LinkedIn as the member or as the chosen page (rule 672): checked here, never left to a prompt.
    if (b.action === "post_as" && provider === "linkedin" && isComposio(c)) {
      const value = String(b.value ?? "");
      if (value !== "me" && value !== "org") return NextResponse.json({ ok: false, error: "bad_value" }, { status: 400 });
      const next = postAsVia(c, value);
      if (!next) return NextResponse.json({ ok: false, error: "no_page" }, { status: 400 });
      if ((c.meta?.liPostAs ?? "me") !== value) {
        await Promise.all([
          saveConnection(sc(u), next),
          recordActivity(sc(u), [{ at: new Date().toISOString(), kind: "connector_changed", by: byOf(u), via: "app", outcome: `linkedin:post_as:${value}`, note: liOrgName(next) }]),
        ]);
      }
      return NextResponse.json({ ok: true, postAs: value });
    }
    // The GA4 property or Search Console site whose figures are read (rule 734): only one listed at connect time. The
    // choice is always saved; the site is read again at once only while the workspace's six site reads an hour last
    // (the sync_site bucket), else the daily run or a later refresh reads it.
    if (b.action === "select_property" && provider === "google" && isComposio(c)) {
      const kind = String(b.kind ?? "");
      if (kind !== "ga4" && kind !== "gsc") return NextResponse.json({ ok: false, error: "bad_value" }, { status: 400 });
      const next = selectPropertyVia(c, kind, String(b.id ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_property" }, { status: 400 });
      await saveConnection(sc(u), next);
      const read = await allow(`sitesync:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour);
      if (read) readSiteSoon(sc(u));
      return NextResponse.json({ ok: true, account: next.meta?.account, read });
    }
    // The PostHog project whose figures are read (rules 4230-4259): only one listed at connect time. Saved always; read at
    // once only while the workspace's six product reads an hour last (the sync_product bucket).
    if (b.action === "select_project" && provider === "posthog" && isComposio(c)) {
      const next = selectProjectVia(c, String(b.id ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_project" }, { status: 400 });
      await saveConnection(sc(u), next);
      const read = await allow(wsKey.productSyncBucket(sc(u)), OWNER_SYNCS_PER_HOUR, WINDOW.hour);
      if (read) readProductSoon(sc(u));
      return NextResponse.json({ ok: true, account: next.meta?.account, read });
    }
    if (b.action === "select_ad_account" && isAdProvider(provider)) {
      const next = selectAdAccount(c, String(b.accountId ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_account" }, { status: 400 });
      await saveConnection(sc(u), next);
      return NextResponse.json({ ok: true, account: next.meta?.account });
    }
    // Read only, no model call, no credits: the ads' own numbers into the same analysis as a CSV upload. Six an hour per
    // workspace, every ad platform together, so a member's clicks cannot spend the platforms' own rate limits (rule 735).
    if (b.action === "sync_ads" && isAdProvider(provider)) {
      if (!(await allow(`adrefresh:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      return NextResponse.json({ ok: true, snapshot: await syncAds(sc(u), provider, c) });
    }
    // Any member may refresh the sales card, and each refresh reads several pages of orders and carts from the store, so six an hour
    // per workspace, every store together (rule 2243). The stores cron calls syncSales itself and is not counted.
    if (b.action === "sync_sales" && (SALES_PROVIDERS as readonly string[]).includes(provider)) {
      if (!(await allow(wsKey.storeSyncBucket(sc(u)), STORE_SYNCS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      return NextResponse.json({ ok: true, sales: await syncSales(sc(u), provider as SalesProvider, c) });
    }
    // Read only, no model call, no credits: the site's figures or every social part the workspace holds, read at once.
    // Six an hour per workspace, the bucket keyed by scope so the team and every social path share it (rule 735).
    if (b.action === "sync_site" && provider === "google") {
      if (!holdsSite(c)) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
      if (!(await allow(`sitesync:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      return await ownerRefresh(sc(u), () => syncSiteIfDue(sc(u), new Date(), true));
    }
    if (b.action === "sync_product" && provider === "posthog") {
      if (!holdsProduct(c)) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
      if (!(await allow(wsKey.productSyncBucket(sc(u)), OWNER_SYNCS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      return await ownerRefresh(sc(u), () => syncProductIfDue(sc(u), new Date(), true));
    }
    if (b.action === "sync_social" && isSocialProvider(provider)) {
      if (!holdsSocial(provider, c)) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
      if (!(await allow(`socialsync:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      return await ownerRefresh(sc(u), () => syncSocialIfDue(sc(u), new Date(), true));
    }
    // X's results, paid by the account (rules 744, 745): the charge, its cap, the day's free re-read and the refund are
    // checked in refreshX, before X is asked. X's 401 is thrown to the catch below, which asks the owner to reconnect.
    // Six clicks an hour per workspace (rule 735), so failing reads that each refund cannot ask X without end.
    if (b.action === "sync_x" && provider === "x") {
      if (!(await allow(`xsync:${sc(u)}`, OWNER_SYNCS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
      const r = await refreshX(u, c);
      // The read without the account's id, which only the next read uses (rule 746).
      if (r.ok) return NextResponse.json({ ok: true, x: xForPage(r.x), charged: r.charged });
      if (r.status === 429) return retryLater({ ok: false, error: r.error }, r.retryAfter ?? X_RETRY_DEFAULT_S);
      return NextResponse.json({ ok: false, error: r.error, ...r.extra }, { status: r.status });
    }
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  } catch (e) {
    if (e instanceof RefreshBusy) return refreshBusy();
    const err = await refusedToken(sc(u), provider, e);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}
