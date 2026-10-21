import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import * as deleteRoute from "@/app/api/workspaces/person/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";
import { acct, createUser, currentUser, getLogin, getUser, sessionKey, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getMembership, ownerOf } from "@/lib/membership";
import { mfaKeys } from "@/lib/mfa";
import { newPersonId } from "@/lib/multi-org";
import { getPerson, updatePerson } from "@/lib/person";
import { createInvite, createMember } from "@/lib/team";
import { readTeamLog } from "@/lib/teamlog";
import { codeAt } from "./helpers/staff";
import { addShadowMembership, jar, json, markVerified, newMember, newUser, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/** Runs once after the first membership left: a join landing between the delete's first read and its final check. */
const race = vi.hoisted(() => ({ after: null as null | (() => Promise<void>) }));
vi.mock("@/lib/team", async (orig) => {
  const m = await orig<typeof import("@/lib/team")>();
  return {
    ...m,
    leaveForDeletion: (async (...a: Parameters<typeof m.leaveForDeletion>) => {
      const r = await m.leaveForDeletion(...a);
      const hook = race.after;
      race.after = null;
      if (hook) await hook();
      return r;
    }) as typeof m.leaveForDeletion,
  };
});

/**
 * Multi-workspace M3, deleting a person (docs/specs/2026-10-18-multi-org.md section 13; rules 2127, 2754), with
 * `MULTI_ORG` on for this file. The fixtures are `a_` accounts owned by `p_` persons and `p_` members whatever
 * `TEST_PERSONS` says, because only a `person:`-source person is deleted here (plan reconciliation 7); the legacy shape is
 * pinned as refused.
 */

beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "delete-connect-secret-one"); });
afterEach(() => { signOut(); });

let n = 0;
const address = (prefix: string) => `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`;
const PASSWORD = "abc12345";

async function owner(prefix: string): Promise<{ u: User; aid: AccountId; pid: PersonId }> {
  const made = await createUser({ email: address(prefix), name: "Owner", phone: "", password: PASSWORD, lang: "ar" }, { opaque: true, person: "p" });
  await markVerified(made.email);
  const aid = storedAccountId(acct(made));
  const x = (await getUser(aid))!;
  return { u: x, aid, pid: storedPersonId(ownerOf(x)) };
}
/** A verified `p_` member of the owner's account who also holds a membership in a second, unrelated account. */
async function member(o: { u: User; aid: AccountId; pid: PersonId }, prefix: string): Promise<{ email: string; pid: PersonId; other: AccountId }> {
  const email = address(prefix);
  const pid = storedPersonId(newPersonId());
  await createMember(acct(o.u), { email, name: `M ${n}`, password: PASSWORD, lang: "en", role: "member", invitedBy: o.u.email, invitedByPid: o.pid }, { pid });
  await updatePerson(pid, { emailVerifiedAt: new Date().toISOString() });
  const ms = (await getMembership(o.aid, pid))!;
  const shadow = await addShadowMembership(pid, ms.acceptedAt!);
  return { email, pid, other: shadow.aid };
}
const del = (body: Record<string, unknown>, headers: Record<string, string> = {}) => deleteRoute.DELETE(json("/api/workspaces/person", "DELETE", body, headers));

describe("rules 2127, 2754: a person deletes their own login", () => {
  it("every membership, the roster and reverse entries, the person, the login index, two-step state, the inbox and the device sessions go; one 'left' row per workspace", async () => {
    const o = await owner("do");
    const m = await member(o, "dm");
    const third = await owner("dt");
    // An invitation waiting for the person's address (the inbox, rule 2753).
    await signIn(third.u.email);
    const me3 = (await currentUser())!;
    const inv = await createInvite(me3, me3.actor!, m.email, "member", "en");
    expect(inv.ok).toBe(true);
    expect(await db.smembers(accountKey.invitesFor(m.email))).toHaveLength(1);
    signOut();
    // The second workspace's membership is paused for seats: it goes too.
    const row = (await db.get<Record<string, unknown>>(accountKey.membership(m.other, m.pid)))!;
    await db.set(accountKey.membership(m.other, m.pid), { ...row, disabled: "seats" });
    // Two devices; the second turns two-step sign-in on and deletes.
    const first = await signIn(m.email);
    await signIn(m.email);
    const ip = { "x-forwarded-for": "198.51.100.91" };
    const s = (await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: PASSWORD }, ip))).json()) as { ok: boolean; secret: string };
    const c = (await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, ip))).json()) as { ok: boolean; codes: string[] };
    expect(c.ok).toBe(true);
    const r = await del({ password: PASSWORD, code: codeAt(s.secret, Date.now() + 30_000) }, ip);
    expect(r.status).toBe(200);
    for (const aid of [o.aid, m.other]) {
      expect(await getMembership(aid, m.pid), aid).toBeNull();
      expect(await db.get(accountKey.membership(aid, m.pid))).toBeNull();
      expect(await db.sismember(accountKey.members(aid), m.pid)).toBeFalsy();
    }
    const left = (await readTeamLog(o.aid)).filter((x) => x.kind === "left");
    expect(left).toHaveLength(1);
    expect(left[0].target.email).toBe(m.email);
    expect(await getPerson(m.pid)).toBeNull();
    expect(await db.get(personKey.person(m.pid))).toBeNull();
    expect(await db.smembers(personKey.orgs(m.pid))).toEqual([]);
    expect(await getLogin(m.email)).toBeNull();
    expect(await db.get(accountKey.login(m.email))).toBeNull();
    for (const k of mfaKeys(m.email)) expect(await db.get(k), k).toBeNull();
    expect(await db.smembers(accountKey.invitesFor(m.email))).toEqual([]);
    // This device is signed out, and the other device's session no longer opens anything.
    expect(jar().get("thakeen_session")).toBeUndefined();
    jar().set("thakeen_session", first);
    expect(await currentUser()).toBeNull();
    // The owner's account and the other account are untouched.
    expect(await getUser(o.aid)).not.toBeNull();
    expect(await getUser(m.other)).not.toBeNull();
  });

  it("a recovery code stands in for the authenticator here", async () => {
    const o = await owner("dr");
    const m = await member(o, "drm");
    await signIn(m.email);
    const ip = { "x-forwarded-for": "198.51.100.92" };
    const s = (await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: PASSWORD }, ip))).json()) as { ok: boolean; secret: string };
    const c = (await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, ip))).json()) as { ok: boolean; codes: string[] };
    expect((await del({ password: PASSWORD }, ip)).status).toBe(400);
    expect(await getPerson(m.pid)).not.toBeNull();
    expect((await del({ password: PASSWORD, code: c.codes[0] }, ip)).status).toBe(200);
    expect(await getPerson(m.pid)).toBeNull();
  });

  it("a wrong or missing password deletes nothing", async () => {
    const o = await owner("dw");
    const m = await member(o, "dwm");
    await signIn(m.email);
    expect((await del({ password: "wrong-pass" })).status).toBe(401);
    expect((await del({})).status).toBe(401);
    expect(await getPerson(m.pid)).not.toBeNull();
    expect(await getMembership(o.aid, m.pid)).not.toBeNull();
    expect(await getMembership(m.other, m.pid)).not.toBeNull();
    expect(await currentUser()).not.toBeNull();
  });

  it("an owner is refused 409 owns_workspace and nothing changes", async () => {
    const o = await owner("dx");
    await signIn(o.u.email);
    const r = await del({ password: PASSWORD });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("owns_workspace");
    expect(await getPerson(o.pid)).not.toBeNull();
    expect(await getLogin(o.u.email)).not.toBeNull();
    expect(await currentUser()).not.toBeNull();
  });

  it("review B finding 5: a join that lands mid-delete keeps the person and says how many workspaces were left; a retry finishes", async () => {
    const o = await owner("dj");
    const m = await member(o, "djm");
    const ms = (await getMembership(o.aid, m.pid))!;
    let joined: AccountId | null = null;
    race.after = async () => { joined = (await addShadowMembership(m.pid, ms.acceptedAt!)).aid; };
    await signIn(m.email);
    const r = await del({ password: PASSWORD });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "left_partway", left: 2 });
    expect(joined).not.toBeNull();
    expect(await getPerson(m.pid)).not.toBeNull();
    expect(await getMembership(o.aid, m.pid)).toBeNull();
    expect(await getMembership(joined!, m.pid)).not.toBeNull();
    // The session still stands, and the retry leaves the newly joined workspace and deletes the person.
    const again = await del({ password: PASSWORD });
    expect(again.status).toBe(200);
    expect(await getPerson(m.pid)).toBeNull();
    expect(await getMembership(joined!, m.pid)).toBeNull();
  });

  it("an impersonation has no person (401); a legacy-shaped person is refused 409 delete_unavailable", async () => {
    const o = await owner("di");
    const m = await member(o, "dim");
    await signIn(m.email, { imp: "support-founder@test.example" });
    expect((await del({ password: PASSWORD })).status).toBe(401);
    expect(await getPerson(m.pid)).not.toBeNull();
    signOut();
    const legacyOwner = await newUser("dlo", { legacy: true, shadow: false });
    const lm = await newMember(legacyOwner, "member", "dlm", { legacy: true, shadow: false });
    await signIn(lm.email);
    const r = await del({ password: lm.password });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("delete_unavailable");
    expect(await getLogin(lm.email)).not.toBeNull();
  });

  it("five attempts an hour per person, then 429 with nothing deleted", async () => {
    const o = await owner("dl");
    const m = await member(o, "dlr");
    await signIn(m.email);
    for (let i = 0; i < 5; i++) expect((await del({ password: "wrong-pass" })).status).toBe(401);
    expect((await del({ password: PASSWORD })).status).toBe(429);
    expect(await getPerson(m.pid)).not.toBeNull();
    expect(await db.get(sessionKey(jar().get("thakeen_session")!))).not.toBeNull();
  });
});
