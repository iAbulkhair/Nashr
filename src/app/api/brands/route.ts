import { NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth";
import { BRAND_LIMIT, activeBrandId, addBrand, listBrands, saveBrands, scopeFor, setActiveBrand } from "@/lib/brands";
import { getBrand } from "@/lib/brand";
import { pmap } from "@/lib/parallel";
import { forbid } from "@/lib/roles";

/** The login whose active brand a switch moves: the person acting, never the account as a whole. */
const login = (u: User) => u.actor?.email ?? u.email;

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await listBrands(u.email);
  // One brand-file read per brand, side by side: an awaited loop cost one Redis round trip each.
  const files = await pmap(rows, (b) => getBrand(scopeFor(u.email, b.id)));
  const enriched = rows.map((b, i) => ({ ...b, name: b.name || files[i]?.name || (b.id === "default" ? u.email : "…"), hasBrandFile: !!files[i] }));
  return NextResponse.json({ ok: true, brands: enriched, active: u.brandId ?? "default", limit: BRAND_LIMIT[u.plan] ?? 1 });
}
/**
 * POST {action:"add",name} | {action:"switch",id} | {action:"rename",id,name} | {action:"archive",id}
 *
 * Switching is anyone's (it moves only the caller's own active brand, `activebrand:{login}`). Adding, renaming and
 * archiving change the account's brand list, so they need admin or owner (src/lib/roles.ts "brands.manage").
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; name?: string };
  const no = forbid(u, b.action === "switch" ? "brands.switch" : "brands.manage");
  if (no) return no;
  if (b.action === "add") {
    const r = await addBrand(u, b.name ?? "");
    return "error" in r ? NextResponse.json({ ok: false, error: r.error, limit: BRAND_LIMIT[u.plan] }, { status: 402 }) : NextResponse.json({ ok: true, brand: r });
  }
  const rows = await listBrands(u.email);
  const target = rows.find((x) => x.id === b.id);
  if (!target) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (b.action === "switch") { await setActiveBrand(login(u), target.id); return NextResponse.json({ ok: true }); }
  if (b.action === "rename") { target.name = (b.name ?? "").slice(0, 80); await saveBrands(u.email, rows); return NextResponse.json({ ok: true }); }
  if (b.action === "archive") {
    if (target.id === "default") return NextResponse.json({ ok: false, error: "cannot_archive_default" }, { status: 400 });
    target.status = target.status === "archived" ? "active" : "archived";
    await saveBrands(u.email, rows);
    // The caller leaves the brand they just archived. The owner's own key is reset too when an admin archives the brand
    // the owner is on: a member's key is validated on every request (src/lib/auth.ts), the owner's is not.
    if ((u.brandId ?? "default") === target.id) await setActiveBrand(login(u), "default");
    if (target.status === "archived" && login(u) !== u.email && (await activeBrandId(u.email)) === target.id) await setActiveBrand(u.email, "default");
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
