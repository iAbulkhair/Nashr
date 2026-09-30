import { NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth";
import { activeBrandId, addBrand, listBrands, saveBrands, scopeFor, setActiveBrand, withBrandsLock, type BrandMeta } from "@/lib/brands";
import { getBrand } from "@/lib/brand";
import { pmap } from "@/lib/parallel";
import { brandAddRefusal } from "@/lib/rate";
import { forbid } from "@/lib/roles";

/** The login whose active brand a switch moves: the person acting, never the account as a whole. */
const login = (u: User) => u.actor?.email ?? u.email;

/**
 * GET → { ok, brands, active }. There is no `limit`: brands are unlimited on every plan (src/lib/pricing.ts). An added
 * brand's setup cost is the pricing table's ONBOARD_EXTRA_BRAND_COST, which the app reads from there.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await listBrands(u.email);
  // One brand-file read per brand, side by side: an awaited loop cost one Redis round trip each.
  const files = await pmap(rows, (b) => getBrand(scopeFor(u.email, b.id)));
  const enriched = rows.map((b, i) => ({ ...b, name: b.name || files[i]?.name || (b.id === "default" ? u.email : "…"), hasBrandFile: !!files[i] }));
  return NextResponse.json({ ok: true, brands: enriched, active: u.brandId ?? "default" });
}
/**
 * POST {action:"add",name} | {action:"switch",id} | {action:"rename",id,name} | {action:"archive",id}
 *
 * Switching is anyone's (it moves only the caller's own active brand, `activebrand:{login}`). Adding, renaming and
 * archiving change the account's brand list, so they need admin or owner (src/lib/roles.ts "brands.manage").
 *
 * Adding is never refused for the plan (brands are unlimited on every plan; never 402). It is bounded by a creation
 * rate per account (src/lib/rate.ts `brandAddRefusal`: 429 `slow_down` with `retry` "hour" or "day" and a Retry-After
 * header), and every change to the list is made under the
 * list's lock (src/lib/brands.ts `withBrandsLock`: 409 `busy` when it cannot be taken). Rule 225.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; name?: string };
  const no = forbid(u, b.action === "switch" ? "brands.switch" : "brands.manage");
  if (no) return no;
  if (b.action === "add") {
    // Account-wide (u.email), so members and admins of one account share the owner's buckets.
    const refused = await brandAddRefusal(u.email);
    if (refused) return NextResponse.json({ ok: false, error: "slow_down", retry: refused }, { status: 429, headers: { "Retry-After": String(refused === "hour" ? 3600 : 86400) } });
    const r = await addBrand(u, b.name ?? "");
    return "error" in r ? NextResponse.json({ ok: false, error: r.error }, { status: 409 }) : NextResponse.json({ ok: true, brand: r });
  }
  const rows = await listBrands(u.email);
  const target = rows.find((x) => x.id === b.id);
  if (!target) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (b.action === "switch") { await setActiveBrand(login(u), target.id); return NextResponse.json({ ok: true }); }
  if (b.action === "archive" && target.id === "default") return NextResponse.json({ ok: false, error: "cannot_archive_default" }, { status: 400 });
  if (b.action !== "rename" && b.action !== "archive") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  // The change is applied to the list as it is under the lock, not to the copy read above: an add that landed in
  // between is kept.
  const changed = await withBrandsLock(u.email, async (now): Promise<BrandMeta | undefined> => {
    const row = now.find((x) => x.id === target.id);
    if (!row) return undefined;
    if (b.action === "rename") row.name = (b.name ?? "").slice(0, 80);
    else row.status = row.status === "archived" ? "active" : "archived";
    await saveBrands(u.email, now);
    return row;
  });
  if (changed === null) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
  if (!changed) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (b.action === "archive") {
    // The caller leaves the brand they just archived. The owner's own key is reset too when an admin archives the brand
    // the owner is on: a member's key is validated on every request (src/lib/auth.ts), the owner's is not.
    if ((u.brandId ?? "default") === changed.id) await setActiveBrand(login(u), "default");
    if (changed.status === "archived" && login(u) !== u.email && (await activeBrandId(u.email)) === changed.id) await setActiveBrand(u.email, "default");
  }
  return NextResponse.json({ ok: true });
}
