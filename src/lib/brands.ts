import { db } from "./db";
import type { User } from "./auth";
import { brandCapFor } from "./pricing";
import { log } from "./log";
import { accountKey, personKey, workspaceScope, type AccountId, type PersonId } from "./keys";
import { ActiveBrandId, brandRows, parseStored } from "./stored";
import { acct } from "./account-id";
import { aidOf, ownerOf } from "./membership";

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
  return brandsFromRaw(await db.get<unknown>(accountKey.brands(email)));
}
/** `listBrands` over a raw `brands:{aid}` value a caller read in its own round (`resolveSession`). */
export function brandsFromRaw(raw: unknown): BrandMeta[] {
  // Checked row by row (rule 2036): a row without an id is left out and logged, never thrown on.
  const rows: BrandMeta[] = brandRows(raw);
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
 * LEGACY, for the session written before R1 only (`resolveSession`'s legacy-shape path, rule 2135): the active brand
 * per LOGIN, `activebrand:{loginEmail}`. Every other caller uses `activeBrandIn` / `setActiveBrandIn`, which key the
 * choice by person AND account (rule 2119) and still read and write this key for the person's home account, so a
 * legacy session and a rollback see the current choice.
 */
export async function activeBrandId(email: string) {
  // Rule 2037: a missing or malformed value is the default brand; a numeric-looking id read back as a number is text again.
  return parseStored("activebrand", ActiveBrandId, await db.get<unknown>(accountKey.activeBrand(email)), "default");
}
/** LEGACY writer of `activebrand:{loginEmail}`, kept for its tests only; product code calls `setActiveBrandIn`. */
export async function setActiveBrand(email: string, id: string) {
  await db.set(accountKey.activeBrand(email), id);
}

/**
 * The active brand of one person in one account (multi-workspace membership, rules 2119, 2132), pure over the raw
 * values. In the person's HOME account (`home`: a legacy owner's own account, a legacy member's `memberOf`) the legacy
 * `activebrand:{login}` when it holds a valid id, else `activebrand:{pid}:{aid}`; in any other account only
 * `activebrand:{pid}:{aid}`; else "default". A brand chosen in B is never read in A, and the legacy key is never read
 * for an account that is not home. In the home account `setActiveBrandIn` writes both keys with the same value, so they
 * differ only when a build before M1 (a rollback) wrote the legacy key afterwards: that later choice wins, and a roll
 * forward never brings back the older one. The caller still checks the id is an active brand of the account.
 */
export function activeBrandFrom(rawNew: unknown, rawLegacy: unknown, home: boolean): string {
  const legacy = home ? parseStored("activebrand", ActiveBrandId, rawLegacy, null) : null;
  return legacy ?? parseStored("activebrand", ActiveBrandId, rawNew, "default");
}
/**
 * `activeBrandFrom` over its keys, in ONE round. `homeLogin` is the person's sign-in address when `aid` is their home
 * account (a legacy owner's own account, a legacy member's `memberOf`: `brandChooser`, `ownerChooser`), else null.
 */
export async function activeBrandIn(pid: PersonId, aid: AccountId, homeLogin: string | null): Promise<string> {
  const [fresh, legacy] = await Promise.all([db.get<unknown>(personKey.activeBrand(pid, aid)), homeLogin ? db.get<unknown>(accountKey.activeBrand(homeLogin)) : Promise.resolve(null)]);
  return activeBrandFrom(fresh, legacy, homeLogin !== null);
}
/**
 * Choose the active brand of one person in one account: `activebrand:{pid}:{aid}`, and for the home account the legacy
 * `activebrand:{homeLogin}` beside it in the same round, so a session written before R1 and a rolled-back build read
 * the same choice. Never another account's key.
 */
export async function setActiveBrandIn(pid: PersonId, aid: AccountId, id: string, homeLogin: string | null): Promise<void> {
  await Promise.all([db.set(personKey.activeBrand(pid, aid), id), ...(homeLogin ? [db.set(accountKey.activeBrand(homeLogin), id)] : [])]);
}
/**
 * Whose active brand a request moves: the acting person in the active account, with the legacy key's login when that
 * account is their home (`Actor.home`). A user with no actor (a server job holding the account) is the owner: a legacy
 * owner's home is their own account, a `p_` owner has no legacy key.
 */
export function brandChooser(u: User): { pid: PersonId; aid: AccountId; homeLogin: string | null } {
  const aid = aidOf(u);
  if (u.actor) return { pid: u.actor.pid, aid, homeLogin: u.actor.home ? u.actor.email : null };
  return ownerChooser(u);
}
/** The OWNER's active brand in this account (the archive path resets it when a member archives it). */
export function ownerChooser(u: User): { pid: PersonId; aid: AccountId; homeLogin: string | null } {
  // A legacy owner (no `ownerPid`) is the person `acct(u)`, and this account is their home: its address is the login.
  return { pid: ownerOf(u), aid: aidOf(u), homeLogin: u.ownerPid === undefined ? u.email : null };
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
  const b = await withBrandsLock(acct(u), async (rows): Promise<BrandMeta | BrandLimit> => {
    const over = brandLimitRefusal(u, rows);
    if (over) return over;
    const b: BrandMeta = { id: Math.random().toString(36).slice(2, 10), name: name.slice(0, 80) || "…", createdAt: new Date().toISOString(), status: "active" };
    rows.push(b);
    await saveBrands(acct(u), rows);
    return b;
  });
  if (!b) return { error: "busy" };
  if ("error" in b) return b;
  // The new brand becomes active for whoever added it (the acting person, in this account), not for the whole account.
  const who = brandChooser(u);
  await setActiveBrandIn(who.pid, who.aid, b.id, who.homeLogin);
  return b;
}
