import { NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth";
import { activeBrandIn, activeCount, addBrand, brandChooser, brandLimitRefusal, listBrands, ownerChooser, saveBrands, scopeFor, setActiveBrandIn, withBrandsLock, type BrandLimit, type BrandMeta } from "@/lib/brands";
import { brandCapFor } from "@/lib/pricing";
import { getBrand } from "@/lib/brand";
import { pmap } from "@/lib/parallel";
import { WINDOW, brandAddRefusal, retryLater } from "@/lib/rate";
import { can, forbid } from "@/lib/roles";
import { acct } from "@/lib/account-id";

/**
 * Whose active brand a switch moves: the person acting, in this account only (`activebrand:{pid}:{aid}`, rule 2119), and
 * the legacy per-login key beside it when this account is their home. Never the account as a whole, never another account.
 */
const choose = (u: User, id: string) => {
  const who = brandChooser(u);
  return setActiveBrandIn(who.pid, who.aid, id, who.homeLogin);
};
/** Rule 3757: a member narrowed to some brands sees and switches to those only; everyone else to every brand. */
const allowed = (u: User, id: string) => !u.actor?.brands || u.actor.brands.includes(id);
/** The cap refusal as the route answers it: 402, the cap and the plan, nothing written (rule 1391). */
const overCap = (u: User, r: BrandLimit) => NextResponse.json({ ok: false, error: r.error, cap: r.cap, plan: u.plan }, { status: 402 });

/**
 * GET → { ok, brands, active, cap, count, canUpgrade }. `cap` is the account's active-brand cap (src/lib/pricing.ts
 * `brandCapFor`, rule 1390) and `count` its active brands, so the panel shows "N of cap"; `canUpgrade` says whether this
 * login may change the plan (owner), so the panel at the cap links to billing or says to ask the owner (rule 1392). An
 * added brand's setup cost is the pricing table's ONBOARD_EXTRA_BRAND_COST, which the app reads from there.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = (await listBrands(acct(u))).filter((b) => allowed(u, b.id));
  // One brand-file read per brand, side by side: an awaited loop cost one Redis round trip each.
  const files = await pmap(rows, (b) => getBrand(scopeFor(acct(u), b.id)));
  const enriched = rows.map((b, i) => ({ ...b, name: b.name || files[i]?.name || (b.id === "default" ? u.email : "…"), hasBrandFile: !!files[i] }));
  return NextResponse.json({ ok: true, brands: enriched, active: u.brandId ?? "default", cap: brandCapFor(u), count: activeCount(rows), canUpgrade: can(u, "billing") });
}
/**
 * POST {action:"add",name} | {action:"switch",id} | {action:"rename",id,name} | {action:"archive",id}
 *
 * Switching is anyone's (it moves only the caller's own active brand in this account, `activebrand:{pid}:{aid}`). Adding, renaming and
 * archiving change the account's brand list, so they need admin or owner (src/lib/roles.ts "brands.manage").
 *
 * Adding is bounded by a creation rate per account, checked first (src/lib/rate.ts `brandAddRefusal`: 429 `slow_down`
 * with `retry` "hour" or "day" and a Retry-After header), then by the plan's brand cap, read inside the list's lock
 * (src/lib/brands.ts: 402 `brand_limit` with `cap` and `plan`, nothing written; rule 1391). Restoring an archived brand
 * makes one more active brand, so it meets the same cap; archiving never does. Every change to the list is made under the
 * list's lock (`withBrandsLock`: 409 `busy` when it cannot be taken). An account above its cap (a downgrade) keeps every
 * brand and may switch, rename and archive; it cannot add or restore until it is under the cap.
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
    if (refused) return retryLater({ ok: false, error: "slow_down", retry: refused }, WINDOW[refused]);
    const r = await addBrand(u, b.name ?? "");
    if (!("error" in r)) return NextResponse.json({ ok: true, brand: r });
    return r.error === "brand_limit" ? overCap(u, r) : NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  }
  const rows = await listBrands(acct(u));
  const target = rows.find((x) => x.id === b.id);
  if (!target) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (b.action === "switch") {
    // Only to an active brand: an archived one has no pages (`b/[brand]` answers 404 for it, rule 886) and the session
    // would fall back to "default" anyway, so the choice is refused and nothing is written (rule 892).
    if (target.status !== "active" || !allowed(u, target.id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await choose(u, target.id);
    return NextResponse.json({ ok: true });
  }
  if (b.action === "archive" && target.id === "default") return NextResponse.json({ ok: false, error: "cannot_archive_default" }, { status: 400 });
  if (b.action !== "rename" && b.action !== "archive") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  // The change is applied to the list as it is under the lock, not to the copy read above: an add that landed in
  // between is kept.
  const changed = await withBrandsLock(acct(u), async (now): Promise<BrandMeta | BrandLimit | undefined> => {
    const row = now.find((x) => x.id === target.id);
    if (!row) return undefined;
    if (b.action === "rename") row.name = (b.name ?? "").slice(0, 80);
    else if (row.status === "archived") {
      // A restore adds an active brand: the cap is checked on the list as it is under the lock (rule 1391).
      const over = brandLimitRefusal(u, now);
      if (over) return over;
      row.status = "active";
    } else row.status = "archived";
    await saveBrands(acct(u), now);
    return row;
  });
  if (changed === null) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
  if (!changed) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if ("error" in changed) return overCap(u, changed);
  if (b.action === "archive" && changed.status === "archived") {
    // The caller leaves the brand they just archived: the page they archived it from, and their STORED choice whenever it
    // names it, even while they act from another brand's page (/b/Y archiving X, rule 3030). The owner's own choice in
    // this account is reset too when an admin archives the brand the owner is on. A session written before R1 and an MCP
    // token before rule 3030 used the stored choice unchecked (src/lib/auth.ts, src/lib/mcp.ts `userFromBearer`). Both
    // stored choices are read in one round, and the resets written in one more.
    const me = brandChooser(u);
    const owner = ownerChooser(u);
    const ownerToo = me.pid !== owner.pid;
    const [mine, owners] = await Promise.all([activeBrandIn(me.pid, me.aid, me.homeLogin), ownerToo ? activeBrandIn(owner.pid, owner.aid, owner.homeLogin) : Promise.resolve(null)]);
    await Promise.all([
      ...((u.brandId ?? "default") === changed.id || mine === changed.id ? [choose(u, "default")] : []),
      ...(ownerToo && owners === changed.id ? [setActiveBrandIn(owner.pid, owner.aid, "default", owner.homeLogin)] : []),
    ]);
  }
  return NextResponse.json({ ok: true });
}
