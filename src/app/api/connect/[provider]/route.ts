import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { deleteConnection, getConnection } from "@/lib/connectors/store";
import { importShopify } from "@/lib/connectors/shopify";
import { importWoo } from "@/lib/connectors/woocommerce";
import { importOdoo, importPrestaShop } from "@/lib/connectors/keyed";

export const maxDuration = 120;

export async function DELETE(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  await deleteConnection(sc(u), provider);
  return NextResponse.json({ ok: true });
}

/** POST {action:"import_products"} */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await ctx.params;
  const c = await getConnection(sc(u), provider);
  if (!c) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (b.action === "import_products") {
      const n = provider === "shopify" ? await importShopify(sc(u), c) : provider === "woocommerce" ? await importWoo(sc(u), c) : provider === "odoo" ? await importOdoo(sc(u), c) : provider === "prestashop" ? await importPrestaShop(sc(u), c) : 0;
      return NextResponse.json({ ok: true, count: n });
    }
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}
