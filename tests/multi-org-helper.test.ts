import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Rule 2132 (fixture part, multi-workspace M1 Task 9): the test helper's persons. By default (`TEST_PERSONS` unset) every
 * owner and member `tests/helpers/session.ts` makes is a `p_` person, the shape release M2 signs up; with
 * `TEST_PERSONS=legacy` they are today's legacy persons. In both modes each one also holds one shadow membership: a plain
 * `member` seat in a fresh, unrelated account that is not in `users:all`, accepted one second after the home membership,
 * whose brand and task carry the `SHADOW-` marker. Sign-in still lands in the home account, and no answer of the home
 * account contains the marker. `{ legacy: true }` and `{ shadow: false }` opt a fixture out.
 *
 * The helper reads `TEST_PERSONS` once, at import, so each mode is loaded fresh: `vi.resetModules()`, the variable
 * stubbed, then every module imported again (the store is the process-wide in-memory one, so nothing is lost).
 */
afterEach(() => { vi.unstubAllEnvs(); });

async function load(mode: "p" | "legacy") {
  vi.resetModules();
  vi.stubEnv("TEST_PERSONS", mode === "legacy" ? "legacy" : "");
  const [h, auth, membership, multiOrg, keys, team, db, mcp, tasksRoute, brandRoute] = await Promise.all([
    import("./helpers/session"),
    import("@/lib/auth"),
    import("@/lib/membership"),
    import("@/lib/multi-org"),
    import("@/lib/keys"),
    import("@/lib/team"),
    import("@/lib/db"),
    import("@/lib/mcp"),
    import("@/app/api/tasks/route"),
    import("@/app/api/brand/route"),
  ]);
  return { h, auth, membership, multiOrg, keys, team, db: db.db, mcp, tasksRoute, brandRoute };
}
type Mods = Awaited<ReturnType<typeof load>>;

/** The person's memberships other than `home`: what the shadow adds. */
async function others(m: Mods, pid: string, home: string) {
  const orgs = await m.membership.listOrgs(m.keys.storedPersonId(pid));
  return orgs.filter((o) => o.aid !== home);
}

/** The shadow account is a real, verified trial account at `user:{aid}`, and it is not in `users:all`. */
async function expectShadowAccount(m: Mods, aid: string) {
  const rec = await m.db.get<{ email: string; plan: string; emailVerifiedAt?: string }>(m.keys.accountKey.user(m.keys.storedAccountId(aid)));
  expect(rec).toMatchObject({ email: aid, plan: "trial" });
  expect(rec!.emailVerifiedAt).toBeTruthy();
  expect(aid).toMatch(/^shadow\d+-[0-9a-f]{6}@test\.example$/);
  expect(await m.db.sismember(m.keys.globalKey.usersAll(), aid)).toBe(false);
}

/**
 * The positive control for `expectHome`: a session pinned to the shadow account reads the same two routes and finds the
 * marker, so "no answer of the home account contains it" is not vacuous (the marker was written where it is looked for).
 */
async function expectShadowVisible(m: Mods, email: string, shadow: string) {
  await m.h.signIn(email, { acct: shadow });
  const u = (await m.auth.currentUser())!;
  expect(m.auth.acct(u)).toBe(shadow);
  const [tasks, brand] = await Promise.all([m.tasksRoute.GET(m.h.json("/api/tasks", "GET")), m.brandRoute.GET(m.h.json("/api/brand", "GET"))]);
  for (const r of [tasks, brand]) expect(await r.text()).toContain(m.h.SHADOW_MARKER);
}

/** Signed in as `email`: the home account, and neither the task list nor the brand of it shows the shadow's marker. */
async function expectHome(m: Mods, email: string, home: string) {
  await m.h.signIn(email);
  const u = (await m.auth.currentUser())!;
  expect(m.auth.acct(u)).toBe(home);
  const [tasks, brand] = await Promise.all([m.tasksRoute.GET(m.h.json("/api/tasks", "GET")), m.brandRoute.GET(m.h.json("/api/brand", "GET"))]);
  expect(tasks.status).toBe(200);
  expect(brand.status).toBe(200);
  for (const r of [tasks, brand]) expect(await r.text()).not.toContain(m.h.SHADOW_MARKER);
  return u;
}

describe("rule 2132 (fixtures): p_ persons by default, each with one shadow membership", () => {
  it("an owner is a p_ person with exactly one shadow membership, and signs in to its own account", async () => {
    const m = await load("p");
    expect(m.h.PERSONS).toBe("p");
    const u = await m.h.newUser("hp");
    const pid = m.membership.ownerOf(u);
    expect(pid).toMatch(m.multiOrg.PERSON_ID);
    expect(u.ownerPid).toBe(pid);
    const extra = await others(m, pid, m.auth.acct(u));
    expect(extra).toHaveLength(1);
    expect(extra[0].role).toBe("member");
    await expectShadowAccount(m, extra[0].aid);
    const row = (await m.membership.getMembership(extra[0].aid, pid))!;
    expect(new Date(row.acceptedAt).getTime()).toBe(new Date(u.createdAt).getTime() + 1000);
    await expectShadowVisible(m, u.email, extra[0].aid);
    expect((await expectHome(m, u.email, m.auth.acct(u))).actor).toMatchObject({ kind: "owner", pid });
  });

  it("a member is a p_ person with no legacy record and exactly one shadow membership, accepted a second after the home one", async () => {
    const m = await load("p");
    const owner = await m.h.newUser("hpo");
    const mem = await m.h.newMember(owner, "admin", "hpm");
    expect(mem.pid).toMatch(m.multiOrg.PERSON_ID);
    expect(await m.team.getMember(mem.email)).toBeNull();
    const home = (await m.membership.getMembership(m.keys.storedAccountId(m.auth.acct(owner)), mem.pid))!;
    expect(home.role).toBe("admin");
    const extra = await others(m, mem.pid, m.auth.acct(owner));
    expect(extra).toHaveLength(1);
    await expectShadowAccount(m, extra[0].aid);
    const shadow = (await m.membership.getMembership(extra[0].aid, mem.pid))!;
    expect(new Date(shadow.acceptedAt).getTime()).toBe(new Date(home.acceptedAt).getTime() + 1000);
    await expectShadowVisible(m, mem.email, extra[0].aid);
    expect((await expectHome(m, mem.email, m.auth.acct(owner))).actor).toMatchObject({ kind: "member", pid: mem.pid, role: "admin" });
  });

  it("{ shadow: false } makes a person who holds nothing else; { legacy: true } a legacy person in p mode", async () => {
    const m = await load("p");
    const alone = await m.h.newUser("hpa", { shadow: false });
    expect(await others(m, m.membership.ownerOf(alone), m.auth.acct(alone))).toEqual([]);
    const lone = await m.h.newMember(alone, "member", "hpl", { shadow: false });
    expect(await others(m, lone.pid, m.auth.acct(alone))).toEqual([]);
    const old = await m.h.newUser("hpg", { legacy: true });
    expect(old.ownerPid).toBeUndefined();
    expect(m.membership.ownerOf(old)).toBe(m.auth.acct(old));
    expect(await others(m, m.membership.ownerOf(old), m.auth.acct(old))).toHaveLength(1);
  });

  it("rule 2120: an MCP token whose address is a p_ member's login is refused, even with an owner record at that address", async () => {
    const m = await load("p");
    const owner = await m.h.newUser("hpt");
    const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
    expect((await m.mcp.userFromBearer(bearer(await m.mcp.createMcpToken(owner.email))))!.email).toBe(owner.email);
    const mem = await m.h.newMember(owner);
    // A token record naming the member's address (as a token minted before the address was a member login would).
    const forged = "nashr_" + "f".repeat(43);
    await m.db.set(`mcptoken:${forged}`, mem.email);
    expect(await m.mcp.userFromBearer(bearer(forged))).toBeNull();
    // A p_ member has no legacy `member:` record: the login index (naming the member, not the owner) refuses it.
    await m.auth.saveUser({ ...owner, id: mem.email, email: mem.email });
    expect(await m.mcp.userFromBearer(bearer(forged))).toBeNull();
  });
});

describe("rule 2132 (fixtures): TEST_PERSONS=legacy makes legacy persons, still with a shadow membership", () => {
  it("an owner's person id is its account id and a member's its address, with a legacy record; each holds one shadow", async () => {
    const m = await load("legacy");
    expect(m.h.PERSONS).toBe("legacy");
    const u = await m.h.newUser("hl");
    expect(u.ownerPid).toBeUndefined();
    expect(m.membership.ownerOf(u)).toBe(m.auth.acct(u));
    const extra = await others(m, m.membership.ownerOf(u), m.auth.acct(u));
    expect(extra).toHaveLength(1);
    await expectShadowAccount(m, extra[0].aid);
    await expectShadowVisible(m, u.email, extra[0].aid);
    await expectHome(m, u.email, m.auth.acct(u));

    const mem = await m.h.newMember(u, "member", "hlm");
    expect(mem.pid).toBe(m.auth.normalizeEmail(mem.email));
    expect(await m.team.getMember(mem.email)).toMatchObject({ email: mem.email, memberOf: m.auth.acct(u) });
    expect(await others(m, mem.pid, m.auth.acct(u))).toHaveLength(1);
    expect((await expectHome(m, mem.email, m.auth.acct(u))).actor).toMatchObject({ kind: "member", pid: mem.pid });
  });
});
