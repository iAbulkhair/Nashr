import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { BRAND_LIMIT, addBrand, listBrands, saveBrands, setActiveBrand } from "@/lib/brands";
import { getBrand } from "@/lib/brand";
import { scopeFor } from "@/lib/brands";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await listBrands(u.email);
  const enriched = [];
  for (const b of rows) {
    const file = await getBrand(scopeFor(u.email, b.id));
    enriched.push({ ...b, name: b.name || file?.name || (b.id === "default" ? u.email : "…"), hasBrandFile: !!file });
  }
  return NextResponse.json({ ok: true, brands: enriched, active: u.brandId ?? "default", limit: BRAND_LIMIT[u.plan] ?? 1 });
}
/** POST {action:"add",name} | {action:"switch",id} | {action:"rename",id,name} | {action:"archive",id} */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; name?: string };
  if (b.action === "add") {
    const r = await addBrand(u, b.name ?? "");
    return "error" in r ? NextResponse.json({ ok: false, error: r.error, limit: BRAND_LIMIT[u.plan] }, { status: 402 }) : NextResponse.json({ ok: true, brand: r });
  }
  const rows = await listBrands(u.email);
  const target = rows.find((x) => x.id === b.id);
  if (!target) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (b.action === "switch") { await setActiveBrand(u.email, target.id); return NextResponse.json({ ok: true }); }
  if (b.action === "rename") { target.name = (b.name ?? "").slice(0, 80); await saveBrands(u.email, rows); return NextResponse.json({ ok: true }); }
  if (b.action === "archive") {
    if (target.id === "default") return NextResponse.json({ ok: false, error: "cannot_archive_default" }, { status: 400 });
    target.status = target.status === "archived" ? "active" : "archived";
    await saveBrands(u.email, rows);
    if ((u.brandId ?? "default") === target.id) await setActiveBrand(u.email, "default");
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
