import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import * as peopleRoute from "@/app/api/admin/people/[email]/route";
import * as switchRoute from "@/app/api/workspaces/switch/route";
import { acct, createUser, getUser, sessionKey, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getMembership, ownerOf } from "@/lib/membership";
import { newPersonId } from "@/lib/multi-org";
import { updatePerson } from "@/lib/person";
import { createMember } from "@/lib/team";
import { wsHandle } from "@/lib/ws-handle";
import { recordDevice } from "@/lib/devices";
import { enrolledStaff } from "./helpers/staff";
import { addShadowMembership, jar, json, markVerified, params, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M3, the founder console's people view (docs/specs/2026-10-18-multi-org.md section 14; rules 2130,
 * 2755) and the impersonation half of rule 2130, with `MULTI_ORG` on for this file. The fixtures are `a_` accounts owned
 * by `p_` persons and a `p_` member whatever `TEST_PERSONS` says: the view reads any person `getLogin` finds.
 */

const KEY = "test-admin-key-people-0123456789";
const asKey = { "x-admin-key": KEY };
beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "people-connect-secret-one"); });
beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); vi.stubEnv("CONNECT_SECRET", "people-connect-secret-one"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); signOut(); });

let n = 0;
const address = (prefix: string) => `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`;
const PASSWORD = "abc12345";

type Row = { action?: string; actor?: string; target?: string; what?: string; via?: string };
const logRows = async (): Promise<Row[]> => (await db.lrange("admin:log", 0, 500)).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as Row);
const rowsFor = async (target: string) => (await logRows()).filter((r) => r.target === target && r.what === "people view");

const view = (email: string, headers: Record<string, string> = asKey) =>
  peopleRoute.GET(json(`/api/admin/people/${encodeURIComponent(email)}`, "GET", undefined, headers), params({ email: encodeURIComponent(email) }));

async function owner(prefix: string): Promise<{ u: User; aid: AccountId; pid: PersonId }> {
  const made = await createUser({ email: address(prefix), name: "Owner", phone: "", password: PASSWORD, lang: "ar" }, { opaque: true, person: "p" });
  await markVerified(made.email);
  const aid = storedAccountId(acct(made));
  const x = (await getUser(aid))!;
  return { u: x, aid, pid: storedPersonId(ownerOf(x)) };
}
/** A verified `p_` admin of the owner's account who also holds a paused membership in a second, unrelated account. */
async function member(o: { u: User; aid: AccountId; pid: PersonId }, prefix: string): Promise<{ email: string; pid: PersonId; other: AccountId }> {
  const email = address(prefix);
  const pid = storedPersonId(newPersonId());
  await createMember(acct(o.u), { email, name: "Member Person", password: PASSWORD, lang: "en", role: "admin", invitedBy: o.u.email, invitedByPid: o.pid }, { pid });
  await updatePerson(pid, { emailVerifiedAt: new Date().toISOString() });
  const ms = (await getMembership(o.aid, pid))!;
  const shadow = await addShadowMembership(pid, ms.acceptedAt!);
  const row = (await db.get<Record<string, unknown>>(accountKey.membership(shadow.aid, pid)))!;
  await db.set(accountKey.membership(shadow.aid, pid), { ...row, disabled: "seats" });
  return { email, pid, other: shadow.aid };
}

const READS = new Set(["get", "lrange", "hgetall", "smembers", "sismember", "scardMany", "mget", "zcard", "zscore", "zrangeWithScores", "zrangeByScore", "ttl", "lockOwned"]);
/** Every db method that is not a read, spied: the view may call none but the audit row's list push. */
const writeSpies = () => {
  const writes: string[] = [];
  const store = db as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of Object.keys(store).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(store)))) {
    if (READS.has(name) || name === "constructor" || typeof store[name] !== "function") continue;
    const real = store[name].bind(store);
    vi.spyOn(store, name as never).mockImplementation(((...a: unknown[]) => { writes.push(`${name} ${String(a[0])}`); return real(...a); }) as never);
  }
  return writes;
};

describe("rules 2130, 2755: the console people view", () => {
  it("lists every workspace the person owns or belongs to, paused ones included, by handle; no id, hash or secret; one audit row; nothing else written", async () => {
    const o = await owner("po");
    const m = await member(o, "pm");
    await recordDevice(m.email, "session:h:people-1");
    const writes = writeSpies();
    const res = await view(m.email.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Only the console gate's own header budget and the audit row are written; the view itself writes nothing.
    expect(writes.filter((w) => !w.endsWith(" admin:log") && !w.includes(" rate:adminhdr:"))).toEqual([]);
    expect(writes.some((w) => w.endsWith(" admin:log"))).toBe(true);
    const text = await res.text();
    const v = JSON.parse(text) as { person: Record<string, unknown>; workspaces: Record<string, unknown>[] };
    expect(v.person).toMatchObject({ email: m.email, name: "Member Person", verified: true, suspended: false });
    expect(typeof v.person.lastSignIn).toBe("number");
    const byHandle = Object.fromEntries(v.workspaces.map((w) => [w.handle, w]));
    expect(Object.keys(byHandle).sort()).toEqual([wsHandle(o.aid), wsHandle(m.other)].sort());
    expect(byHandle[wsHandle(o.aid)]).toMatchObject({ role: "admin", paused: false, suspended: false, plan: o.u.plan });
    expect(byHandle[wsHandle(m.other)]).toMatchObject({ paused: true });
    for (const secret of [o.aid, m.other, m.pid, o.pid, o.u.email, "passHash", "password", "secret", "token", "session:"]) expect(text, secret).not.toContain(secret);
    expect(await rowsFor(m.email)).toEqual([expect.objectContaining({ action: "workspace.view", actor: "key", via: "header" })]);
  });

  it("an owner's address shows the account it owns with role owner and the account's suspension", async () => {
    const o = await owner("pso");
    await db.set(accountKey.user(o.aid), { ...(await db.get<Record<string, unknown>>(accountKey.user(o.aid)))!, suspended: true });
    const v = (await (await view(o.u.email)).json()) as { workspaces: Record<string, unknown>[] };
    expect(v.workspaces).toEqual([expect.objectContaining({ handle: wsHandle(o.aid), role: "owner", suspended: true, paused: false })]);
  });

  it("needs a console actor (401) and the workspace.view permission (403); an unknown address is 404; none of these writes an audit row", async () => {
    const o = await owner("pg");
    expect((await view(o.u.email, {})).status).toBe(401);
    const { staff } = await enrolledStaff({ role: "auditor" as never });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    const r = await view(o.u.email, {});
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("forbidden");
    expect((await view("nobody-people@test.example")).status).toBe(404);
    expect(await rowsFor(o.u.email)).toEqual([]);
  });

  it("a support staff session may open it; the audit row names the staff member", async () => {
    const o = await owner("pss");
    const { staff } = await enrolledStaff({ role: "support" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    expect((await view(o.u.email, {})).status).toBe(200);
    expect(await rowsFor(o.u.email)).toEqual([expect.objectContaining({ actor: staff.email, via: "staff" })]);
  });
});

describe("rule 2130 (impersonation part): an impersonation session cannot switch accounts", () => {
  it("POST /api/workspaces/switch is 401 under impersonation and writes nothing; the session keeps its account", async () => {
    const o = await owner("pio");
    const m = await member(o, "pim");
    // Unpause the second membership so a real session of the person could switch to it.
    const row = (await db.get<Record<string, unknown>>(accountKey.membership(m.other, m.pid)))!;
    await db.set(accountKey.membership(m.other, m.pid), { ...row, disabled: undefined });
    await signIn(m.email, { imp: "support-founder@test.example" });
    const token = jar().get("thakeen_session")!;
    const before = await db.get(sessionKey(token));
    const lastBefore = await db.get(personKey.lastOrg(m.pid));
    const writes = writeSpies();
    const r = await switchRoute.POST(json("/api/workspaces/switch", "POST", { handle: wsHandle(m.other) }));
    expect(r.status).toBe(401);
    expect(writes).toEqual([]);
    vi.restoreAllMocks();
    expect(await db.get(sessionKey(token))).toEqual(before);
    expect(await db.get(personKey.lastOrg(m.pid))).toEqual(lastBefore);
    // The same person signed in as themself can switch: the 401 is the impersonation, not the handle.
    signOut();
    await signIn(m.email);
    expect((await switchRoute.POST(json("/api/workspaces/switch", "POST", { handle: wsHandle(m.other) }))).status).toBe(200);
  });
});
