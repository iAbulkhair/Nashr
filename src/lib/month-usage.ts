import type { User } from "./auth";
import { IMAGE_COST, listLite, TASK_COST, TASK_COUNT, type TaskType } from "./brand";
import { listBrands, scopeFor } from "./brands";
import { pmap } from "./parallel";

/** This month's usage on the account: per task type (items and credits), the items with a render, and what renders charged. */
export type MonthUsage = { usage: Record<string, { count: number; credits: number }>; images: number; mediaCredits: number; nextReset: string };

/**
 * The account's usage this month (UTC), as GET /api/profile has always answered it and the billing page's credit card
 * shows it (rule 1153). Every brand this account owns, not just the active one: credits are charged against the ACCOUNT,
 * so usage read from one brand scope beside the account balance disagreed with it (an agency with three brands saw
 * "10 / 2000 used" above "1970 left"). Scopes come from the account's own brand list (`u.email` from the session), never
 * from a request. Moved here from /api/profile unchanged.
 */
export async function monthUsage(u: Pick<User, "email">, now = new Date()): Promise<MonthUsage> {
  const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const scopes = (await listBrands(u.email)).map((b) => scopeFor(u.email, b.id));
  const lists = await pmap(scopes, (s) => listLite(s, monthStart));
  const tasks = lists.flat();
  const usage: Record<string, { count: number; credits: number }> = {};
  for (const t of tasks) {
    if (new Date(t.createdAt) < monthStart) continue;
    const k = t.type; usage[k] ??= { count: 0, credits: 0 }; usage[k].count++;
  }
  // credits are per batch; convert item counts back to credits via items-per-batch
  for (const k of Object.keys(usage)) { const t = k as TaskType; usage[k].credits = Math.round((usage[k].count / (TASK_COUNT[t] ?? 1)) * (TASK_COST[t] ?? 1)); }
  // Renders: the items with an image or a video this month, and what their renders really charged (`mediaCredits`, what
  // src/lib/media/jobs.ts kept after refunds: an image is 1 or 2 by model, a video 12 or 24), as the owner reports and the
  // founder overview count it. Rows from before mediaCredits existed fall back to the one image credit.
  const month = tasks.filter((t) => new Date(t.createdAt) >= monthStart);
  const images = month.filter((t) => t.image || t.video).length;
  const mediaCredits = Math.round(month.reduce((sum, t) => sum + (t.mediaCredits ?? (t.image ? IMAGE_COST : 0)), 0));
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return { usage, images, mediaCredits, nextReset };
}
