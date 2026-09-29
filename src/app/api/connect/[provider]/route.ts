import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { deleteConnection } from "@/lib/connectors/store";
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
  await deleteConnection(sc(u), provider);
  return NextResponse.json({ ok: true });
}

/**
 * What each action needs (src/lib/roles.ts). Choosing the page or ad account a connection posts to is connector setup,
 * admin and owner only, and so is overwriting products.md from the store. The syncs only pull the platform's own
 * numbers into the reports, which any member may refresh. An action not listed here is refused.
 */
const ACTION_ROLE: Record<string, Action> = { select_page: "connectors", select_ad_account: "connectors", import_products: "catalog.import", sync_ads: "read", sync_sales: "read" };

/** POST {action:"import_products"}, for Salla, Shopify and Zid {action:"sync_sales"}, for Meta {action:"select_page", pageId} */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { action?: string; pageId?: string; accountId?: string };
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
      const next = selectPage(c, String(b.pageId ?? ""));
      if (!next) return NextResponse.json({ ok: false, error: "unknown_page" }, { status: 400 });
      await saveConnection(sc(u), next);
      return NextResponse.json({ ok: true, account: next.meta?.account });
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
