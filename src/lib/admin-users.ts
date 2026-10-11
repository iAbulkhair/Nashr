/**
 * The founder console's Users table, filtered, sorted and paged on the server (rule 1178). Client-safe (no imports
 * beyond types and pricing): the console builds its URL with the same names the route reads.
 *
 * The route filters and sorts on the stored account fields only, then reads usage and chat for the page's rows alone,
 * so a page of 25 costs 25 usage reads, not one per account.
 */
import { PLANS, type Plan } from "./pricing";

export const USER_FILTERS = ["suspended", "unverified", "trialEnding", "lowCredits"] as const;
export type UserFilter = (typeof USER_FILTERS)[number];
export const USER_SORTS = ["createdAt", "email", "credits", "plan", "trialEnds"] as const;
export type UserSort = (typeof USER_SORTS)[number];
export const USER_PAGE_SIZES = [25, 50, 100] as const;
/** "Low credits": fewer than this many left (plan and top-up credits together, as `credits` holds them). */
export const LOW_CREDITS = 20;
/** "Trial ending": a trial whose end is within this many hours and not past. */
export const TRIAL_ENDING_HOURS = 24;

export type UserQuery = { q: string; plan: Plan | ""; filter: UserFilter | ""; sort: UserSort; dir: "asc" | "desc"; page: number; per: number };
/** What the route needs of an account to filter and sort it. */
export type UserFacts = { email: string; name?: string; phone?: string; plan: string; credits: number; trialEnds: string; createdAt: string; suspended?: boolean; emailVerifiedAt?: string | null };

export const DEFAULT_USER_QUERY: UserQuery = { q: "", plan: "", filter: "", sort: "createdAt", dir: "desc", page: 1, per: 25 };

/** A query from URL parameters: unknown names fall back to the defaults, the text is cut to 120 characters. */
export function parseUserQuery(p: URLSearchParams): UserQuery {
  const pick = <T extends string>(v: string | null, list: readonly T[], d: T | ""): T | "" => (v && (list as readonly string[]).includes(v) ? (v as T) : d);
  const page = Math.trunc(Number(p.get("page") ?? 1));
  const per = Number(p.get("per") ?? DEFAULT_USER_QUERY.per);
  return {
    q: (p.get("q") ?? "").trim().slice(0, 120),
    plan: pick(p.get("plan"), PLANS, ""),
    filter: pick(p.get("filter"), USER_FILTERS, ""),
    sort: (pick(p.get("sort"), USER_SORTS, "createdAt") || "createdAt") as UserSort,
    dir: p.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
    per: (USER_PAGE_SIZES as readonly number[]).includes(per) ? per : DEFAULT_USER_QUERY.per,
  };
}

/** The URL parameters of a query, defaults left out, so the address bar holds only what was chosen. */
export function userQueryParams(q: UserQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.plan) p.set("plan", q.plan);
  if (q.filter) p.set("filter", q.filter);
  if (q.sort !== DEFAULT_USER_QUERY.sort) p.set("sort", q.sort);
  if (q.dir !== DEFAULT_USER_QUERY.dir) p.set("dir", q.dir);
  if (q.page !== 1) p.set("page", String(q.page));
  if (q.per !== DEFAULT_USER_QUERY.per) p.set("per", String(q.per));
  return p;
}

/** True when the account has the named state at `now`. */
export function hasFilter(u: UserFacts, f: UserFilter, now = Date.now()): boolean {
  switch (f) {
    case "suspended": return !!u.suspended;
    case "unverified": return !u.emailVerifiedAt;
    case "trialEnding": {
      const end = new Date(u.trialEnds).getTime();
      return u.plan === "trial" && end > now && end - now <= TRIAL_ENDING_HOURS * 3600_000;
    }
    case "lowCredits": return u.credits < LOW_CREDITS;
  }
}

/** True when the account passes the text, plan and state filters. */
export function matchUser(u: UserFacts, q: UserQuery, now = Date.now()): boolean {
  if (q.plan && u.plan !== q.plan) return false;
  if (q.filter && !hasFilter(u, q.filter, now)) return false;
  if (q.q) {
    const t = q.q.toLowerCase();
    if (![u.email, u.name, u.phone, u.plan].some((x) => (x ?? "").toLowerCase().includes(t))) return false;
  }
  return true;
}

/** Sorted copy: the chosen field, then the email so equal values keep one order. */
export function sortUsers<T extends UserFacts>(list: T[], sort: UserSort, dir: "asc" | "desc"): T[] {
  const k = (u: T): string | number => (sort === "credits" ? u.credits : sort === "plan" ? PLANS.indexOf(u.plan as Plan) : (u[sort] ?? ""));
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = k(a), y = k(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
}

/** How many accounts each plan and each state chip would show, over the accounts that pass the text filter only. */
export function userFacets(list: UserFacts[], q: UserQuery, now = Date.now()) {
  const base = list.filter((u) => matchUser(u, { ...q, plan: "", filter: "" }, now));
  const plan: Record<string, number> = {};
  for (const p of PLANS) plan[p] = 0;
  for (const u of base) plan[u.plan] = (plan[u.plan] ?? 0) + 1;
  const filter = {} as Record<UserFilter, number>;
  for (const f of USER_FILTERS) filter[f] = base.filter((u) => hasFilter(u, f, now)).length;
  return { all: base.length, plan, filter };
}

/** The account tiles over every account (the table pages; the tiles never do): live paying, live trial, today, suspended. */
export function tileCounts(list: UserFacts[], now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const live = list.filter((u) => !u.suspended);
  return {
    users: list.length,
    paying: live.filter((u) => u.plan !== "trial").length,
    trial: live.filter((u) => u.plan === "trial").length,
    today: list.filter((u) => u.createdAt.slice(0, 10) === day).length,
    suspended: list.length - live.length,
  };
}
export type TileCounts = ReturnType<typeof tileCounts>;

/** The page's slice and the number of pages. A page past the end gives the last page. */
export function pageOf<T>(list: T[], page: number, per: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / per));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: list.slice((p - 1) * per, p * per), page: p, pages };
}
