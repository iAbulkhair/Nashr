import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { deleteConnection, getConnection } from "@/lib/connectors/store";
import { isComposio, liOrgName, postAsVia, revokeAll, selectOrgVia, selectPageVia } from "@/lib/connectors/via-composio";
import { recordActivity } from "@/lib/activity";
import { byOf } from "@/lib/actor";
import { getFreshConnection, refusedToken } from "@/lib/connectors/fresh";
import { importShopify } from "@/lib/connectors/shopify";
import { importWoo } from "@/lib/connectors/woocommerce";
import { importSalla } from "@/lib/connectors/salla";
import { importZid } from "@/lib/connectors/zid";
import { syncSales } from "@/lib/store-sales";
import { SALES_PROVIDERS, type SalesProvider } from "@/lib/connectors/sales";
import { importOdoo, importPrestaShop } from "@/lib/connectors/keyed";
import { selectPage } from "@/lib/connectors/meta";
import { isAdProvider, selectAdAccount } from "@/lib/connectors/ads";
import { syncAds } from "@/lib/perf-store";
import { saveConnection } from "@/lib/connectors/store";
import { forbid, type Action } from "@/lib/roles";

export const maxDuration = 120;

export async function DELETE(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "connectors");
  if (no) return no;
  const { provider } = await ctx.params;
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
  await deleteConnection(sc(u), provider);
  return NextResponse.json({ ok: true });
}

/**
 * What each action needs (src/lib/roles.ts). Choosing the page or ad account a connection posts to is connector setup,
 * admin and owner only, and so is overwriting products.md from the store. The syncs only pull the platform's own
 * numbers into the reports, which any member may refresh. An action not listed here is refused.
 */
const ACTION_ROLE: Record<string, Action> = { select_page: "connectors", select_org: "connectors", post_as: "connectors", select_ad_account: "connectors", import_products: "catalog.import", sync_ads: "read", sync_sales: "read" };

/** POST {action:"import_products"}, for Salla, Shopify, WooCommerce and Zid {action:"sync_sales"}, for Meta {action:"select_page", pageId}, for LinkedIn {action:"select_org", org} and {action:"post_as", value:"me"|"org"} */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { action?: string; pageId?: string; accountId?: string; org?: string; value?: string };
  const need = Object.prototype.hasOwnProperty.call(ACTION_ROLE, String(b.action)) ? ACTION_ROLE[String(b.action)] : null;
  if (!need) return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const no = forbid(u, need);
  if (no) return no;
  try {
    const c = await getFreshConnection(sc(u), provider);
    if (!c) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
    if (b.action === "import_products") {
      const n = provider === "shopify" ? await importShopify(sc(u), c) : provider === "woocommerce" ? await importWoo(sc(u), c) : provider === "odoo" ? await importOdoo(sc(u), c) : provider === "prestashop" ? await importPrestaShop(sc(u), c) : provider === "salla" ? await importSalla(sc(u), c) : provider === "zid" ? await importZid(sc(u), c) : 0;
      return NextResponse.json({ ok: true, count: n });
    }
    if (b.action === "select_page" && provider === "meta") {
      const next = isComposio(c) ? selectPageVia(c, String(b.pageId ?? "")) : selectPage(c, String(b.pageId ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_page" }, { status: 400 });
      await saveConnection(sc(u), next);
      return NextResponse.json({ ok: true, account: next.meta?.account });
    }
    // The LinkedIn company page whose results are read (rule 669); only a page listed at connect time.
    if (b.action === "select_org" && provider === "linkedin" && isComposio(c)) {
      const next = selectOrgVia(c, String(b.org ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_org" }, { status: 400 });
      await saveConnection(sc(u), next);
      return NextResponse.json({ ok: true, account: next.meta?.account });
    }
    // Publish to LinkedIn as the member or as the chosen page (rule 670): checked here, never left to a prompt.
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
    if (b.action === "select_ad_account" && isAdProvider(provider)) {
      const next = selectAdAccount(c, String(b.accountId ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_account" }, { status: 400 });
      await saveConnection(sc(u), next);
      return NextResponse.json({ ok: true, account: next.meta?.account });
    }
    // Read only, no model call, no credits: the ads' own numbers into the same analysis as a CSV upload.
    if (b.action === "sync_ads" && isAdProvider(provider)) return NextResponse.json({ ok: true, snapshot: await syncAds(sc(u), provider, c) });
    if (b.action === "sync_sales" && (SALES_PROVIDERS as readonly string[]).includes(provider)) return NextResponse.json({ ok: true, sales: await syncSales(sc(u), provider as SalesProvider, c) });
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  } catch (e) {
    const err = await refusedToken(sc(u), provider, e);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}
