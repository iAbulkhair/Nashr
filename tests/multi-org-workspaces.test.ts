import { describe, expect, it, vi } from "vitest";
import * as listRoute from "@/app/api/workspaces/route";
import * as switchRoute from "@/app/api/workspaces/switch/route";
import { acct, getUser, PLAN_CREDITS, sessionKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { globalKey, personKey, storedAccountId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { getPerson, updatePerson } from "@/lib/person";
import { deleteMembership, withAccountTeamLock } from "@/lib/team";
import { OWNED_CAP } from "@/lib/workspaces";
import { wsHandle } from "@/lib/ws-handle";
import { addShadowMembership, json, newMember, newUser, signIn } from "./helpers/session";

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
