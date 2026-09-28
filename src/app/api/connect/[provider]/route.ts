import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { deleteConnection } from "@/lib/connectors/store";
import { getFreshConnection, refusedToken } from "@/lib/connectors/fresh";
import { importShopify } from "@/lib/connectors/shopify";
import { importWoo } from "@/lib/connectors/woocommerce";
import { importSalla } from "@/lib/connectors/salla";
import { syncSales } from "@/lib/store-sales";
import { SALES_PROVIDERS, type SalesProvider } from "@/lib/connectors/sales";
import { importOdoo, importPrestaShop } from "@/lib/connectors/keyed";

export const maxDuration = 120;

export async function DELETE(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  await deleteConnection(sc(u), provider);
  return NextResponse.json({ ok: true });
}

/** POST {action:"import_products"} or, for Salla and Shopify, {action:"sync_sales"} */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    const c = await getFreshConnection(sc(u), provider);
    if (!c) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
    if (b.action === "import_products") {
      const n = provider === "shopify" ? await importShopify(sc(u), c) : provider === "woocommerce" ? await importWoo(sc(u), c) : provider === "odoo" ? await importOdoo(sc(u), c) : provider === "prestashop" ? await importPrestaShop(sc(u), c) : provider === "salla" ? await importSalla(sc(u), c) : 0;
      return NextResponse.json({ ok: true, count: n });
    }
    if (b.action === "sync_sales" && (SALES_PROVIDERS as readonly string[]).includes(provider)) return NextResponse.json({ ok: true, sales: await syncSales(sc(u), provider as SalesProvider, c) });
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  } catch (e) {
    const err = await refusedToken(sc(u), provider, e);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}
