import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import { acct, currentUser, getLogin, getUser, type Login, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { mfaKey, type MfaEnrolment } from "@/lib/mfa";
import { createMcpToken, getMcpToken } from "@/lib/mcp";
import { ownerOf } from "@/lib/membership";
import { getPerson, type Person } from "@/lib/person";
import { createWorkspace } from "@/lib/workspaces";
import { bornAt, finishLogin } from "@/lib/login-finish";
import { actingLogin, loginBornAt } from "@/lib/own-password";
import type { Member } from "@/lib/team";
import * as accountRoute from "@/app/api/account/route";
import * as twoStepRoute from "@/app/api/account/2fa/route";
import * as resetRoute from "@/app/api/auth/reset/route";
import { addShadowMembership, json, newMember, newUser, signIn, signOut } from "./helpers/session";


/**
 * Auth review fixes (rules 2990-2992, docs/system/tests/2990-auth-review.md), with `MULTI_ORG` on (the release switch since M2 enable):
 * 2990 one birth for a login (`loginBornAt`), so a `p_` person's two-step enrolment counts in every workspace it owns or
 * joins later; 2991 wrong-try buckets on PATCH and DELETE /api/account; 2992 a password reset or change revokes in
 * every account the person owns.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });

const PASSWORD = "abc12345";
const NEW = "newpass123";
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `203.0.113.${(++ipN % 250) + 1}` });

/** A two-step enrolment at `at` (the shape `mfaActive` reads; no real secret is needed for these checks). */
const enrol = (email: string, at: string) => db.set(mfaKey(email), { enc: "sealed", kid: "k", rc: [], at } satisfies MfaEnrolment);
const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const start2fa = () => twoStepRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: PASSWORD }));
const changePassword = (current: string, next = NEW) => accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: current, newPassword: next }));
const deleteAccount = (password: string) => accountRoute.DELETE(json("/api/account", "DELETE", { password }));
async function resetWith(email: string, kind: "owner" | "member") {
  const token = randomBytes(32).toString("hex");
  await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email, kind }, 3600);
  return resetRoute.POST(json("/api/auth/reset", "POST", { token, password: NEW }, ip()));
}

/** A `p_` owner of two workspaces: the first from sign-up, the second created later through `createWorkspace`. */
async function ownerOfTwo(): Promise<{ u: User; person: Person; second: User }> {
  const u = await newUser("ar2990", { shadow: false });
  const person = (await getPerson(ownerOf(u)))!;
  // Strictly after the first account's birth, so the second one is younger than an enrolment made in between.
  await new Promise((r) => setTimeout(r, 5));
  const made = await createWorkspace(person, { name: "Second", lang: "ar" });
  if (!made.ok) throw new Error(`createWorkspace: ${made.error}`);
  return { u, person, second: (await getUser(made.aid))! };
}

describe("rule 2990: one birth for a login, the login's own", () => {
  it("loginBornAt: a legacy owner's account, a legacy member's record, else the person's createdAt", () => {
    const person = { createdAt: "2026-10-01T00:00:00.000Z" };
    const legacyOwner = { id: "own@test.example", email: "own@test.example", createdAt: "2026-09-01T00:00:00.000Z" } as User;
    expect(loginBornAt("own@test.example", person, { owner: legacyOwner })).toBe("2026-09-01T00:00:00.000Z");
    // A `p_` owner of that account (its id is not the person id): the person's birth, never the account's.
    expect(loginBornAt("p_aaaaaaaaaaaaaaaaaaaaaaaa", person, { owner: legacyOwner })).toBe("2026-10-01T00:00:00.000Z");
    expect(loginBornAt("m@test.example", person, { member: { acceptedAt: "2026-09-15T00:00:00.000Z" } as Member })).toBe("2026-09-15T00:00:00.000Z");
    expect(loginBornAt("p_bbbbbbbbbbbbbbbbbbbbbbbb", person, { member: null })).toBe("2026-10-01T00:00:00.000Z");
    expect(loginBornAt("p_bbbbbbbbbbbbbbbbbbbbbbbb", { createdAt: "" })).toBeUndefined();
  });

  it("a p_ owner with two-step on still gets the code when sign-in picks a workspace created after the enrolment", async () => {
    const u = await newUser("ar2990s", { shadow: false });
    const person = (await getPerson(ownerOf(u)))!;
    await enrol(person.email, person.createdAt);
    await new Promise((r) => setTimeout(r, 5));
    const made = await createWorkspace(person, { name: "Later", lang: "ar" });
    expect(made.ok).toBe(true);
    const second = (await getUser((made as { aid: string }).aid))!;
    expect(Date.parse(second.createdAt)).toBeGreaterThan(Date.parse(person.createdAt));
    // Whichever owned account `getLogin` picks, and the later one in particular, the birth is the person's.
    const picked = (await getLogin(person.email))!;
    expect(picked.kind).toBe("owner");
    expect(bornAt(picked)).toBe(person.createdAt);
    const viaSecond: Login = { kind: "owner", user: second, pid: person.pid, person, acct: acct(second) as Login["acct"] & string };
    expect(bornAt(viaSecond)).toBe(person.createdAt);
    expect((await finishLogin(viaSecond, { via: "password" })).kind).toBe("mfa");
    expect((await finishLogin(picked, { via: "password" })).kind).toBe("mfa");
  });

  it("acting as owner of the later workspace: setup cannot start over the live enrolment", async () => {
    const { person, second } = await ownerOfTwo();
    await enrol(person.email, person.createdAt);
    await signIn(person.email, { acct: acct(second) });
    const me = (await actingLogin((await currentUser())!))!;
    expect(me.kind).toBe("owner");
    expect(me.bornAt).toBe(person.createdAt);
    const res = await start2fa();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "already_on" });
  });

  it("a p_ owner acting as a member of a workspace joined after the enrolment: the enrolment counts", async () => {
    const u = await newUser("ar2990m", { shadow: false });
    const person = (await getPerson(ownerOf(u)))!;
    await enrol(person.email, person.createdAt);
    // Joined one second after the owned account's birth: after the enrolment.
    const joined = await addShadowMembership(person.pid, u.createdAt);
    await signIn(person.email, { acct: joined.aid });
    const me = (await actingLogin((await currentUser())!))!;
    expect(me.kind).toBe("member");
    expect(me.bornAt).toBe(person.createdAt);
    const res = await start2fa();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "already_on" });
    const status = await (await twoStepRoute.GET()).json();
    expect(status.enabled).toBe(true);
  });

  it("a p_ member enrolled in its first workspace: the enrolment counts in a later one", async () => {
    const owner = await newUser("ar2990o");
    const m = await newMember(owner, "member", "ar2990mm", { shadow: false });
    const person = (await getPerson(m.pid))!;
    const home = (await getLogin(m.email))!;
    await enrol(m.email, later(person.createdAt, 1));
    const joined = await addShadowMembership(m.pid, person.createdAt);
    await signIn(m.email, { acct: joined.aid });
    const me = (await actingLogin((await currentUser())!))!;
    expect(me.bornAt).toBe(person.createdAt);
    expect((await start2fa()).status).toBe(409);
    // Sign-in reads the same birth.
    expect(bornAt(home)).toBe(person.createdAt);
    expect((await finishLogin(home, { via: "password" })).kind).toBe("mfa");
  });

  it("an enrolment older than the person still belongs to nobody (a re-registered address)", async () => {
    const u = await newUser("ar2990r", { shadow: false });
    const person = (await getPerson(ownerOf(u)))!;
    await enrol(person.email, later(person.createdAt, -60_000));
    await signIn(person.email);
    expect((await start2fa()).status).toBe(200);
    expect((await finishLogin((await getLogin(person.email))!, { via: "password" })).kind).toBe("signed_in");
  });

  it("sign-in and the session settings share the helper (source)", () => {
    const finish = readFileSync("src/lib/login-finish.ts", "utf8");
    const own = readFileSync("src/lib/own-password.ts", "utf8");
    expect(finish).toMatch(/export const bornAt = \(l: Login\)[^\n]*loginBornAt\(/);
    expect(own).not.toMatch(/bornAt: m\.acceptedAt/);
    expect(own.match(/loginBornAt\(a\.pid, person/g)?.length).toBe(2);
  });
});

describe("rule 2991: PATCH and DELETE /api/account limit wrong passwords", () => {
  it("PATCH: ten wrong ones an hour, then 429 slow_down; a right one is given back", async () => {
    const u = await newUser("ar2991p");
    await signIn(u.email);
    for (let i = 0; i < 9; i++) expect((await changePassword("wrong-pass-1")).status).toBe(401);
    // A right password does not use up a try.
    expect((await changePassword(PASSWORD, NEW)).status).toBe(200);
    expect((await changePassword("wrong-pass-1")).status).toBe(401);
    const res = await changePassword(NEW, "another123");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("DELETE: its own bucket, ten wrong ones an hour, then 429 with the account untouched", async () => {
    const u = await newUser("ar2991d");
    await signIn(u.email);
    // The password-change bucket is spent; deletion counts on its own.
    for (let i = 0; i < 10; i++) await changePassword("wrong-pass-1");
    expect((await changePassword("wrong-pass-1")).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await deleteAccount("wrong-pass-1")).status).toBe(401);
    const res = await deleteAccount(PASSWORD);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(await getUser(acct(u))).toBeTruthy();
  });

  it("source: each compare sits behind its bucket", () => {
    const src = readFileSync("src/app/api/account/route.ts", "utf8");
    expect(src).toContain("accountKey.passwordChangeBucket(a.email)");
    expect(src).toContain("accountKey.accountDeleteBucket(u.actor!.email)");
    expect(src).not.toMatch(/if \(!\(await matches\(u, b\./);
  });
});

describe("rule 2992: a password reset or change revokes in every account the person owns", () => {
  it("an owner reset ends the MCP tokens and team sessions of both owned workspaces", async () => {
    const { u, person, second } = await ownerOfTwo();
    await Promise.all([createMcpToken(acct(u)), createMcpToken(acct(second))]);
    expect(await getMcpToken(acct(second))).toBeTruthy();
    const before = (await getUser(acct(second)))!.teamSessionsAfter;
    const res = await resetWith(person.email, "owner");
    expect(res.status).toBe(200);
    expect(await getMcpToken(acct(u))).toBeNull();
    expect(await getMcpToken(acct(second))).toBeNull();
    const after = (await getUser(acct(second)))!.teamSessionsAfter;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect((await getUser(acct(u)))!.teamSessionsAfter).toBeTruthy();
  });

  it("a password change as owner of one workspace ends the MCP tokens of the other", async () => {
    const { u, person, second } = await ownerOfTwo();
    await Promise.all([createMcpToken(acct(u)), createMcpToken(acct(second))]);
    await signIn(person.email, { acct: acct(u) });
    expect((await changePassword(PASSWORD)).status).toBe(200);
    expect(await getMcpToken(acct(u))).toBeNull();
    expect(await getMcpToken(acct(second))).toBeNull();
  });

  it("a password change while acting as a member ends the MCP tokens of the workspace the person owns", async () => {
    const u = await newUser("ar2992m", { shadow: false });
    const person = (await getPerson(ownerOf(u)))!;
    const joined = await addShadowMembership(person.pid, u.createdAt);
    await createMcpToken(acct(u));
    await signIn(person.email, { acct: joined.aid });
    expect((await currentUser())!.actor!.kind).toBe("member");
    expect((await changePassword(PASSWORD)).status).toBe(200);
    expect(await getMcpToken(acct(u))).toBeNull();
  });

  it("a legacy owner's reset is unchanged: its one account", async () => {
    const u = await newUser("ar2992l", { legacy: true, shadow: false });
    await createMcpToken(acct(u));
    expect((await resetWith(u.email, "owner")).status).toBe(200);
    expect(await getMcpToken(acct(u))).toBeNull();
  });
});
