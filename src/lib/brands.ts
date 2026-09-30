import { db } from "./db";
import type { User } from "./auth";

/**
 * Multi-brand workspaces. Every brand-scoped record (brand file, tasks, files, chat, governance,
 * schedule, connections) is keyed by a *scope*: the default brand's scope is the user's email
 * (backward compatible); extra brands use `${email}#${brandId}`.
 *
 * Brands are unlimited on every plan (src/lib/pricing.ts; there is no brand cap anywhere). What bounds them is a rate,
 * not a count: `brandAddRefusal` in src/lib/rate.ts, checked by POST /api/brands before `addBrand`. An added brand's
 * onboarding costs ONBOARD_EXTRA_BRAND_COST credits (src/app/api/onboard/route.ts) and its Sunday plan is off until the
 * owner switches it on (src/lib/schedule.ts `getSchedule`). Rules 245-247, tests/brand-guardrails.test.ts.
 */
export type BrandMeta = { id: string; name: string; createdAt: string; status: "active" | "archived" };

export async function listBrands(email: string): Promise<BrandMeta[]> {
  const rows = (await db.get<BrandMeta[]>(`brands:${email}`)) ?? [];
  if (!rows.find((b) => b.id === "default")) rows.unshift({ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" });
  return rows;
}
export async function saveBrands(email: string, rows: BrandMeta[]) {
  await db.set(`brands:${email}`, rows);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Read-modify-write of the account's brand list (`brands:{email}`) under `brandslock:{email}`, waiting about a second
 * for it (20 × 50 ms). Two adds, or an add and a rename, sent side by side used to each read the list, change their
 * copy and save it, so the second save dropped the first one's brand. Null when the lock could not be taken: nothing
 * was written, and the caller answers "busy". Always released.
 */
export async function withBrandsLock<T>(email: string, fn: (rows: BrandMeta[]) => Promise<T>): Promise<T | null> {
  const key = `brandslock:${email}`;
  let got = false;
  for (let i = 0; i < 20 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await sleep(50);
  }
  if (!got) return null;
  try {
    return await fn(await listBrands(email));
  } finally {
    // A failed release must not turn a saved change into a throw. The 10 s TTL frees the lock.
    await db.unlock(key).catch((e) => console.error("brands lock release failed", e instanceof Error ? e.name : "error"));
  }
}

/**
 * The active brand is per LOGIN (`activebrand:{loginEmail}`): the owner's key is unchanged, and each member has their
 * own, so one person switching brands never moves the owner, the other members or the owner's MCP token. Pass the
 * actor's email (`u.actor?.email ?? u.email`), never the account email for a member. `currentUser` validates a member's
 * value against the owner's active brands.
 */
export async function activeBrandId(email: string) {
  return (await db.get<string>(`activebrand:${email}`)) ?? "default";
}
export async function setActiveBrand(email: string, id: string) {
  await db.set(`activebrand:${email}`, id);
}
export function scopeFor(email: string, brandId: string) {
  return brandId === "default" ? email : `${email}#${brandId}`;
}
/**
 * Add a brand to the account. No plan limit (brands are unlimited on every plan); the caller has already checked the
 * creation rate (`brandAddRefusal`). `{ error: "busy" }` when the brand list's lock could not be taken.
 */
export async function addBrand(u: User, name: string): Promise<BrandMeta | { error: string }> {
  const b = await withBrandsLock(u.email, async (rows) => {
    const b: BrandMeta = { id: Math.random().toString(36).slice(2, 10), name: name.slice(0, 80) || "…", createdAt: new Date().toISOString(), status: "active" };
    rows.push(b);
    await saveBrands(u.email, rows);
    return b;
  });
  if (!b) return { error: "busy" };
  // The new brand becomes active for whoever added it (the acting login), not for the whole account.
  await setActiveBrand(u.actor?.email ?? u.email, b.id);
  return b;
}
