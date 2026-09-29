import { db } from "./db";
import type { Plan, User } from "./auth";

/**
 * Multi-brand workspaces. Every brand-scoped record (brand file, tasks, files, chat, governance,
 * schedule, connections) is keyed by a *scope*: the default brand's scope is the user's email
 * (backward compatible); extra brands use `${email}#${brandId}`.
 */
export type BrandMeta = { id: string; name: string; createdAt: string; status: "active" | "archived" };

export const BRAND_LIMIT: Record<Plan, number> = { trial: 1, starter: 1, pro: 1, agency: 5, enterprise: 99 };

export async function listBrands(email: string): Promise<BrandMeta[]> {
  const rows = (await db.get<BrandMeta[]>(`brands:${email}`)) ?? [];
  if (!rows.find((b) => b.id === "default")) rows.unshift({ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" });
  return rows;
}
export async function saveBrands(email: string, rows: BrandMeta[]) {
  await db.set(`brands:${email}`, rows);
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
export async function addBrand(u: User, name: string): Promise<BrandMeta | { error: string }> {
  const rows = await listBrands(u.email);
  const active = rows.filter((b) => b.status === "active").length;
  if (active >= (BRAND_LIMIT[u.plan] ?? 1)) return { error: "limit" };
  const b: BrandMeta = { id: Math.random().toString(36).slice(2, 10), name: name.slice(0, 80) || "…", createdAt: new Date().toISOString(), status: "active" };
  rows.push(b);
  await saveBrands(u.email, rows);
  // The new brand becomes active for whoever added it (the acting login), not for the whole account.
  await setActiveBrand(u.actor?.email ?? u.email, b.id);
  return b;
}
