import { db } from "./db";
import type { User } from "./auth";
import { brandCapFor } from "./pricing";
import { log } from "./log";
import { accountKey, workspaceScope } from "./keys";
import { ActiveBrandId, brandRows, parseStored } from "./stored";

/**
 * Multi-brand workspaces. Every brand-scoped record (brand file, tasks, files, chat, governance,
 * schedule, connections) is keyed by a *scope*: the default brand's scope is the user's email
 * (backward compatible); extra brands use `${email}#${brandId}`.
 *
 * Active brands are capped per plan (rules 1390-1392, replacing rule 245's "unlimited"): `brandCapFor` in
 * src/lib/pricing.ts (1/1/2/5 for trial/starter/pro/business, Agency 10 or the founder's `User.brandCap`). The cap is
 * checked inside `withBrandsLock`, so two adds side by side cannot both pass, and it only refuses a NEW active brand (an
 * add, or a restore of an archived one): an account above its cap after a downgrade keeps every brand working, and
 * nothing is ever archived or deleted for the cap. The creation rate (`brandAddRefusal` in src/lib/rate.ts) still runs
 * first. An added brand's onboarding costs ONBOARD_EXTRA_BRAND_COST credits (src/app/api/onboard/route.ts) and its
 * Sunday plan is off until the owner switches it on (src/lib/schedule.ts `getSchedule`). Rules 246-247,
 * tests/brand-guardrails.test.ts.
 */
export type BrandMeta = { id: string; name: string; createdAt: string; status: "active" | "archived" };

export async function listBrands(email: string): Promise<BrandMeta[]> {
  // Checked row by row (rule 2036): a row without an id is left out and logged, never thrown on.
  const rows: BrandMeta[] = brandRows(await db.get<unknown>(accountKey.brands(email)));
  if (!rows.find((b) => b.id === "default")) rows.unshift({ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" });
  return rows;
}
export async function saveBrands(email: string, rows: BrandMeta[]) {
  await db.set(accountKey.brands(email), rows);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Read-modify-write of the account's brand list (`brands:{email}`) under `brandslock:{email}`, waiting about a second
 * for it (20 × 50 ms). Two adds, or an add and a rename, sent side by side used to each read the list, change their
 * copy and save it, so the second save dropped the first one's brand. Null when the lock could not be taken: nothing
 * was written, and the caller answers "busy". Always released.
 */
export async function withBrandsLock<T>(email: string, fn: (rows: BrandMeta[]) => Promise<T>): Promise<T | null> {
  const key = accountKey.brandsLock(email);
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
    await db.unlock(key).catch((e) => log.error("brands lock release failed", e));
  }
}

/**
 * The active brand is per LOGIN (`activebrand:{loginEmail}`): the owner's key is unchanged, and each member has their
 * own, so one person switching brands never moves the owner, the other members or the owner's MCP token. Pass the
 * actor's email (`u.actor?.email ?? u.email`), never the account email for a member. `currentUser` validates a member's
 * value against the owner's active brands.
 */
export async function activeBrandId(email: string) {
  // Rule 2037: a missing or malformed value is the default brand; a numeric-looking id read back as a number is text again.
  return parseStored("activebrand", ActiveBrandId, await db.get<unknown>(accountKey.activeBrand(email)), "default");
}
export async function setActiveBrand(email: string, id: string) {
  await db.set(accountKey.activeBrand(email), id);
}
/** Plain-string form of `workspaceScope` (src/lib/keys.ts), for code that compares scopes as strings. Keys take the branded one. */
export function scopeFor(email: string, brandId: string): string {
  return workspaceScope(email, brandId);
}
/** Brands that count against the cap: the active ones, the default brand included. */
export const activeCount = (rows: BrandMeta[]) => rows.filter((b) => b.status === "active").length;

/** Refused for the plan's brand cap (rule 1391): what the route answers as 402 `brand_limit`. */
export type BrandLimit = { error: "brand_limit"; cap: number; count: number };
/** Null when one more active brand fits under the cap, else the refusal. Read on the list as it is under the lock. */
export function brandLimitRefusal(u: Pick<User, "plan" | "brandCap">, rows: BrandMeta[]): BrandLimit | null {
  const cap = brandCapFor(u);
  const count = activeCount(rows);
  return count >= cap ? { error: "brand_limit", cap, count } : null;
}

/**
 * Add a brand to the account, under the plan's brand cap (rule 1391): the count is read inside the list's lock, so two
 * adds side by side cannot both pass, and over the cap nothing is written. The caller has already checked the creation
 * rate (`brandAddRefusal`). `{ error: "busy" }` when the brand list's lock could not be taken.
 */
export async function addBrand(u: User, name: string): Promise<BrandMeta | BrandLimit | { error: "busy" }> {
  const b = await withBrandsLock(u.email, async (rows): Promise<BrandMeta | BrandLimit> => {
    const over = brandLimitRefusal(u, rows);
    if (over) return over;
    const b: BrandMeta = { id: Math.random().toString(36).slice(2, 10), name: name.slice(0, 80) || "…", createdAt: new Date().toISOString(), status: "active" };
    rows.push(b);
    await saveBrands(u.email, rows);
    return b;
  });
  if (!b) return { error: "busy" };
  if ("error" in b) return b;
  // The new brand becomes active for whoever added it (the acting login), not for the whole account.
  await setActiveBrand(u.actor?.email ?? u.email, b.id);
  return b;
}
