import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as leaveRoute from "@/app/api/team/leave/route";
import * as listRoute from "@/app/api/workspaces/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import { wipeAccount } from "@/lib/account";
import { acct, currentPerson, currentUser, getLogin, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId } from "@/lib/keys";
import { getMembership, ownerOf } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { addShadowMembership, json, newMember, newUser, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M2, the person outlives its last workspace (docs/specs/2026-10-18-multi-org.md sections 9 "Leave" and
 * "Account deletion", 7 "no workspace"), with `MULTI_ORG` on. Rule 2124 (M2 half): leaving or being removed from the last
 * membership deletes the membership, not the person: the login still signs in, `currentUser()` has no account, and
 * `currentPerson()` does, so the app layout sends the person to `/{lang}/app/workspaces` (an empty list, create a
 * workspace). Rule 2126 (M2 half): deleting an account keeps its members' persons; one with another membership keeps
 * working there, one with none lands on the workspaces page. A `p_` owner who holds nothing else still goes with its
 * account (plan reconciliation 7, tests/multi-org-wipe.test.ts).
 */

const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
const login = (email: string, password: string) => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": `10.24.${Math.floor(Math.random() * 250)}.9` }));
const listed = async () => ((await (await listRoute.GET()).json()) as { workspaces: unknown[] }).workspaces;

describe("rule 2124 (M2 half): leaving the last membership keeps the person", () => {
  it("the person, its address and its login stay; no account resolves; the workspaces page lists nothing", async () => {
    const owner = await pro(await newUser("lv", { shadow: false }));
    const m = await newMember(owner, "member", "lvm", { shadow: false });
    await signIn(m.email);
    expect(acct((await currentUser())!)).toBe(acct(owner));
    expect((await leaveRoute.POST()).status).toBe(200);
    const aid = storedAccountId(acct(owner));
    expect(await getMembership(aid, m.pid)).toBeNull();
    expect(await db.sismember(accountKey.members(aid), m.pid)).toBeFalsy();
    expect((await getPerson(m.pid))?.email).toBe(m.email);
    expect((await getLogin(m.email))?.pid).toBe(m.pid);
    // Signed in again through the form: a person with no workspace, a session with its person and no account.
    signOut();
    expect((await login(m.email, m.password)).status).toBe(200);
    expect(await currentUser()).toBeNull();
    expect((await currentPerson())?.person.pid).toBe(m.pid);
    expect(await listed()).toEqual([]);
  });

  it("the address stays taken: a sign-up with it is refused and the person is unchanged", async () => {
    const owner = await pro(await newUser("lt", { shadow: false }));
    const m = await newMember(owner, "member", "ltm", { shadow: false });
    await signIn(m.email);
    expect((await leaveRoute.POST()).status).toBe(200);
    signOut();
    const r = await signupRoute.POST(json("/api/auth/signup", "POST", { email: m.email, password: "other12345", name: "Someone", lang: "ar" }, { "x-forwarded-for": "10.24.1.77" }));
    expect(r.status).toBe(409);
    expect((await getLogin(m.email))?.pid).toBe(m.pid);
    expect((await login(m.email, "other12345")).status).toBe(401);
  });

  it("the app layout sends a person without a workspace to the workspaces page, which renders in that state", () => {
    const src = readFileSync("src/app/[lang]/app/layout.tsx", "utf8");
    expect(src).toMatch(/if \(MULTI_ORG && !user && !isPublic && path && \(await currentPerson\(\)\)\) \{\s*if \(!workspacesPage\) redirect\(`\/\$\{lang\}\/app\/workspaces`\);/);
    expect(src).toContain("const workspacesPage = MULTI_ORG && stripWs(path) === `/${lang}/app/workspaces`;");
  });
});

describe("rule 2126 (M2 half): deleting an account keeps its members' persons", () => {
  it("a member with another membership keeps working there; one with none keeps its person and login", async () => {
    const owner = await pro(await newUser("wp", { shadow: false }));
    const aid = storedAccountId(acct(owner));
    const both = await newMember(owner, "admin", "wpb", { shadow: false });
    const other = await addShadowMembership(both.pid, new Date(Date.now() - 60_000).toISOString());
    const only = await newMember(owner, "member", "wpo", { shadow: false });
    await wipeAccount(acct(owner));
    expect(await getUser(aid)).toBeNull();
    for (const x of [both, only]) {
      expect((await getPerson(x.pid))?.email, x.email).toBe(x.email);
      expect((await getLogin(x.email))?.pid, x.email).toBe(x.pid);
      expect(await db.sismember(personKey.orgs(x.pid), aid)).toBeFalsy();
      expect(await getMembership(aid, x.pid)).toBeNull();
    }
    await signIn(both.email);
    expect(acct((await currentUser())!)).toBe(other.aid);
    await signIn(only.email);
    expect(await currentUser()).toBeNull();
    expect((await currentPerson())?.person.pid).toBe(only.pid);
    expect(await listed()).toEqual([]);
  }, 30_000);

  it("the owner who holds nothing else still goes with the account (reconciliation 7)", async () => {
    const owner = await newUser("wpa", { shadow: false });
    const pid = ownerOf(owner);
    await wipeAccount(acct(owner));
    expect(await getPerson(pid)).toBeNull();
    expect(await getLogin(owner.email)).toBeNull();
  }, 20_000);
});
