/**
 * The founder console's customers list and workspace page, the part that is arithmetic (rules 3720-3749, docs/system/flows.md
 * "Customers as workspaces"). Client-safe and pure: no database, no clock (every function takes `now`), so the numbers are
 * unit-tested and the console builds its URL with the same names the route reads. The reads live in src/lib/admin-workspaces.ts.
 *
 * What each number means (the same words the console shows):
 * - active in 7 days: the owner and the members who signed in, or whose name is on an activity row, in the last 7 days.
 *   Only people on the roster count: a founder's support access, a connected app, a cron and a removed member never do.
 * - tasks in 30 days: tasks created in the last 30 days across the account's brands.
 * - credits used this month: per task item (its type's cost divided by its batch size) plus what its renders kept, as the
 *   founder overview counts them (src/lib/admin-stats.ts), for tasks created since the first of the month (UTC).
 * - requested / completed / credits per member: from the activity rows of the account's own brands, by the login the row
 *   names (`by.email`): `generated` rows give the tasks and the credits charged, `decision` rows with the outcome
 *   `approve` give the tasks completed, and refunds are taken off. A row that names no login (system, support, app) is nobody's.
 */
import { PLANS, type Plan } from "./pricing";
import { pageOf } from "./admin-users";
import type { Activity } from "./activity";

export { pageOf };

export const WS_FILTERS = ["lowActivity", "nearSeats", "suspended", "trial"] as const;
export type WsFilter = (typeof WS_FILTERS)[number];
export const WS_SORTS = ["name", "plan", "seats", "active7", "tasks30", "credits", "lastActivity", "createdAt"] as const;
export type WsSort = (typeof WS_SORTS)[number];
export const WS_PAGE_SIZES = [25, 50, 100] as const;
/** The windows of the list's columns, in days. */
export const ACTIVE_DAYS = 7;
export const TASK_DAYS = 30;
/** "Near the seat limit": the plan holds more than one seat and at least this share of them is used or invited. */
export const NEAR_SEATS_SHARE = 0.8;

export type WsQuery = { q: string; plan: Plan | ""; filter: WsFilter | ""; sort: WsSort; dir: "asc" | "desc"; page: number; per: number };
export const DEFAULT_WS_QUERY: WsQuery = { q: "", plan: "", filter: "", sort: "lastActivity", dir: "desc", page: 1, per: 25 };

/** A query from URL parameters: unknown names fall back to the defaults, the text is cut to 120 characters. */
export function parseWsQuery(p: URLSearchParams): WsQuery {
  const pick = <T extends string>(v: string | null, list: readonly T[], d: T | ""): T | "" => (v && (list as readonly string[]).includes(v) ? (v as T) : d);
  const page = Math.trunc(Number(p.get("page") ?? 1));
  const per = Number(p.get("per") ?? DEFAULT_WS_QUERY.per);
  return {
    q: (p.get("q") ?? "").trim().slice(0, 120),
    plan: pick(p.get("plan"), PLANS, ""),
    filter: pick(p.get("filter"), WS_FILTERS, ""),
    sort: (pick(p.get("sort"), WS_SORTS, DEFAULT_WS_QUERY.sort) || DEFAULT_WS_QUERY.sort) as WsSort,
    dir: p.get("dir") === "asc" ? "asc" : p.get("dir") === "desc" ? "desc" : DEFAULT_WS_QUERY.dir,
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
    per: (WS_PAGE_SIZES as readonly number[]).includes(per) ? per : DEFAULT_WS_QUERY.per,
  };
}

/** The URL parameters of a query, defaults left out. */
export function wsQueryParams(q: WsQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.plan) p.set("plan", q.plan);
  if (q.filter) p.set("filter", q.filter);
  if (q.sort !== DEFAULT_WS_QUERY.sort) p.set("sort", q.sort);
  if (q.dir !== DEFAULT_WS_QUERY.dir) p.set("dir", q.dir);
  if (q.page !== 1) p.set("page", String(q.page));
  if (q.per !== DEFAULT_WS_QUERY.per) p.set("per", String(q.per));
  return p;
}

/** One row of the customers list: one workspace (account). */
export type WorkspaceRow = {
  /** The owner's sign-in address: the link to the workspace page (`/{lang}/admin/users/{email}`). */
  email: string;
  /** The brand's name, else the workspace name, else the owner's name. */
  name: string;
  ownerName: string;
  plan: string;
  suspended: boolean;
  seats: { used: number; limit: number };
  brands: { active: number; cap: number };
  active7: number;
  tasks30: number;
  credits: { used: number; allowance: number };
  lastActivityAt: string | null;
  createdAt: string;
  /** Set when the search was a member's address: the role that person holds here (a stored word, shown through `roleLabel`). */
  asRole?: string;
};

/** True when the workspace has the named state. */
export function rowHasFilter(r: WorkspaceRow, f: WsFilter): boolean {
  switch (f) {
    case "lowActivity": return r.active7 === 0;
    case "nearSeats": return r.seats.limit > 1 && r.seats.used / r.seats.limit >= NEAR_SEATS_SHARE;
    case "suspended": return r.suspended;
    case "trial": return r.plan === "trial";
  }
}

/**
 * True when the row passes the plan, state and text filters. `hits` is the set of owner addresses a searched member
 * address resolved to (`memberHits`, src/lib/admin-workspaces.ts): those rows pass the text filter whatever they say.
 */
export function matchRow(r: WorkspaceRow, q: WsQuery, hits: ReadonlySet<string> = new Set()): boolean {
  if (q.plan && r.plan !== q.plan) return false;
  if (q.filter && !rowHasFilter(r, q.filter)) return false;
  if (q.q) {
    if (hits.has(r.email)) return true;
    const t = q.q.toLowerCase();
    if (![r.email, r.name, r.ownerName, r.plan].some((x) => (x ?? "").toLowerCase().includes(t))) return false;
  }
  return true;
}

/** Sorted copy: the chosen column, then the owner's address so equal values keep one order. Missing dates sort as oldest. */
export function sortRows(list: readonly WorkspaceRow[], sort: WsSort, dir: "asc" | "desc"): WorkspaceRow[] {
  const k = (r: WorkspaceRow): string | number => {
    switch (sort) {
      case "name": return r.name.toLowerCase();
      case "plan": return PLANS.indexOf(r.plan as Plan);
      case "seats": return r.seats.used;
      case "active7": return r.active7;
      case "tasks30": return r.tasks30;
      case "credits": return r.credits.used;
      case "lastActivity": return r.lastActivityAt ?? "";
      case "createdAt": return r.createdAt;
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = k(a), y = k(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
}

/** How many workspaces each plan and each state would show, over those that pass the text filter only. */
export function rowFacets(list: readonly WorkspaceRow[], q: WsQuery, hits: ReadonlySet<string> = new Set()) {
  const base = list.filter((r) => matchRow(r, { ...q, plan: "", filter: "" }, hits));
  const plan: Record<string, number> = {};
  for (const p of PLANS) plan[p] = 0;
  for (const r of base) plan[r.plan] = (plan[r.plan] ?? 0) + 1;
  const filter = {} as Record<WsFilter, number>;
  for (const f of WS_FILTERS) filter[f] = base.filter((r) => rowHasFilter(r, f)).length;
  return { all: base.length, plan, filter };
}

// ---- Activity rows: who did what ------------------------------------------------------------------------------------

/** What the math reads of an activity row. */
export type ActRow = Pick<Activity, "at" | "kind" | "by" | "count" | "tasks" | "credits" | "refunded" | "outcome">;

/** Row kinds that charge credits to whoever's name is on them. `render_done` is left out: its price is the one `image_started` charged. */
const CHARGED = new Set<string>(["generated", "image_started", "onboard_charged", "instructions_tested", "revised"]);

/** The login an activity row names: the owner's or a member's address, lower case. Support, apps and system jobs name nobody. */
export function personOf(by: ActRow["by"] | undefined): string | null {
  if (!by || (by.kind !== "owner" && by.kind !== "member")) return null;
  return typeof by.email === "string" && by.email ? by.email.trim().toLowerCase() : null;
}

const within = (iso: string, now: number, days: number) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now && t > now - days * 864e5;
};

/** Credits a row moved: charges count, a refund or a failed render that went back counts against. Never NaN. */
export function rowCredits(r: ActRow): number {
  const c = typeof r.credits === "number" && Number.isFinite(r.credits) ? r.credits : 0;
  if (CHARGED.has(r.kind)) return c;
  if (r.kind === "onboard_refunded") return -c;
  if (r.kind === "render_failed" && r.refunded) return -c;
  return 0;
}

export type MemberStats = { requested: number; completed: number; credits: number; lastActionAt: string | null };
const none = (): MemberStats => ({ requested: 0, completed: 0, credits: 0, lastActionAt: null });

/**
 * Each roster login's work in the last `days` days (30 for the workspace page), from the activity rows of the account's
 * own brands. Only addresses in `roster` get a line, so a row naming a person who is not on this account's roster (a removed
 * member, or the same address acting in another workspace, whose rows are in another scope and never passed here) adds nothing.
 */
export function memberStats(rows: readonly ActRow[], roster: readonly string[], now: number, days = TASK_DAYS): Record<string, MemberStats> {
  const out: Record<string, MemberStats> = {};
  for (const e of roster) out[e.toLowerCase()] = none();
  for (const r of rows) {
    const who = personOf(r.by);
    if (!who || !out[who] || !within(r.at, now, days)) continue;
    const s = out[who];
    if (r.kind === "generated") s.requested += Math.max(0, r.count ?? r.tasks?.length ?? 1);
    if (r.kind === "decision" && r.outcome === "approve") s.completed += Math.max(0, r.tasks?.length ?? r.count ?? 1);
    s.credits += rowCredits(r);
    if (!s.lastActionAt || r.at > s.lastActionAt) s.lastActionAt = r.at;
  }
  for (const s of Object.values(out)) s.credits = Math.round(s.credits * 100) / 100;
  return out;
}

/**
 * The roster logins active in the last `days` days: an activity row naming them, or a sign-in (`signIns`: login to epoch ms).
 * Roster only, as above.
 */
export function activeLogins(rows: readonly ActRow[], signIns: Readonly<Record<string, number | null>>, roster: readonly string[], now: number, days = ACTIVE_DAYS): string[] {
  const set = new Set(roster.map((e) => e.toLowerCase()));
  const active = new Set<string>();
  for (const r of rows) {
    const who = personOf(r.by);
    if (who && set.has(who) && within(r.at, now, days)) active.add(who);
  }
  for (const [login, at] of Object.entries(signIns)) {
    const e = login.toLowerCase();
    if (set.has(e) && typeof at === "number" && at <= now && at > now - days * 864e5) active.add(e);
  }
  return [...active];
}

/** The latest moment of customer activity: sign-ins, the owner's last seen, and rows naming the owner, a member or a connected app. */
export function lastActivity(rows: readonly ActRow[], times: readonly (string | number | null | undefined)[]): string | null {
  let best = 0;
  for (const t of times) {
    const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  for (const r of rows) {
    if (r.by?.kind !== "owner" && r.by?.kind !== "member" && r.by?.kind !== "token") continue;
    const ms = Date.parse(r.at);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return best > 0 ? new Date(best).toISOString() : null;
}

/** A task as the day series reads it: when it was made and the credits it cost (items and renders). */
export type DayItem = { createdAt: string; credits: number };

/** The last `days` UTC days, oldest first, each with its task count and credits. A day with nothing is a zero line, not a gap. */
export function daySeries(items: readonly DayItem[], now: number, days = TASK_DAYS): { day: string; tasks: number; credits: number }[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const end = Date.parse(today + "T00:00:00.000Z");
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(end - (days - 1 - i) * 864e5).toISOString().slice(0, 10), tasks: 0, credits: 0 }));
  const at = new Map(out.map((d, i) => [d.day, i]));
  for (const it of items) {
    const i = at.get(it.createdAt.slice(0, 10));
    if (i === undefined) continue;
    out[i].tasks += 1;
    out[i].credits += Number.isFinite(it.credits) ? it.credits : 0;
  }
  for (const d of out) d.credits = Math.round(d.credits * 100) / 100;
  return out;
}
