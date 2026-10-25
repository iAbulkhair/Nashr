import { acct, getLogin, getUser, normalizeEmail, type User } from "./auth";
import { getBrand, IMAGE_COST, listLite, TASK_COST, TASK_COUNT, type TaskLite } from "./brand";
import { listBrands, scopeFor, type BrandMeta } from "./brands";
import { CAPS, db } from "./db";
import { lastSignIn } from "./devices";
import { getMembership } from "./membership";
import { pmap } from "./parallel";
import { allowanceOf, brandCapFor, priceOf, seatLimit } from "./pricing";
import { isSuspended } from "./suspension";
import { heldAnywhere, listMembers, peekInvites } from "./team";
import { lastActive } from "./track";
import { recentActivity, type Activity } from "./activity";
import { globalKey } from "./keys";
import { accountForChosen, viewOf, type WorkspaceView } from "./admin-workspace";
import { handlesReady, wsHandle } from "./ws-handle";
import {
  ACTIVE_DAYS, TASK_DAYS, activeLogins, daySeries, lastActivity, matchRow, memberStats, pageOf, rowFacets, sortRows,
  type MemberStats, type WorkspaceRow, type WsQuery,
} from "./admin-workspaces-math";

/**
 * The founder console's customers (rules 3720-3749, docs/system/flows.md "Customers as workspaces"): the list with one row per
 * workspace (account) and the workspace page's numbers. Read only: nothing here writes except the list's own cache.
 *
 * Tenant isolation. Staff choose an address or a page; every key after that is built from a stored account record (the ids of
 * `users:all`, the owner's `acct`, the brands of that account's own list) and the stored roster, never from the request. A
 * member's numbers come from the activity rows of THIS account's brands (`activity:{scope}` is per brand), and only the logins on
 * this account's roster get a line, so the same person acting in another workspace adds nothing here. A member's address in the
 * search box only picks the person (`getLogin`); the workspaces it lists are that person's own (`heldAnywhere`).
 *
 * The scan. The list needs the same few numbers for every account, and reading them costs a dozen commands per account
 * (members, invites, brands, the task months, the newest activity rows, sign-ins). They are computed on demand for all accounts
 * at once through `pmap` and kept in one JSON key for five minutes (`globalKey.workspaceAgg`): the founder's next page, sort or
 * filter within five minutes costs one read, and "Refresh" rebuilds it. Plan, state, seat limit, brand cap and allowance are
 * never cached: they come from the account record the list reads anyway. A daily cron that fills the same key is the next step
 * when the accounts pass about five hundred (the rebuild then takes more than a few seconds); nothing else changes.
 */

/** How long a cached aggregate is served. */
export const AGG_TTL_MS = 5 * 60_000;
/** Newest activity rows read per brand for the list (who was active, the last action): bounded, so a busy brand costs one short read. */
export const LIST_ROWS = 300;
/** Log rows on the workspace page. */
export const LOG_ROWS = 100;

/** What is kept per account: numbers and the display name, no address of a member. */
export type WsAgg = { name: string; ownerName: string; seatsUsed: number; brandsActive: number; active7: number; tasks30: number; creditsUsed: number; lastActivityAt: string | null };
type Cache = { at: number; rows: Record<string, WsAgg> };

const isAgg = (v: unknown): v is WsAgg => {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.name === "string" && typeof a.ownerName === "string" && (["seatsUsed", "brandsActive", "active7", "tasks30", "creditsUsed"] as const).every((k) => typeof a[k] === "number" && Number.isFinite(a[k] as number)) && (a.lastActivityAt === null || typeof a.lastActivityAt === "string");
};
const isCache = (v: unknown): v is Cache => !!v && typeof v === "object" && typeof (v as Cache).at === "number" && !!(v as Cache).rows && typeof (v as Cache).rows === "object";

/** Credits one light task cost: its item's share of the batch price plus what its renders kept (as src/lib/admin-stats.ts counts them). */
export const liteCredits = (t: Pick<TaskLite, "type" | "image" | "mediaCredits">): number => (TASK_COST[t.type] ?? 1) / (TASK_COUNT[t.type] ?? 1) + (t.mediaCredits ?? (t.image ? IMAGE_COST : 0));

const monthStartOf = (now: number) => { const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
const displayName = (u: User, brandName: string | undefined) => brandName?.trim() || u.workspaceName?.trim() || u.name || u.email;

/** What one account's reads give, before any arithmetic: the same for the list's aggregate and the workspace page. */
async function readAccount(u: User, now: number, rowsPerBrand: number) {
  const aid = acct(u);
  const brands = await listBrands(aid);
  const scopes = brands.map((b) => scopeFor(aid, b.id));
  const since = new Date(Math.min(monthStartOf(now), now - TASK_DAYS * 864e5));
  const [members, invites, brand, ownerSignIn, ownerSeen, lites, acts] = await Promise.all([
    listMembers(aid), peekInvites(aid), getBrand(aid), lastSignIn(u.email), lastActive(u.email),
    pmap(scopes, (s) => listLite(s, since)), pmap(scopes, (s) => recentActivity(s, rowsPerBrand)),
  ]);
  const memberSignIns = await pmap(members, (m) => lastSignIn(m.email));
  return { aid, brands, scopes, members, invites, brandName: brand?.name, ownerSignIn, ownerSeen, lites, acts, memberSignIns };
}
type Read = Awaited<ReturnType<typeof readAccount>>;

/** The list's numbers for one account, from its own reads. Exported for the tests. */
export function aggOf(u: User, r: Read, now: number): WsAgg {
  const live = r.members.filter((m) => !m.disabled);
  const roster = [normalizeEmail(u.email), ...live.map((m) => normalizeEmail(m.email))];
  const signIns: Record<string, number | null> = { [normalizeEmail(u.email)]: r.ownerSignIn };
  r.members.forEach((m, i) => { signIns[normalizeEmail(m.email)] = r.memberSignIns[i]; });
  const rows = r.acts.flat();
  const tasks = r.lites.flat();
  const from30 = now - TASK_DAYS * 864e5;
  const month = monthStartOf(now);
  return {
    name: displayName(u, r.brandName), ownerName: u.name,
    seatsUsed: 1 + live.length + r.invites.length,
    brandsActive: r.brands.filter((b: BrandMeta) => b.status === "active").length,
    active7: activeLogins(rows, signIns, roster, now, ACTIVE_DAYS).length,
    tasks30: tasks.filter((t) => Date.parse(t.createdAt) >= from30).length,
    creditsUsed: Math.round(tasks.filter((t) => Date.parse(t.createdAt) >= month).reduce((s, t) => s + liteCredits(t), 0)),
    lastActivityAt: lastActivity(rows, [r.ownerSignIn, r.ownerSeen, ...r.memberSignIns]),
  };
}

/**
 * The aggregates of every account: the cached ones while they are under five minutes old and cover every account, else
 * rebuilt for all of them in one bounded round and saved. `refresh` forces the rebuild. A failed save never fails the list.
 */
export async function loadAggregates(accounts: readonly User[], now: number, refresh = false): Promise<{ rows: Record<string, WsAgg>; at: number }> {
  if (!refresh) {
    const cached = await db.get<unknown>(globalKey.workspaceAgg()).catch(() => null);
    if (isCache(cached) && now - cached.at < AGG_TTL_MS && now >= cached.at && accounts.every((u) => isAgg(cached.rows[acct(u)]))) return cached;
  }
  const built = await pmap(accounts, async (u) => [acct(u), aggOf(u, await readAccount(u, now, LIST_ROWS), now)] as const, 12);
  const out: Cache = { at: now, rows: Object.fromEntries(built) };
  await db.set(globalKey.workspaceAgg(), out, 3600).catch(() => undefined);
  return out;
}

/**
 * A member's address in the search box: the person it signs in as and the role they hold in each workspace they own or belong
 * to, paused memberships included (`heldAnywhere`). Null when the text is not an address any login answers to.
 */
export async function memberHits(text: string): Promise<{ person: { email: string; name: string }; roles: Map<string, string> } | null> {
  if (!text.includes("@")) return null;
  const email = normalizeEmail(text);
  if (!email) return null;
  const login = await getLogin(email);
  if (!login) return null;
  const held = await heldAnywhere(login.pid);
  const roles = new Map<string, string>();
  await Promise.all(held.map(async ({ aid, owner }) => { roles.set(aid, owner ? "owner" : (await getMembership(aid, login.pid))?.role ?? "member"); }));
  return { person: { email: normalizeEmail(login.person.email), name: login.person.name }, roles };
}

/** The list row of an account: the cached numbers and the live record's plan, state, limits and allowance. */
export function rowOf(u: User, a: WsAgg, role?: string): WorkspaceRow {
  return {
    email: u.email, ...(handlesReady() ? { handle: wsHandle(acct(u)) } : {}), name: a.name, ownerName: a.ownerName, plan: u.plan, suspended: isSuspended(u),
    seats: { used: a.seatsUsed, limit: seatLimit(u) }, brands: { active: a.brandsActive, cap: brandCapFor(u) },
    active7: a.active7, tasks30: a.tasks30, credits: { used: a.creditsUsed, allowance: allowanceOf(u) },
    lastActivityAt: a.lastActivityAt, createdAt: u.createdAt, ...(role ? { asRole: role } : {}),
  };
}

export type WorkspaceList = {
  rows: WorkspaceRow[]; matched: number; page: number; pages: number; per: number;
  facets: ReturnType<typeof rowFacets>;
  tiles: { workspaces: number; paying: number; trial: number; suspended: number };
  /** The person a searched address resolved to; the route writes the audit row for it. */
  person: { email: string; name: string } | null;
  /** When the numbers were computed (ISO). */
  asOf: string;
};

/**
 * The customers list for a query: every account is read once (one `getUser` each, `pmap`), the numbers come from the cache or
 * a rebuild, the filters and the sort run on rows, and the page is cut last.
 */
export async function workspaceList(q: WsQuery, opts: { now?: number; refresh?: boolean } = {}): Promise<WorkspaceList> {
  const now = opts.now ?? Date.now();
  const ids = await db.smembers(globalKey.usersAll());
  const accounts = (await pmap(ids, (id) => getUser(id))).filter((u): u is User => !!u);
  const [agg, hit] = await Promise.all([loadAggregates(accounts, now, !!opts.refresh), q.q ? memberHits(q.q) : Promise.resolve(null)]);
  const all = accounts.map((u) => rowOf(u, agg.rows[acct(u)], hit?.roles.get(acct(u))));
  const hits = new Set(all.filter((r) => r.asRole).map((r) => r.email));
  const matched = sortRows(all.filter((r) => matchRow(r, q, hits)), q.sort, q.dir);
  const pg = pageOf(matched, q.page, q.per);
  const live = all.filter((r) => !r.suspended);
  return {
    rows: pg.rows, matched: matched.length, page: pg.page, pages: pg.pages, per: q.per, facets: rowFacets(all, q, hits),
    tiles: { workspaces: all.length, paying: live.filter((r) => r.plan !== "trial").length, trial: live.filter((r) => r.plan === "trial").length, suspended: all.length - live.length },
    person: hit?.person ?? null, asOf: new Date(agg.at).toISOString(),
  };
}

// ---- The workspace page ----------------------------------------------------------------------------------------------

export type TeamLine = MemberStats & { email: string; name: string; role: string; status: "owner" | "active" | "paused"; joinedAt: string; lastSignInAt: string | null };
export type BrandLine = { id: string; tasks30: number; credits30: number };
export type LogLine = { at: string; kind: Activity["kind"]; agent?: Activity["agent"]; by: Activity["by"]; via: Activity["via"]; type?: Activity["type"]; count?: number; credits?: number; outcome?: string; note?: string; brand: string };
export type WorkspaceDetail = {
  name: string;
  view: WorkspaceView;
  totals: { tasks30: number; credits30: number; creditsMonth: number; allowance: number; active7: number; lastActivityAt: string | null };
  series: { day: string; tasks: number; credits: number }[];
  team: TeamLine[];
  brandLines: BrandLine[];
  billing: { priceSar: number; allowance: number; renewedAt: string | null; seatsOverride: number | null; brandCapOverride: number | null; deal: { credits: number; priceSar: number } | null };
  log: LogLine[];
  /** False when a brand's log hit its cap inside the 30 days: the per-member numbers are then a floor, not a total. */
  complete: boolean;
};

/**
 * The workspace page of the account `chosen` belongs to: `workspaceView` plus the 30-day numbers. The member lines read the whole
 * capped activity log of each of the account's brands (`CAPS.activity` rows), because a member's requests and credits are a sum
 * over the window; `complete` says whether that window was fully inside what the log still holds.
 */
export async function workspaceDetail(chosen: string, now = Date.now(), ws?: string | null): Promise<WorkspaceDetail | null> {
  const found = await accountForChosen(chosen, ws);
  if (!found) return null;
  const { owner } = found;
  const [view, r] = await Promise.all([viewOf(owner, found.openedFrom), readAccount(owner, now, CAPS.activity)]);
  const agg = aggOf(owner, r, now);
  const rows = r.acts.flat();
  const tasks = r.lites.flat();
  const from30 = now - TASK_DAYS * 864e5;
  const last30 = tasks.filter((t) => Date.parse(t.createdAt) >= from30);
  const roster = [normalizeEmail(owner.email), ...r.members.map((m) => normalizeEmail(m.email))];
  const stats = memberStats(rows, roster, now);
  const none: MemberStats = { requested: 0, completed: 0, credits: 0, lastActionAt: null };
  const team: TeamLine[] = [
    { email: owner.email, name: owner.name, role: "owner", status: "owner", joinedAt: owner.createdAt, lastSignInAt: view.owner.lastSignInAt, ...(stats[normalizeEmail(owner.email)] ?? none) },
    ...r.members.map((m, i): TeamLine => ({ email: m.email, name: m.name, role: m.role, status: m.disabled ? "paused" : "active", joinedAt: m.acceptedAt, lastSignInAt: view.members[i]?.lastSignInAt ?? null, ...(stats[normalizeEmail(m.email)] ?? none) })),
  ];
  const brandNames = new Map(r.brands.map((b) => [b.id, b.name]));
  const log = r.acts
    .flatMap((list, i) => list.map((a): LogLine => ({ at: a.at, kind: a.kind, ...(a.agent ? { agent: a.agent } : {}), by: a.by, via: a.via, ...(a.type ? { type: a.type } : {}), ...(a.count !== undefined ? { count: a.count } : {}), ...(a.credits !== undefined ? { credits: a.credits } : {}), ...(a.outcome ? { outcome: a.outcome } : {}), ...(a.note ? { note: a.note } : {}), brand: brandNames.get(r.brands[i].id) || r.brands[i].id })))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, LOG_ROWS);
  return {
    name: agg.name, view,
    totals: {
      tasks30: agg.tasks30, credits30: Math.round(last30.reduce((s, t) => s + liteCredits(t), 0)), creditsMonth: agg.creditsUsed, allowance: allowanceOf(owner),
      active7: agg.active7, lastActivityAt: agg.lastActivityAt,
    },
    series: daySeries(last30.map((t) => ({ createdAt: t.createdAt, credits: liteCredits(t) })), now),
    team,
    brandLines: r.brands.map((b, i) => {
      const list = r.lites[i].filter((t) => Date.parse(t.createdAt) >= from30);
      return { id: b.id, tasks30: list.length, credits30: Math.round(list.reduce((s, t) => s + liteCredits(t), 0)) };
    }),
    billing: {
      priceSar: priceOf(owner), allowance: allowanceOf(owner), renewedAt: owner.renewedAt ?? null, seatsOverride: owner.seats ?? null, brandCapOverride: owner.brandCap ?? null,
      deal: owner.deal ? { credits: owner.deal.credits, priceSar: owner.deal.priceSar } : null,
    },
    log,
    complete: r.acts.every((list) => list.length < CAPS.activity || (list.length > 0 && Date.parse(list[list.length - 1].at) <= from30)),
  };
}
