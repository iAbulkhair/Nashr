import { isWaiting, updateTask, type Task } from "./brand";
import { pmap } from "./parallel";

/**
 * "Not now" (rules 2340-2349, Fizzy's entropy pattern; study docs/reports/2026-10-19-PRD-fizzy-orca_AR.md, pattern 1).
 * An item nobody decided or touched for `NOT_NOW_DAYS` leaves the waiting list on its own and goes under "Not now": it
 * stays `pending`, nothing is deleted, published or charged, and one click brings it back. The owner hears about it once
 * at 75% of the time (`NOT_NOW_WARN_DAYS`) and once when it moves. 14 days is the founder's default of 2026-10-19.
 */
export const NOT_NOW_DAYS = 14;
/** The warning before the move: 75% of `NOT_NOW_DAYS`. */
export const NOT_NOW_WARN_DAYS = NOT_NOW_DAYS * 0.75;
const DAY = 864e5;

type Clocked = Pick<Task, "status" | "notNow" | "createdAt" | "touchedAt">;

/**
 * When the item's clock started: the latest of its creation, the last time a person touched it, and `from`, the
 * workspace's first daily run with this feature (`Schedule.notNowFrom`). The last one is why the release cannot empty a
 * backlog overnight: an item already 30 days old on release day gets its warning on day 11 after it, not a move on day 1.
 */
export function clockStart(t: Clocked, from?: string): number {
  return Math.max(0, ...[t.createdAt, t.touchedAt, from].map((x) => (x ? new Date(x).getTime() : 0)).filter((n) => Number.isFinite(n)));
}
/** Whole and partial days the item has waited untouched at `now`. */
export const idleDays = (t: Clocked, now: number, from?: string) => (now - clockStart(t, from)) / DAY;

/** Waiting items whose time is up: they move under "Not now" on this run. */
export const dueForNotNow = <T extends Clocked>(rows: readonly T[], now: number, from?: string): T[] =>
  rows.filter((t) => isWaiting(t) && idleDays(t, now, from) >= NOT_NOW_DAYS);
/** Waiting items past 75% of the time and not yet due: the owner is told before they move. */
export const soonNotNow = <T extends Clocked>(rows: readonly T[], now: number, from?: string): T[] =>
  rows.filter((t) => isWaiting(t) && idleDays(t, now, from) >= NOT_NOW_WARN_DAYS && idleDays(t, now, from) < NOT_NOW_DAYS);

/**
 * Move the due items of `scope` under "Not now", each under its own task lock and re-checked on the task as stored now,
 * so an approval, edit or "bring back" that landed after the light rows were read wins. Returns the ids that moved.
 * At most 8 locks at a time; a task whose lock times out is skipped and tried again tomorrow.
 */
export async function moveIdle(scope: string, rows: readonly (Clocked & { id: string })[], now: number, from?: string): Promise<string[]> {
  const at = new Date(now).toISOString();
  const moved = await pmap(dueForNotNow(rows, now, from), async (row) => {
    const t = await updateTask(scope, row.id, (t) => (isWaiting(t) && idleDays(t, now, from) >= NOT_NOW_DAYS ? { ...t, notNow: { at, by: "auto" } } : null)).catch(() => null);
    return t?.notNow?.by === "auto" && t.notNow.at === at ? t.id : null;
  }, 8);
  return moved.filter((id): id is string => !!id);
}
