import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { json, newMember, newUser, params, signOut, withHeaders } from "./helpers/session";
import { enrolledStaff } from "./helpers/staff";
import { db } from "@/lib/db";
import { acct, getUser, saveUser, type Actor, type User } from "@/lib/auth";
import { storedPersonId } from "@/lib/keys";
import { isSuspended, parseSuspendFor, suspendedMessage, suspensionEnd, suspensionExpired, SUSPEND_MAX_DAYS, SUSPENDED_UNTIL } from "@/lib/suspension";
import { endExpiredSuspension } from "@/lib/suspension-server";
import { staffMay, STAFF_MAY } from "@/lib/roles";
import { createInvite, listInvites, peekInvites } from "@/lib/team";
import { lastSignIn, recordDevice } from "@/lib/devices";
import { addBrand } from "@/lib/brands";
import * as users from "@/app/api/admin/users/[email]/route";
import * as workspace from "@/app/api/admin/users/[email]/workspace/route";
import * as plan from "@/app/api/admin/plan/route";
import * as loginRoute from "@/app/api/auth/login/route";

/** Admin workspace view and suspension end dates (rules 2070-2083, docs/system/tests/2070-admin-team-suspension.md). */
const read = (f: string) => readFileSync(f, "utf8");
const KEY = "test-admin-key-0123456789";
const asKey = { "x-admin-key": KEY };
const DAY = 864e5;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");

type Row = { action?: string; actor?: string; target?: string; what?: string; via?: string; before?: Record<string, unknown>; after?: Record<string, unknown>; openedFrom?: string };
const logRows = async (): Promise<Row[]> => (await db.lrange("admin:log", 0, 200)).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as Row);
const rowsFor = async (target: string, action: string) => (await logRows()).filter((r) => r.target === target && r.action === action);

const act = (email: string, body: Record<string, unknown>) => users.POST(json(`/api/admin/users/${encodeURIComponent(email)}`, "POST", body, asKey), params({ email: encodeURIComponent(email) }));
const detail = (email: string) => users.GET(json(`/api/admin/users/${encodeURIComponent(email)}`, "GET", undefined, asKey), params({ email: encodeURIComponent(email) }));
const openWs = (email: string, headers: Record<string, string> = asKey) =>
  workspace.GET(json(`/api/admin/users/${encodeURIComponent(email)}/workspace`, "GET", undefined, headers), params({ email: encodeURIComponent(email) }));
let ipN = 0;
const login = (email: string, password = "abc12345") => {
  const addr = `198.51.100.${(++ipN % 250) + 1}`;
  return withHeaders({ "x-forwarded-for": addr }, () => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": addr })));
};
const store = async (email: string, over: Partial<User>) => saveUser({ ...(await getUser(email))!, ...over });

beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); signOut(); });

describe("rule 2070: the stored shape is an expand of the old `suspended` field", () => {
  it("old `true` reads as indefinite, `{ until }` blocks until that moment, false and absent never block", () => {
    expect(isSuspended(undefined)).toBe(false);
    expect(isSuspended(null)).toBe(false);
    expect(isSuspended({})).toBe(false);
    expect(isSuspended({ suspended: false })).toBe(false);
    expect(isSuspended({ suspended: true }, NOW)).toBe(true);
    expect(suspensionEnd({ suspended: true })).toBeNull();
    const until = new Date(NOW + DAY).toISOString();
    expect(isSuspended({ suspended: { until } }, NOW)).toBe(true);
    expect(suspensionEnd({ suspended: { until } })).toBe(until);
    expect(isSuspended({ suspended: { until } }, NOW + DAY)).toBe(false);
    expect(isSuspended({ suspended: { until } }, NOW + 2 * DAY)).toBe(false);
  });

  it("fails closed: a broken end date or a value this code does not know still blocks", () => {
    for (const v of [{ until: "not a date" }, { until: 12 }, {}, "yes", 1, ["x"]]) expect(isSuspended({ suspended: v }, NOW), JSON.stringify(v)).toBe(true);
    expect(suspensionExpired({ suspended: { until: "not a date" } }, NOW)).toBe(false);
  });

  it("old code that reads only the truth of `suspended` still blocks the new shape (it never ends early)", () => {
    const stored = { suspended: { until: new Date(NOW + DAY).toISOString() } };
    expect(!!stored.suspended).toBe(true);
  });
});

describe("rule 2071: `isSuspended` is the only reader of a stored `suspended`", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []; });
  // Server code only: the console components read the API's own boolean, which the routes computed with isSuspended.
  const ALLOWED = [
    "suspended: u.suspended, billing: u.billing", // entitlements.ts copies the field into EntUser; inactiveOf reads it with isSuspended
    "suspended: w.suspended, archived: w.archived", // evals.ts: w.suspended is already isSuspended(owner)
    "suspended: after.suspended, suspendedUntil: after.until", // the admin route's answer, built from isSuspended
    'case "suspended": return r.suspended;', // admin-workspaces-math.ts: WorkspaceRow.suspended, the boolean rowOf computed with isSuspended (rule 3721)
    "const live = all.filter((r) => !r.suspended);", // admin-workspaces.ts: the same row boolean, for the tiles (rule 3720)
  ];
  it("no other `.suspended` read in src/lib or src/app outside suspension.ts; writes assign the whole field", () => {
    const bad: string[] = [];
    for (const f of [...files("src/lib"), ...files("src/app")]) {
      if (f.endsWith(join("lib", "suspension.ts"))) continue;
      read(f).split("\n").forEach((line, i) => {
        if (!/\.suspended\b/.test(line)) return;
        const rest = line.replace(/\b\w+\.suspended\s*=(?!=)/g, "").replace(/isSuspended\([^)]*\)/g, "");
        if (!/\.suspended\b/.test(rest) || ALLOWED.some((a) => line.includes(a))) return;
        bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("rules 2072-2073: an ended suspension stops blocking at read time, and is tidied with one audit row", () => {
  it("a sign-in after the end date succeeds, clears the field and writes `suspension.expired` once, as actor system", async () => {
    const u = await newUser("exp");
    await store(acct(u), { suspended: { until: new Date(Date.now() - 60_000).toISOString() } });
    expect((await login(u.email)).status).toBe(200);
    expect((await getUser(acct(u)))!.suspended).toBe(false);
    signOut();
    expect((await login(u.email)).status).toBe(200);
    const rows = await rowsFor(u.email, "suspension.expired");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "system", what: "suspension expired", after: { suspended: false } });
    expect(rows[0].before?.suspended).toBe(true);
    expect(typeof rows[0].before?.until).toBe("string");
  });

  it("endExpiredSuspension never clears a live or indefinite suspension", async () => {
    const [a, b] = await Promise.all([newUser("live"), newUser("indef")]);
    const until = new Date(Date.now() + DAY).toISOString();
    await Promise.all([store(acct(a), { suspended: { until } }), store(acct(b), { suspended: true })]);
    expect(await endExpiredSuspension(acct(a))).toBe(false);
    expect(await endExpiredSuspension(acct(b))).toBe(false);
    expect((await getUser(acct(a)))!.suspended).toEqual({ until });
    expect((await getUser(acct(b)))!.suspended).toBe(true);
  });

  it("staff opening the account tidies an ended suspension too, and the detail says not suspended", async () => {
    const u = await newUser("exp-admin");
    await store(acct(u), { suspended: { until: new Date(Date.now() - 60_000).toISOString() } });
    const body = await (await detail(u.email)).json();
    expect(body.user.suspended).toBe(false);
    expect(body.user.suspendedUntil).toBeNull();
    expect(body.user.passHash).toBeUndefined();
    expect(await rowsFor(u.email, "suspension.expired")).toHaveLength(1);
  });

  it("no cron is needed for blocking: entitlements and currentUser use the read-time check", () => {
    expect(read("src/lib/entitlements.ts")).toMatch(/isSuspended\(u, now\)/);
    expect(read("src/lib/auth.ts")).toMatch(/isSuspended\(u\)/);
  });
});

describe("rule 2074: the console shows the effective state and the end date", () => {
  it("suspend for 7 days stores `{ until }`, answers it, logs before and after, and the list and detail carry it", async () => {
    const u = await newUser("s7");
    const t0 = Date.now();
    const res = await act(u.email, { action: "suspend", for: "7" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suspended).toBe(true);
    const end = Date.parse(body.suspendedUntil);
    expect(end).toBeGreaterThanOrEqual(t0 + 7 * DAY - 1000);
    expect(end).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000);
    expect((await getUser(acct(u)))!.suspended).toEqual({ until: body.suspendedUntil });
    const [row] = await rowsFor(u.email, "suspend");
    expect(row).toMatchObject({ before: { suspended: false, until: null }, after: { suspended: true, until: body.suspendedUntil } });
    expect((await (await detail(u.email)).json()).user).toMatchObject({ suspended: true, suspendedUntil: body.suspendedUntil });
    const list = await (await plan.GET(json("/api/admin/plan", "GET", undefined, asKey))).json();
    expect(list.users.find((r: { email: string }) => r.email === u.email)).toMatchObject({ suspended: true, suspendedUntil: body.suspendedUntil });
  });

  it("a request without `for` keeps the old meaning: indefinite, stored as `true`", async () => {
    const u = await newUser("sold");
    expect((await act(u.email, { action: "suspend" })).status).toBe(200);
    expect((await getUser(acct(u)))!.suspended).toBe(true);
    expect((await (await detail(u.email)).json()).user).toMatchObject({ suspended: true, suspendedUntil: null });
  });

  it("unsuspend writes false and logs the end date it removed", async () => {
    const u = await newUser("sun");
    await act(u.email, { action: "suspend", for: "30" });
    expect((await act(u.email, { action: "unsuspend" })).status).toBe(200);
    expect((await getUser(acct(u)))!.suspended).toBe(false);
    const [row] = await rowsFor(u.email, "unsuspend");
    expect(row.before?.suspended).toBe(true);
    expect(typeof row.before?.until).toBe("string");
    expect(row.after).toMatchObject({ suspended: false, until: null });
  });
});

describe("rule 2075: the customer sees the end date in their language", () => {
  it("a timed suspension refuses sign-in with 403 and the end date; an indefinite one without it", async () => {
    const [a, b] = await Promise.all([newUser("cust-t"), newUser("cust-i")]);
    const until = new Date(Date.now() + 3 * DAY).toISOString();
    await Promise.all([store(acct(a), { suspended: { until } }), store(acct(b), { suspended: true })]);
    const ra = await login(a.email);
    expect(ra.status).toBe(403);
    expect(await ra.json()).toEqual({ ok: false, error: "suspended", until });
    const rb = await login(b.email);
    expect(rb.status).toBe(403);
    expect(await rb.json()).toEqual({ ok: false, error: "suspended" });
  });

  it("the message names the date and Riyadh time in Arabic and English; without a valid date the form keeps its own", () => {
    const until = "2026-11-01T09:00:00.000Z";
    expect(suspendedMessage(until, "ar", "fallback")).toContain("بتوقيت الرياض");
    expect(suspendedMessage(until, "ar", "fallback")).toContain("2026");
    expect(suspendedMessage(until, "en", "fallback")).toContain("Riyadh time");
    expect(suspendedMessage(until, "en", "fallback")).toContain("November");
    for (const v of [undefined, null, "", "nope", 12]) expect(suspendedMessage(v, "en", "fallback")).toBe("fallback");
    expect(SUSPENDED_UNTIL.ar("X")).toMatch(/[؀-ۿ]/);
    // The password, two-step code and passkey (rule 2419) answers of the log-in form, and the reset form's.
    expect(read("src/components/app/AuthForm.tsx").match(/suspendedMessage\(p\.body\.until/g)?.length).toBe(4);
  });
});

describe("rule 2076: staff pick indefinite, 7 days, 30 days or a date; anything else is bad_until", () => {
  it("parses each choice", () => {
    expect(parseSuspendFor(undefined, undefined, NOW)).toEqual({ ok: true, value: true });
    expect(parseSuspendFor("indefinite", "2026-12-01", NOW)).toEqual({ ok: true, value: true });
    expect(parseSuspendFor("7", undefined, NOW)).toEqual({ ok: true, value: { until: new Date(NOW + 7 * DAY).toISOString() } });
    expect(parseSuspendFor("30", undefined, NOW)).toEqual({ ok: true, value: { until: new Date(NOW + 30 * DAY).toISOString() } });
    // A date opens the account at the start of that day in Riyadh (UTC+3).
    expect(parseSuspendFor("date", "2026-11-01", NOW)).toEqual({ ok: true, value: { until: "2026-10-31T21:00:00.000Z" } });
  });

  it("refuses an unknown choice, a broken or impossible day, a day not in the future, and more than a year away", () => {
    const bad = { ok: false, error: "bad_until" };
    expect(parseSuspendFor("14", undefined, NOW)).toEqual(bad);
    expect(parseSuspendFor("date", undefined, NOW)).toEqual(bad);
    expect(parseSuspendFor("date", "01/11/2026", NOW)).toEqual(bad);
    expect(parseSuspendFor("date", "2027-02-31", NOW)).toEqual(bad);
    expect(parseSuspendFor("date", "2026-10-17", NOW)).toEqual(bad);
    expect(parseSuspendFor("date", "2026-10-01", NOW)).toEqual(bad);
    const tooFar = new Date(NOW + (SUSPEND_MAX_DAYS + 2) * DAY).toISOString().slice(0, 10);
    expect(parseSuspendFor("date", tooFar, NOW)).toEqual(bad);
  });

  it("the route answers 400 bad_until and changes nothing", async () => {
    const u = await newUser("sbad");
    const res = await act(u.email, { action: "suspend", for: "date", date: "2001-01-01" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_until");
    expect((await getUser(acct(u)))!.suspended ?? false).toBe(false);
    expect(await rowsFor(u.email, "suspend")).toHaveLength(0);
  });
});

describe("rule 2078: the workspace permission fails closed", () => {
  it("owner and support may view; any other role, a missing role or an unknown action may not", () => {
    expect(staffMay("owner", "workspace.view")).toBe(true);
    expect(staffMay("support", "workspace.view")).toBe(true);
    for (const r of [null, undefined, "", "ghost", "Owner", 1, {}]) expect(staffMay(r, "workspace.view"), String(r)).toBe(false);
    expect(staffMay("owner", "workspace.edit" as keyof typeof STAFF_MAY)).toBe(false);
    expect(staffMay("owner", "__proto__" as keyof typeof STAFF_MAY)).toBe(false);
  });
});

describe("rules 2077, 2079-2082: the read-only workspace view", () => {
  async function team() {
    const owner = await newUser("ws-owner");
    await store(acct(owner), { seats: 5, brandCap: 3 });
    const o = (await getUser(acct(owner)))!;
    const [m1, m2] = await Promise.all([newMember(o, "admin", "wsa"), newMember(o, "member", "wsm")]);
    const actor: Actor = { kind: "owner", pid: storedPersonId(o.email), home: true, email: o.email, name: o.name, lang: o.lang, role: "owner" };
    const inv = await createInvite(o, actor, `invitee-${Date.now()}@test.example`, "member", "ar");
    if (!inv.ok) throw new Error(JSON.stringify(inv));
    const b = await addBrand(o, "Second brand");
    if (!("id" in b)) throw new Error(JSON.stringify(b));
    return { owner: o, m1, m2, invite: inv.invite };
  }

  it("needs a console actor (401) and finds no account for an unknown address (404), writing no audit row", async () => {
    expect((await openWs("someone@test.example", {})).status).toBe(401);
    const nobody = `nobody-${Date.now()}@test.example`;
    const res = await openWs(nobody);
    expect(res.status).toBe(404);
    expect(await rowsFor(nobody, "workspace.view")).toHaveLength(0);
  });

  it("shows the owner, plan, members with roles and last sign-in, invites without ids, brands; one audit row per open", async () => {
    const { owner, m1, m2, invite } = await team();
    await recordDevice(m1.email, "session:h:of-m1");
    const res = await openWs(owner.email);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const v = await res.json();
    expect(v.owner).toMatchObject({ email: owner.email, suspended: false, suspendedUntil: null });
    expect(v.owner.passHash).toBeUndefined();
    expect(v.plan.seats).toEqual({ used: 4, limit: 5 });
    expect(v.plan.brands).toMatchObject({ cap: 3 });
    expect(v.plan.brands.active).toBeGreaterThanOrEqual(1);
    const byEmail = Object.fromEntries(v.members.map((m: { email: string }) => [m.email, m]));
    expect(byEmail[m1.email]).toMatchObject({ role: "admin", invitedBy: owner.email, paused: false });
    expect(typeof byEmail[m1.email].lastSignInAt).toBe("string");
    expect(byEmail[m2.email]).toMatchObject({ role: "member", lastSignInAt: null });
    expect(v.invites).toEqual([{ email: invite.email, role: "member", invitedBy: owner.email, createdAt: invite.createdAt, expiresAt: invite.expiresAt }]);
    expect(JSON.stringify(v)).not.toMatch(/token|passHash|"id":"[0-9a-f]{64}"/);
    expect(v.brands.some((b: { name: string }) => b.name === "Second brand")).toBe(true);
    expect(v.openedFrom).toBeNull();
    const rows = await rowsFor(owner.email, "workspace.view");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "key", what: "workspace view" });
    await openWs(owner.email);
    expect(await rowsFor(owner.email, "workspace.view")).toHaveLength(2);
  });

  it("rule 2082: a member's address opens the owner's workspace found from the stored member record", async () => {
    const { owner, m2 } = await team();
    const v = await (await openWs(m2.email)).json();
    expect(v.owner.email).toBe(owner.email);
    expect(v.openedFrom).toBe(m2.email);
    const [row] = await rowsFor(owner.email, "workspace.view");
    expect(row.openedFrom).toBe(m2.email);
  });

  it("a support staff session may open it; the audit row names the staff member", async () => {
    const { owner } = await team();
    const { staff } = await enrolledStaff({ role: "support" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    const res = await openWs(owner.email, {});
    expect(res.status).toBe(200);
    expect((await rowsFor(owner.email, "workspace.view"))[0]).toMatchObject({ actor: staff.email, via: "staff" });
  });

  it("rule 2079: peekInvites never drops an index entry; listInvites still tidies it", async () => {
    const { owner } = await team();
    await db.sadd(`invites:${acct(owner)}`, "f".repeat(64));
    expect((await peekInvites(acct(owner))).length).toBe(1);
    expect(await db.smembers(`invites:${acct(owner)}`)).toContain("f".repeat(64));
    await openWs(owner.email);
    expect(await db.smembers(`invites:${acct(owner)}`)).toContain("f".repeat(64));
    expect((await listInvites(acct(owner))).length).toBe(1);
    expect(await db.smembers(`invites:${acct(owner)}`)).not.toContain("f".repeat(64));
  });

  it("rule 2080: lastSignIn reads the newest indexed sign-in and null when there is none", async () => {
    const u = await newUser("lsi");
    expect(await lastSignIn(u.email)).toBeNull();
    const before = Date.now();
    await recordDevice(u.email, "session:h:k1");
    expect(await lastSignIn(u.email)).toBeGreaterThanOrEqual(before);
  });

  it("rules 2077, 2081: source pins: gate order, audit before the answer, no writes, keys from stored records", () => {
    const route = read("src/app/api/admin/users/[email]/workspace/route.ts");
    const at = (s: string) => { const i = route.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(route).toContain('{ auth: "admin" }');
    expect(at("actorInfo(req)")).toBeLessThan(at('staffMay(consoleRole(req), "workspace.view")'));
    expect(at('staffMay(consoleRole(req), "workspace.view")')).toBeLessThan(at("await workspaceView(chosen)"));
    expect(at("await workspaceView(chosen)")).toBeLessThan(at("await adminAudit("));
    expect(at("await adminAudit(")).toBeLessThan(at("NextResponse.json({ ok: true, ...view }"));
    expect(route).not.toMatch(/export const (POST|PUT|PATCH|DELETE)/);
    const lib = read("src/lib/admin-workspace.ts");
    expect(lib).not.toMatch(/\bdb\.|saveUser|saveMember|listInvites\(|withUserLock|srem|sadd/);
    expect(lib).toContain("peekInvites(key)");
    // Multi-workspace M1: the account is found as a sign-in finds it (`getLogin`, then the stored account its login
    // stands for), no longer from `getUser(m.memberOf)`: a `p_` member has no legacy member record.
    expect(lib).toContain("const login = await getLogin(email);");
    expect(lib).toContain("await getAccount(login.acct)");
    // Every list is read in one round: no await inside a loop.
    expect(lib).not.toMatch(/for \([^)]*\)\s*\{?[^}]*await /);
  });

  it("rule 2083: the console panel is read only, loads on its tab and uses the wave 1b states", () => {
    const panel = read("src/components/admin/WorkspacePanel.tsx");
    for (const s of ["PanelSkeleton", "EmptyState", "ErrorState", "adminFetch(`/api/admin/users/${encodeURIComponent(email)}/workspace`"]) expect(panel, s).toContain(s);
    expect(panel).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"|dangerouslySetInnerHTML/);
    expect(read("src/components/admin/UserSheet.tsx")).toContain('<TabPanel idBase={idBase} id="workspace" value={tab}>\n          <WorkspacePanel lang={lang} email={sel.user.email} />');
  });
});
