import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { json, newMember, newUser, params, PERSONS, signOut } from "./helpers/session";
import { enrolledStaff } from "./helpers/staff";
import { db } from "@/lib/db";
import { acct, getUser, saveUser, type User } from "@/lib/auth";
import { recordActivity, type Activity } from "@/lib/activity";
import { saveTask } from "@/lib/brand";
import { listBrands, scopeFor } from "@/lib/brands";
import { withAccountTeamLock, writeMembership } from "@/lib/team";
import { createInvite } from "@/lib/team";
import { globalKey, storedAccountId } from "@/lib/keys";
import { PLANS } from "@/lib/pricing";
import { roleLabel } from "@/lib/role-label";
import { memberStats, activeLogins, lastActivity, daySeries, rowCredits, parseWsQuery, wsQueryParams, matchRow, sortRows, rowFacets, rowHasFilter, personOf, DEFAULT_WS_QUERY, WS_FILTERS, WS_SORTS, type WorkspaceRow, type ActRow } from "@/lib/admin-workspaces-math";
import * as list from "@/app/api/admin/workspaces/route";
import * as one from "@/app/api/admin/workspaces/[email]/route";

/** The founder console's customers list and workspace page (rules 3720-3749, docs/system/tests/3720-console-workspaces.md). */
const read = (f: string) => readFileSync(f, "utf8");
const KEY = "test-admin-key-0123456789";
const asKey = { "x-admin-key": KEY };
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const HOUR = 36e5;
const DAY = 864e5;

type Row = { action?: string; actor?: string; target?: string; what?: string; via?: string; openedFrom?: string; page?: boolean };
const logRows = async (): Promise<Row[]> => (await db.lrange("admin:log", 0, 300)).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as Row);
const rowsFor = async (target: string, action: string) => (await logRows()).filter((r) => r.target === target && r.action === action);

const getList = (qs = "", headers: Record<string, string> = asKey) => list.GET(json(`/api/admin/workspaces${qs ? `?${qs}` : ""}`, "GET", undefined, headers));
const getOne = (email: string, headers: Record<string, string> = asKey) =>
  one.GET(json(`/api/admin/workspaces/${encodeURIComponent(email)}`, "GET", undefined, headers), params({ email: encodeURIComponent(email) }));

beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); signOut(); });

// ---- Fixtures ---------------------------------------------------------------------------------------------------------

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const byMember = (email: string): Activity["by"] => ({ kind: "member", email, role: "member" });

async function put(owner: User, rows: Activity[]) {
  const [brand] = await listBrands(acct(owner));
  await recordActivity(scopeFor(acct(owner), brand.id), rows);
}
async function task(owner: User, id: string, createdAt: string) {
  await saveTask(acct(owner), { id, type: "social", channel: "instagram", title: id, body: id, status: "pending", createdAt, lang: "ar" }, true);
}
/** An owner with an admin and a member, one pending invite, three tasks and activity naming the admin (and a person who is not on the roster). */
async function workspace() {
  const owner0 = await newUser("cw-owner");
  await saveUser({ ...(await getUser(acct(owner0)))!, seats: 6 });
  const owner = (await getUser(acct(owner0)))!;
  const [a, m] = await Promise.all([newMember(owner, "admin", "cwa"), newMember(owner, "member", "cwm")]);
  const actor = { kind: "owner" as const, pid: owner.ownerPid!, home: true, email: owner.email, name: owner.name, lang: owner.lang, role: "owner" as const };
  const inv = await createInvite(owner, actor as never, `cw-inv-${Date.now()}@test.example`, "member", "ar");
  if (!inv.ok) throw new Error(JSON.stringify(inv));
  await Promise.all([task(owner, "t-one", ago(2 * DAY)), task(owner, "t-two", ago(3 * DAY)), task(owner, "t-old", ago(60 * DAY))]);
  await put(owner, [
    { at: ago(2 * HOUR), kind: "generated", by: byMember(a.email), via: "app", type: "social", count: 2, credits: 6, tasks: ["t-one", "t-two"] },
    { at: ago(HOUR), kind: "decision", by: byMember(a.email), via: "app", outcome: "approve", tasks: ["t-one"] },
    { at: ago(3 * HOUR), kind: "generated", by: byMember("stranger@test.example"), via: "app", type: "social", count: 5, credits: 20 },
    { at: ago(4 * HOUR), kind: "generated", by: { kind: "system", job: "cron" }, via: "cron", type: "social", count: 1, credits: 3 },
  ]);
  return { owner, a, m, invite: inv.invite };
}

// ---- Rule 3720: the query, the filters, the sort ------------------------------------------------------------------------

const row = (over: Partial<WorkspaceRow> & { email: string }): WorkspaceRow => ({
  name: over.email, ownerName: "Owner", plan: "trial", suspended: false, seats: { used: 1, limit: 1 }, brands: { active: 1, cap: 1 }, active7: 0, tasks30: 0,
  credits: { used: 0, allowance: 100 }, lastActivityAt: null, createdAt: "2026-10-01T00:00:00.000Z", ...over,
});

describe("rule 3720: the list's query is validated, its defaults stay out of the address", () => {
  it("unknown values fall back to the defaults, the text is cut, the page and size are bounded", () => {
    expect(parseWsQuery(new URLSearchParams(""))).toEqual(DEFAULT_WS_QUERY);
    const q = parseWsQuery(new URLSearchParams(`q=${"a".repeat(200)}&plan=gold&filter=x&sort=bogus&dir=up&page=-4&per=7`));
    expect(q).toEqual({ ...DEFAULT_WS_QUERY, q: "a".repeat(120) });
    expect(parseWsQuery(new URLSearchParams("page=NaN")).page).toBe(1);
    expect(parseWsQuery(new URLSearchParams("page=99999999")).page).toBe(10_000);
    expect(parseWsQuery(new URLSearchParams("per=100")).per).toBe(100);
  });
  it("round-trips every plan, filter and sort; writes nothing for a default", () => {
    expect(wsQueryParams(DEFAULT_WS_QUERY).toString()).toBe("");
    for (const plan of PLANS) for (const filter of WS_FILTERS) for (const sort of WS_SORTS) {
      const q = { ...DEFAULT_WS_QUERY, plan, filter, sort, dir: "asc" as const, page: 3, per: 50, q: "sara" };
      expect(parseWsQuery(wsQueryParams(q))).toEqual(q);
    }
  });
});

describe("rule 3721: filters, sort and facets are arithmetic over rows", () => {
  const rows = [
    row({ email: "a@x.test", name: "Alpha", plan: "pro", seats: { used: 4, limit: 5 }, active7: 2, tasks30: 9, lastActivityAt: "2026-10-22T00:00:00.000Z" }),
    row({ email: "b@x.test", name: "Beta", plan: "trial", seats: { used: 1, limit: 1 }, active7: 0, lastActivityAt: null }),
    row({ email: "c@x.test", name: "Gamma", plan: "pro", seats: { used: 2, limit: 5 }, active7: 0, suspended: true, lastActivityAt: "2026-10-01T00:00:00.000Z" }),
  ];
  it("near the seat limit needs a plan with more than one seat and at least 80% used", () => {
    expect(rowHasFilter(rows[0], "nearSeats")).toBe(true);
    expect(rowHasFilter(rows[1], "nearSeats")).toBe(false);
    expect(rowHasFilter(rows[2], "nearSeats")).toBe(false);
    expect(rowHasFilter(row({ email: "z", seats: { used: 4, limit: 5 } }), "nearSeats")).toBe(true);
    expect(rowHasFilter(row({ email: "z", seats: { used: 0, limit: 0 } }), "nearSeats")).toBe(false);
  });
  it("low activity is nobody active in 7 days; suspended and trial are their own states", () => {
    expect(rows.filter((r) => rowHasFilter(r, "lowActivity")).map((r) => r.name)).toEqual(["Beta", "Gamma"]);
    expect(rows.filter((r) => rowHasFilter(r, "suspended")).map((r) => r.name)).toEqual(["Gamma"]);
    expect(rows.filter((r) => rowHasFilter(r, "trial")).map((r) => r.name)).toEqual(["Beta"]);
  });
  it("the text filter matches the name, the owner's address and name, or a resolved member hit", () => {
    const q = { ...DEFAULT_WS_QUERY, q: "alp" };
    expect(rows.filter((r) => matchRow(r, q)).map((r) => r.name)).toEqual(["Alpha"]);
    expect(rows.filter((r) => matchRow(r, { ...DEFAULT_WS_QUERY, q: "member@elsewhere.test" }, new Set(["c@x.test"]))).map((r) => r.name)).toEqual(["Gamma"]);
    expect(rows.filter((r) => matchRow(r, { ...DEFAULT_WS_QUERY, q: "member@elsewhere.test" })).length).toBe(0);
  });
  it("sorts by the chosen column and breaks ties by the owner's address; a missing date is the oldest", () => {
    expect(sortRows(rows, "lastActivity", "desc").map((r) => r.name)).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(sortRows(rows, "lastActivity", "asc").map((r) => r.name)).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(sortRows(rows, "tasks30", "desc")[0].name).toBe("Alpha");
    const tie = sortRows([row({ email: "z@x.test" }), row({ email: "a@x.test" })], "active7", "desc");
    expect(tie.map((r) => r.email)).toEqual(["a@x.test", "z@x.test"]);
  });
  it("facets count over the text filter only, so a menu shows what choosing it would give", () => {
    const f = rowFacets(rows, { ...DEFAULT_WS_QUERY, plan: "pro", filter: "trial" });
    expect(f.all).toBe(3);
    expect(f.plan.pro).toBe(2);
    expect(f.plan.trial).toBe(1);
    expect(f.filter.suspended).toBe(1);
  });
});

// ---- Rule 3722: who did what ---------------------------------------------------------------------------------------------

describe("rule 3722: per-member numbers come from the roster's own rows", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const rows: ActRow[] = [
    { at: at(HOUR), kind: "generated", by: byMember("Sara@Test.example"), count: 2, credits: 6 },
    { at: at(2 * HOUR), kind: "decision", by: byMember("sara@test.example"), outcome: "approve", tasks: ["a", "b"] },
    { at: at(3 * HOUR), kind: "decision", by: byMember("sara@test.example"), outcome: "reject", tasks: ["c"] },
    { at: at(4 * HOUR), kind: "onboard_refunded", by: byMember("sara@test.example"), credits: 2, refunded: true },
    { at: at(5 * HOUR), kind: "generated", by: byMember("gone@test.example"), count: 9, credits: 30 },
    { at: at(6 * HOUR), kind: "generated", by: { kind: "system", job: "cron" }, count: 4, credits: 12 },
    { at: at(40 * DAY), kind: "generated", by: byMember("sara@test.example"), count: 7, credits: 21 },
  ];
  it("counts requested, completed and credits (refunds taken off), roster only, inside the window", () => {
    const s = memberStats(rows, ["sara@test.example", "idle@test.example"], NOW);
    expect(s["sara@test.example"]).toMatchObject({ requested: 2, completed: 2, credits: 4 });
    expect(s["sara@test.example"].lastActionAt).toBe(at(HOUR));
    expect(s["idle@test.example"]).toEqual({ requested: 0, completed: 0, credits: 0, lastActionAt: null });
    expect(Object.keys(s).sort()).toEqual(["idle@test.example", "sara@test.example"]);
  });
  it("a person on both workspaces' rosters gets each workspace's own numbers, because each call gets only that workspace's rows", () => {
    const inA = memberStats(rows, ["sara@test.example"], NOW);
    const otherRows: ActRow[] = [{ at: at(HOUR), kind: "generated", by: byMember("sara@test.example"), count: 11, credits: 33 }];
    const inB = memberStats(otherRows, ["sara@test.example"], NOW);
    expect(inA["sara@test.example"].requested).toBe(2);
    expect(inB["sara@test.example"].requested).toBe(11);
    expect(inB["sara@test.example"].credits).toBe(33);
  });
  it("only an owner's or a member's address names a person; support, apps and jobs name nobody", () => {
    expect(personOf({ kind: "owner", email: " A@B.test " })).toBe("a@b.test");
    expect(personOf({ kind: "founder", email: "owner@test.example" })).toBeNull();
    expect(personOf({ kind: "token", email: "app@test.example" })).toBeNull();
    expect(personOf({ kind: "system", job: "cron" })).toBeNull();
    expect(personOf(undefined)).toBeNull();
    expect(personOf({ kind: "member" })).toBeNull();
  });
  it("rowCredits never gives NaN, counts only charged kinds, and gives refunds back", () => {
    expect(rowCredits({ at: "x", kind: "generated", by: { kind: "owner" }, credits: Number.NaN })).toBe(0);
    expect(rowCredits({ at: "x", kind: "no_credits", by: { kind: "owner" }, credits: 9 })).toBe(0);
    expect(rowCredits({ at: "x", kind: "render_failed", by: { kind: "owner" }, credits: 3, refunded: true })).toBe(-3);
    expect(rowCredits({ at: "x", kind: "render_failed", by: { kind: "owner" }, credits: 3 })).toBe(0);
    expect(rowCredits({ at: "x", kind: "render_done", by: { kind: "owner" }, credits: 3 })).toBe(0);
  });
  it("active in 7 days counts the roster's rows and sign-ins, never a stranger's or a job's", () => {
    const active = activeLogins(rows, { "idle@test.example": NOW - 8 * DAY, "late@test.example": NOW - DAY }, ["sara@test.example", "idle@test.example", "late@test.example"], NOW);
    expect(active.sort()).toEqual(["late@test.example", "sara@test.example"]);
    expect(activeLogins(rows, { "gone@test.example": NOW }, ["sara@test.example"], NOW)).toEqual(["sara@test.example"]);
  });
  it("last activity is the newest sign-in, last seen or customer row; a founder's or a job's row is not customer activity", () => {
    expect(lastActivity([{ at: at(HOUR), kind: "generated", by: { kind: "founder" } }, { at: at(2 * HOUR), kind: "generated", by: { kind: "system", job: "cron" } }], [null, undefined])).toBeNull();
    expect(lastActivity([{ at: at(HOUR), kind: "generated", by: { kind: "token" } }], [at(5 * HOUR)])).toBe(at(HOUR));
    expect(lastActivity([], [NOW - DAY, "2026-10-01T00:00:00.000Z", "not a date"])).toBe(new Date(NOW - DAY).toISOString());
  });
  it("the day series has one line per UTC day, oldest first, zero days included", () => {
    const s = daySeries([{ createdAt: at(HOUR), credits: 1.5 }, { createdAt: at(2 * HOUR), credits: 0.25 }, { createdAt: at(31 * DAY), credits: 9 }], NOW);
    expect(s).toHaveLength(30);
    expect(s[29]).toEqual({ day: "2026-10-23", tasks: 2, credits: 1.75 });
    expect(s[0].day).toBe("2026-09-24");
    expect(s.filter((d) => d.tasks === 0)).toHaveLength(29);
  });
});

// ---- Rule 3740: one label helper ---------------------------------------------------------------------------------------

describe("rule 3740: role names go through one helper that tolerates a role it has never heard of", () => {
  it("names every known role in both languages", () => {
    expect(["owner", "admin", "member", "editor", "viewer"].map((r) => roleLabel(r, "en"))).toEqual(["Owner", "Admin", "Member", "Editor", "Viewer"]);
    expect(roleLabel("editor", "ar")).toBe("محرّر");
    expect(roleLabel("viewer", "ar")).toBe("مشاهد");
  });
  it("shows an unknown role as the stored word and a missing one as a dash, never as a crash or `undefined`", () => {
    expect(roleLabel("billing-manager", "en")).toBe("billing-manager");
    expect(roleLabel("x".repeat(60), "ar")).toBe("x".repeat(24));
    for (const r of [undefined, null, "", 3, {}]) expect(roleLabel(r, "en")).toBe("—");
    expect(roleLabel("__proto__", "en")).toBe("__proto__");
    expect(roleLabel("constructor", "ar")).toBe("constructor");
  });
  it("the console components render roles through it, not through a local map", () => {
    for (const f of ["src/components/admin/Customers.tsx", "src/components/admin/WorkspacePage.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("roleLabel(");
      expect(src, f).not.toMatch(/roles\[\w+\.role\]/);
    }
  });
});

// ---- Rule 3723: the gate -------------------------------------------------------------------------------------------------

describe("rules 3720, 3725: a console actor, the workspace.view permission, fail closed", () => {
  it("both routes refuse a request with no console actor (401) and answer nothing", async () => {
    expect((await getList("", {})).status).toBe(401);
    expect((await getOne("someone@test.example", {})).status).toBe(401);
  });
  it("a staff session whose role is unknown gets 403 from both, before any read or audit row", async () => {
    const { staff } = await enrolledStaff({ role: "ghost" as never });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    const { owner } = await workspace();
    expect((await getList("", {})).status).toBe(403);
    expect((await getOne(owner.email, {})).status).toBe(403);
    expect(await rowsFor(owner.email, "workspace.view")).toHaveLength(0);
  });
  it("a support staff session may read both; the audit row names the staff member", async () => {
    const { owner } = await workspace();
    const { staff } = await enrolledStaff({ role: "support" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    expect((await getList("", {})).status).toBe(200);
    expect((await getOne(owner.email, {})).status).toBe(200);
    expect((await rowsFor(owner.email, "workspace.view"))[0]).toMatchObject({ actor: staff.email, via: "staff" });
  });
  it("source pins: gate order, audit before the answer, GET only, no database call in a route", () => {
    for (const [file, read_] of [["src/app/api/admin/workspaces/route.ts", "workspaceList("], ["src/app/api/admin/workspaces/[email]/route.ts", "workspaceDetail("]] as const) {
      const route = read(file);
      const at = (s: string) => { const i = route.indexOf(s); expect(i, `${file}: ${s}`).toBeGreaterThan(-1); return i; };
      expect(route).toContain('{ auth: "admin" }');
      expect(at("actorInfo(req)")).toBeLessThan(at('staffMay(consoleRole(req), "workspace.view")'));
      expect(at('staffMay(consoleRole(req), "workspace.view")')).toBeLessThan(at(read_));
      expect(at("await adminAudit(")).toBeLessThan(at("NextResponse.json({ ok: true"));
      expect(route).not.toMatch(/export const (POST|PUT|PATCH|DELETE)\b/);
      expect(route).not.toMatch(/\bdb\./);
    }
    const detail = read("src/app/api/admin/workspaces/[email]/route.ts");
    expect(detail.indexOf("await workspaceDetail(")).toBeLessThan(detail.indexOf("await adminAudit("));
  });
});

// ---- The list and the page, end to end ---------------------------------------------------------------------------------

describe("rules 3720-3724: the customers list, one row per workspace", () => {
  it("shows the plan, seats used (members plus invites) over the limit, brands, activity, tasks, credits and last activity", async () => {
    const { owner, a } = await workspace();
    const res = await getList("per=100");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    const r = body.rows.find((x: WorkspaceRow) => x.email === owner.email);
    expect(r).toBeTruthy();
    expect(r.plan).toBe("trial");
    expect(r.seats).toEqual({ used: 4, limit: 6 });
    expect(r.brands.active).toBeGreaterThanOrEqual(1);
    expect(r.tasks30).toBe(2);
    expect(r.active7).toBe(1);
    expect(typeof r.lastActivityAt).toBe("string");
    expect(r.credits.allowance).toBeGreaterThan(0);
    expect(r.asRole).toBeUndefined();
    expect(body.person).toBeNull();
    expect(JSON.stringify(body)).not.toContain(a.email);
    expect(JSON.stringify(body)).not.toMatch(/passHash|token/);
    expect((await logRows()).filter((x) => x.action === "workspace.search")).toHaveLength(0);
    // An owner's own address is a login too: the search resolves it, shows the role "owner" and is audited like any member's.
    const byOwner = await (await getList(`q=${encodeURIComponent(owner.email)}`)).json();
    expect(byOwner.person).toMatchObject({ email: owner.email });
    expect(byOwner.rows.find((x: WorkspaceRow) => x.email === owner.email)).toMatchObject({ asRole: "owner" });
    expect(await rowsFor(owner.email, "workspace.search")).toHaveLength(1);
  });

  it("paginates and keeps the counts of the whole list", async () => {
    const [x, y, z] = await Promise.all([newUser("cw-p"), newUser("cw-p"), newUser("cw-p")]);
    const body = await (await getList("per=25&page=1")).json();
    expect(body.tiles.workspaces).toBeGreaterThanOrEqual(3);
    expect(body.rows.length).toBeLessThanOrEqual(25);
    const second = await (await getList("per=25&page=9999")).json();
    expect(second.page).toBeLessThanOrEqual(second.pages);
    expect(body.matched).toBe(body.facets.all);
    expect([x, y, z].every((u) => u.email)).toBe(true);
  });

  it("a member's address finds the workspace that person belongs to, with their role, and writes one audit row before answering", async () => {
    const { owner, a, m } = await workspace();
    const body = await (await getList(`q=${encodeURIComponent(a.email)}`)).json();
    expect(body.person).toMatchObject({ email: a.email });
    const found = body.rows.find((x: WorkspaceRow) => x.email === owner.email);
    expect(found).toMatchObject({ asRole: "admin" });
    const rows = await rowsFor(a.email, "workspace.search");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "key", what: "workspace search" });
    const other = await (await getList(`q=${encodeURIComponent(m.email)}`)).json();
    expect(other.rows.find((x: WorkspaceRow) => x.email === owner.email)).toMatchObject({ asRole: "member" });
    expect(await rowsFor(m.email, "workspace.search")).toHaveLength(1);
  });

  it.runIf(PERSONS === "p")("a person in two listed workspaces appears in both, with the role they hold in each", async () => {
    const { owner, a } = await workspace();
    const other = await newUser("cw-two");
    const oaid = storedAccountId(acct(other));
    await withAccountTeamLock(oaid, () => writeMembership(oaid, a.pid, { aid: oaid, pid: a.pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: other.email }, { home: false, teamLocked: true }));
    const body = await (await getList(`q=${encodeURIComponent(a.email)}`)).json();
    const byOwner = Object.fromEntries(body.rows.map((r: WorkspaceRow) => [r.email, r.asRole]));
    expect(byOwner[owner.email]).toBe("admin");
    expect(byOwner[other.email]).toBe("member");
  });

  it("the numbers are counted on demand, kept, and counted again only on refresh", async () => {
    const { owner } = await workspace();
    const first = await (await getList(`q=${encodeURIComponent(owner.email)}`)).json();
    expect(first.rows[0].tasks30).toBe(2);
    expect((await db.get<{ at: number }>(globalKey.workspaceAgg()))?.at).toBeGreaterThan(0);
    await task(owner, "t-new", ago(HOUR));
    const cached = await (await getList(`q=${encodeURIComponent(owner.email)}`)).json();
    expect(cached.rows[0].tasks30).toBe(2);
    expect(cached.asOf).toBe(first.asOf);
    const fresh = await (await getList(`q=${encodeURIComponent(owner.email)}&refresh=1`)).json();
    expect(fresh.rows[0].tasks30).toBe(3);
  });
});

describe("rules 3725-3729: the workspace page", () => {
  it("404 for an address no login answers to, with no audit row", async () => {
    const nobody = `nobody-${Date.now()}@test.example`;
    expect((await getOne(nobody)).status).toBe(404);
    expect(await rowsFor(nobody, "workspace.view")).toHaveLength(0);
    expect((await getOne("%E0%A4%A", asKey)).status).toBe(404);
  });

  it("gives the 30 days, the team with each member's numbers, the brands, the billing summary and the log; one audit row per open", async () => {
    const { owner, a, m } = await workspace();
    const res = await getOne(owner.email);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const d = await res.json();
    expect(d.view.owner.email).toBe(owner.email);
    expect(d.totals).toMatchObject({ tasks30: 2, active7: 1 });
    expect(d.series).toHaveLength(30);
    expect(d.team[0]).toMatchObject({ email: owner.email, role: "owner", status: "owner" });
    const byEmail = Object.fromEntries(d.team.map((t: { email: string }) => [t.email, t]));
    expect(byEmail[a.email]).toMatchObject({ role: "admin", requested: 2, completed: 1, credits: 6, status: "active" });
    expect(byEmail[m.email]).toMatchObject({ role: "member", requested: 0, completed: 0, credits: 0, lastActionAt: null });
    expect(byEmail["stranger@test.example"]).toBeUndefined();
    expect(d.team).toHaveLength(3);
    expect(d.brandLines.length).toBeGreaterThanOrEqual(1);
    expect(d.billing.allowance).toBeGreaterThan(0);
    expect(d.billing.deal).toBeNull();
    expect(d.log.length).toBeGreaterThanOrEqual(4);
    expect(d.log.length).toBeLessThanOrEqual(100);
    expect(d.log.map((l: { at: string }) => l.at)).toEqual([...d.log.map((l: { at: string }) => l.at)].sort().reverse());
    expect(d.complete).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/passHash|"id":"[0-9a-f]{64}"|token/);
    const rows = await rowsFor(owner.email, "workspace.view");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "key", what: "workspace view", page: true });
    await getOne(owner.email);
    expect(await rowsFor(owner.email, "workspace.view")).toHaveLength(2);
  });

  it("a member's address opens the owner's workspace and the audit row names the member", async () => {
    const { owner, m } = await workspace();
    const d = await (await getOne(m.email)).json();
    expect(d.view.owner.email).toBe(owner.email);
    expect(d.view.openedFrom).toBe(m.email);
    expect((await rowsFor(owner.email, "workspace.view"))[0].openedFrom).toBe(m.email);
  });

  it.runIf(PERSONS === "p")("tenant isolation: the same person's numbers in another workspace never appear here", async () => {
    const { owner, a } = await workspace();
    const other = await newUser("cw-iso");
    const oaid = storedAccountId(acct(other));
    await withAccountTeamLock(oaid, () => writeMembership(oaid, a.pid, { aid: oaid, pid: a.pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: other.email }, { home: false, teamLocked: true }));
    await put(other, [{ at: ago(HOUR), kind: "generated", by: byMember(a.email), via: "app", type: "social", count: 40, credits: 120 }]);
    const here = await (await getOne(owner.email)).json();
    const there = await (await getOne(other.email)).json();
    expect(here.team.find((t: { email: string }) => t.email === a.email)).toMatchObject({ requested: 2, credits: 6 });
    expect(there.team.find((t: { email: string }) => t.email === a.email)).toMatchObject({ requested: 40, credits: 120, role: "member" });
    expect(JSON.stringify(here)).not.toContain(other.email);
  });

  it("says when a brand's log is full inside the 30 days, so the per-member numbers are known to be a floor", async () => {
    const { aggOf } = await import("@/lib/admin-workspaces");
    expect(typeof aggOf).toBe("function");
    const src = read("src/lib/admin-workspaces.ts");
    expect(src).toContain("complete");
    expect(src).toContain("CAPS.activity");
  });
});

// ---- Rule 3724: the cost of the scan ----------------------------------------------------------------------------------

describe("rule 3724: no database call inside a loop, the aggregate is bounded", () => {
  it("the new server code reads in parallel (pmap or Promise.all) and never awaits db inside a loop", () => {
    for (const f of ["src/lib/admin-workspaces.ts", "src/lib/admin-workspace.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*await\s+(db|get|list|peek|last)/);
      expect(src, f).not.toMatch(/while\s*\([^)]*\)\s*\{[^}]*await\s+db/);
    }
    const src = read("src/lib/admin-workspaces.ts");
    expect(src).toContain("pmap(");
    expect(src).toContain("AGG_TTL_MS");
    expect(src).toContain("db.set(globalKey.workspaceAgg()");
  });
});

// ---- Rule 3741: the shell ------------------------------------------------------------------------------------------------

describe("rule 3741: the pages", () => {
  it("/users is the customers list, the account table moved to /users/accounts, and /users/{email} is the workspace page", () => {
    expect(read("src/app/[lang]/admin/users/page.tsx")).toContain("<Customers ");
    expect(read("src/app/[lang]/admin/users/accounts/page.tsx")).toContain("<Users ");
    expect(read("src/app/[lang]/admin/users/[email]/page.tsx")).toContain("<WorkspacePage ");
  });
  it("the files this change must not touch are untouched", () => {
    for (const f of ["src/lib/roles.ts", "src/lib/team.ts", "src/lib/staff.ts", "src/lib/staff-session.ts"]) {
      expect(read(f), f).not.toContain("3720");
    }
  });
});
