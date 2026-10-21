import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as listRoute from "@/app/api/workspaces/route";
import * as switchRoute from "@/app/api/workspaces/switch/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import { resolveGoogle } from "@/lib/google-signin";
import { acct, currentUser, getLogin, getUser, PLAN_CREDITS, sessionKey, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey, storedAccountId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { getPerson, updatePerson } from "@/lib/person";
import { deleteMembership, withAccountTeamLock } from "@/lib/team";
import { OWNED_CAP } from "@/lib/workspaces";
import { wsHandle } from "@/lib/ws-handle";
import { switchTarget } from "@/lib/ws-path";
import { addShadowMembership, json, markVerified, newMember, newUser, signIn } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M2, the workspaces routes (docs/specs/2026-10-18-multi-org.md sections 7 "Switching" and 10), with
 * `MULTI_ORG` on for this file. Rule 2123: create needs a verified person, `wscreate` allows 3 per person per day, the
 * owned cap is 3 unless `ownedCap` raises it, the trial is once per person, and the new `a_` account is in `users:all`
 * and `orgs:`, owned by the person (`ownerPid`), with the session and `lastorg:` moved to it. Rule 2112 (switch half):
 * a switch to an own workspace rewrites the session's `acct` (TTL kept) and `lastorg:`, never the brand choice; a
 * foreign, stale, made-up or malformed handle answers 404 with nothing written; an impersonation cannot switch.
 */

const create = (name: string) => listRoute.POST(json("/api/workspaces", "POST", { name, lang: "ar" }));
const doSwitch = (handle: unknown) => switchRoute.POST(json("/api/workspaces/switch", "POST", { handle }));
const session = async (token: string) => (await db.get<{ acct?: string; pid?: string }>(sessionKey(token)))!;

async function ownerWithTwo() {
  const u = await newUser("wsr", { shadow: false });
  const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
  return { u, shadow, pid: ownerOf(u) };
}

describe("GET /api/workspaces lists the person's own workspaces", () => {
  it("owned first, each with its handle, role and whether it is the session's", async () => {
    const { u, shadow } = await ownerWithTwo();
    await signIn(u.email);
    const r = await listRoute.GET();
    expect(r.status).toBe(200);
    const { workspaces } = (await r.json()) as { workspaces: { handle: string; role: string; current: boolean; name: string }[] };
    expect(workspaces.map((w) => [w.handle, w.role, w.current])).toEqual([
      [wsHandle(acct(u)), "owner", true],
      [wsHandle(shadow.aid), "member", false],
    ]);
    expect(workspaces[1].name).toContain(shadow.marker);
    // Handles only: no account id and no address in the answer.
    const body = JSON.stringify(workspaces);
    expect(body).not.toContain(acct(u));
    expect(body).not.toContain(shadow.aid);
  });

  it("signed out and impersonation: 401", async () => {
    const { u } = await ownerWithTwo();
    (await import("./helpers/session")).signOut();
    expect((await listRoute.GET()).status).toBe(401);
    await signIn(u.email, { imp: "founder@test.example" });
    expect((await listRoute.GET()).status).toBe(401);
  });
});

describe("rule 2123: create a workspace", () => {
  it("a new a_ account owned by the person, in users:all and orgs:, the session and lastorg: on it", async () => {
    const { u, pid } = await ownerWithTwo();
    const token = await signIn(u.email);
    const ttlBefore = await db.ttl(sessionKey(token));
    const r = await create("Second shop");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { handle: string; href: string };
    const s = await session(token);
    const aid = s.acct!;
    expect(aid).toMatch(/^a_[a-z2-7]{24}$/);
    expect(j.handle).toBe(wsHandle(aid));
    expect(j.href).toBe(`/ar/app/w/${j.handle}`);
    const [made, all, orgs, last, ttl] = await Promise.all([getUser(aid), db.sismember(globalKey.usersAll(), aid), db.smembers(personKey.orgs(pid)), db.get(personKey.lastOrg(pid)), db.ttl(sessionKey(token))]);
    expect(ownerOf(made!)).toBe(pid);
    expect(made!.workspaceName).toBe("Second shop");
    expect(made!.emailVerifiedAt).toBeTruthy();
    expect(all).toBeTruthy();
    expect(orgs).toContain(aid);
    expect(last).toBe(aid);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ttlBefore);
    // An owner who already owns a workspace used the trial on it: the new one has no credits and an ended trial.
    expect(made!.credits).toBe(0);
    expect(new Date(made!.trialEnds).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("the trial once per person: a member who owns nothing gets it and trialUsedAt is set; the next create does not", async () => {
    const { u } = await ownerWithTwo();
    const m = await newMember(u, "member", "wsm", { shadow: false });
    await updatePerson(m.pid, { emailVerifiedAt: new Date().toISOString() });
    const token = await signIn(m.email);
    expect((await create("Mine")).status).toBe(200);
    const first = await getUser((await session(token)).acct!);
    expect(first!.credits).toBe(PLAN_CREDITS.trial);
    expect(new Date(first!.trialEnds).getTime()).toBeGreaterThan(Date.now());
    expect((await getPerson(m.pid))!.trialUsedAt).toBeTruthy();
    expect((await create("Second")).status).toBe(200);
    const second = await getUser((await session(token)).acct!);
    expect(second!.credits).toBe(0);
  });

  it("an unverified person is refused, nothing written", async () => {
    const { u } = await ownerWithTwo();
    const m = await newMember(u, "member", "wsu", { shadow: false });
    expect((await getPerson(m.pid))!.emailVerifiedAt).toBeUndefined();
    await signIn(m.email);
    const r = await create("Nope");
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("email_unverified");
    expect(await db.smembers(personKey.orgs(m.pid))).not.toContain(expect.stringMatching(/^a_/));
  });

  it(`the cap: ${OWNED_CAP} owned accounts, raised per person by ownedCap`, async () => {
    const { u, pid } = await ownerWithTwo();
    await signIn(u.email);
    for (let i = 1; i < OWNED_CAP; i++) expect((await create(`W${i}`)).status).toBe(200);
    const r = await create("Over");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("workspace_cap");
    const row = await db.get<Record<string, unknown>>(personKey.person(pid));
    await db.set(personKey.person(pid), { ...row, ownedCap: OWNED_CAP + 1 });
    await db.del(globalKey.rate(`wscreate:${pid}`));
    expect((await create("Raised")).status).toBe(200);
  });

  it("wscreate: three per person per day, then 429 with Retry-After", async () => {
    const { u, pid } = await ownerWithTwo();
    const row = await db.get<Record<string, unknown>>(personKey.person(pid));
    await db.set(personKey.person(pid), { ...row, ownedCap: 10 });
    await signIn(u.email);
    for (let i = 0; i < 3; i++) expect((await create(`R${i}`)).status).toBe(200);
    const r = await create("Fourth");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("a name of 1 to 80 characters", async () => {
    const { u } = await ownerWithTwo();
    await signIn(u.email);
    expect((await create("  ")).status).toBe(400);
    expect((await create("x".repeat(81))).status).toBe(400);
  });
});

describe("rule 2112: switch", () => {
  it("to an own workspace: the session's acct (TTL kept) and lastorg: move, the brand choice does not", async () => {
    const { u, shadow, pid } = await ownerWithTwo();
    const token = await signIn(u.email);
    // Every key the switch writes: the session and lastorg: only (no activebrand, no account record).
    const written: string[] = [];
    const spies = (["set", "setXx", "del", "sadd", "srem"] as const).map((m) => {
      const real = db[m].bind(db) as (...a: unknown[]) => Promise<unknown>;
      return vi.spyOn(db, m).mockImplementation(((k: string, ...rest: unknown[]) => (written.push(k), real(k, ...rest))) as never);
    });
    const r = await doSwitch(wsHandle(shadow.aid)).finally(() => spies.forEach((x) => x.mockRestore()));
    expect(r.status).toBe(200);
    expect((await r.json()).href).toBe(`/ar/app/w/${wsHandle(shadow.aid)}`);
    expect((await session(token)).acct).toBe(shadow.aid);
    expect(await db.get(personKey.lastOrg(pid))).toBe(shadow.aid);
    expect(await db.ttl(sessionKey(token))).toBeGreaterThan(0);
    expect(written.sort()).toEqual([personKey.lastOrg(pid), sessionKey(token)].sort());
  });

  it("foreign, made-up, malformed and missing handles: the same 404, nothing written", async () => {
    const { u, pid } = await ownerWithTwo();
    const stranger = await newUser("wss", { shadow: false });
    const token = await signIn(u.email);
    const before = await session(token);
    for (const h of [wsHandle(acct(stranger)), "w_aaaaaaaaaaaaaaaa", "garbage", acct(stranger), undefined, 7]) {
      const r = await doSwitch(h);
      expect(r.status, String(h)).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "not_found" });
    }
    expect(await session(token)).toEqual(before);
    expect(await db.get(personKey.lastOrg(pid))).toBeNull();
  });

  it("a removed membership's handle is a 404", async () => {
    const { u, shadow, pid } = await ownerWithTwo();
    await signIn(u.email);
    await withAccountTeamLock(storedAccountId(shadow.aid), () => deleteMembership(storedAccountId(shadow.aid), pid, { home: false, teamLocked: true }));
    expect((await doSwitch(wsHandle(shadow.aid))).status).toBe(404);
  });

  it("an impersonation cannot switch: 401, the session unchanged", async () => {
    const { u, shadow } = await ownerWithTwo();
    const token = await signIn(u.email, { imp: "founder@test.example" });
    const before = await session(token);
    expect((await doSwitch(wsHandle(shadow.aid))).status).toBe(401);
    expect(await session(token)).toEqual(before);
  });
});

describe("rule 2112: the switcher", () => {
  const h = "w_aaaaaaaaaaaaaaaa";
  const to = "/ar/app/w/w_bbbbbbbbbbbbbbbb";
  it("goes to the same page of the new workspace; a record's query and a person page fall back", () => {
    expect(switchTarget(to, `/ar/app/w/${h}/tasks`)).toBe(`${to}/tasks`);
    expect(switchTarget(to, `/ar/app/w/${h}/settings/brands`)).toBe(`${to}/settings/brands`);
    expect(switchTarget(to, `/ar/app/w/${h}`)).toBe(to);
    // usePathname() carries no query: a conversation (?conv=) opens the chat section, never the other account's record.
    expect(switchTarget(to, `/ar/app/w/${h}/chat`)).toBe(`${to}/chat`);
    expect(switchTarget(to, "/ar/app/workspaces")).toBe(to);
    expect(switchTarget(to, "/ar/app/tasks")).toBe(to);
  });

  it("is drawn only in a shell with a handle and two workspaces or more, switches through the route and a full load", () => {
    const src = readFileSync("src/components/app/WorkspaceSwitcher.tsx", "utf8");
    expect(src).toContain('if (!handle || !rows || (rows.length < 2 && waiting === 0)) return null;');
    // M3 (rule 2753): one more reason to draw it, an invitation waiting; its count is all the switcher fetches of it.
    expect(src).toContain('fetch("/api/workspaces/invites")');
    expect(src).toContain('fetch("/api/workspaces/switch"');
    expect(src).toContain("window.location.assign(switchTarget(j.href, path))");
    expect(src).toContain("j.href.startsWith(appHref(lang))");
    expect(src).not.toMatch(/router\.(push|replace)/);
    const rail = readFileSync("src/components/app/Sidebar.tsx", "utf8");
    expect(rail).toMatch(/const top = \(bell: boolean\) => \(\s*<>[\s\S]*?<WorkspaceSwitcher t=\{t\.workspaces\}/);
  });
});

describe("rule 2117 (sign-up half): a new sign-up is a p_ person and an a_ account", () => {
  let n = 0;
  const address = (p: string) => `${p}-${Date.now().toString(36)}-${n++}@test.example`;

  it("the password form: the credentials and trialUsedAt on the person, the account without them names it, the session in it", async () => {
    const e = address("su");
    const r = await signupRoute.POST(json("/api/auth/signup", "POST", { email: e, password: "abc12345", name: "New Owner", lang: "ar" }, { "x-forwarded-for": `10.21.${n % 250}.7` }));
    expect(r.status).toBe(200);
    const login = (await getLogin(e))!;
    expect(login.kind).toBe("owner");
    const pid = login.pid;
    expect(pid).toMatch(/^p_/);
    expect(login.acct).toMatch(/^a_[a-z2-7]{24}$/);
    const [person, account, index, orgs, all] = await Promise.all([
      db.get<Record<string, unknown>>(personKey.person(pid)),
      db.get<User>(accountKey.user(login.acct!)),
      db.get<{ pid?: string }>(accountKey.login(e)),
      db.smembers(personKey.orgs(pid)),
      db.sismember(globalKey.usersAll(), login.acct!),
    ]);
    expect(typeof person!.passHash).toBe("string");
    expect(person!.trialUsedAt).toBeTruthy();
    expect(ownerOf(account!)).toBe(pid);
    expect(account).not.toHaveProperty("passHash");
    expect(account).not.toHaveProperty("sessionsAfter");
    expect(account!.credits).toBe(PLAN_CREDITS.trial);
    expect(index?.pid).toBe(pid);
    expect(orgs).toEqual([login.acct]);
    expect(all).toBeTruthy();
    // No legacy records at the address.
    expect(await db.get(accountKey.user(e))).toBeNull();
    // The sign-up's own session, once the address is proved (an unverified owner reads as signed out, rule 751).
    await markVerified(e);
    const me = (await currentUser())!;
    expect(acct(me)).toBe(login.acct);
    expect(me.actor?.pid).toBe(pid);
  });

  it("Google: the same shape with no password, proved, and the trial spent", async () => {
    const e = address("sg");
    const r = await resolveGoogle({ sub: `sub-${Date.now().toString(36)}-${n++}`, email: e, name: "Google Owner" }, "signup", "en");
    expect(r.kind).toBe("created");
    const login = (await getLogin(e))!;
    expect(login.pid).toMatch(/^p_/);
    const person = (await getPerson(login.pid))!;
    expect(person).not.toHaveProperty("passHash");
    expect(person.emailVerifiedAt).toBeTruthy();
    expect(person.trialUsedAt).toBeTruthy();
    const account = (await getUser(login.acct!))!;
    expect(acct(account)).toMatch(/^a_/);
    expect(account).not.toHaveProperty("passHash");
    expect(account.emailVerifiedAt).toBe(person.emailVerifiedAt);
  });

  it("the trial is spent at sign-up: a second workspace starts without credits", async () => {
    const e = address("st");
    const r = await resolveGoogle({ sub: `sub-${Date.now().toString(36)}-${n++}`, email: e, name: "Trial Owner" }, "signup", "ar");
    expect(r.kind).toBe("created");
    const token = await signIn(e);
    expect((await create("Second")).status).toBe(200);
    expect((await getUser((await session(token)).acct!))!.credits).toBe(0);
  });
});
