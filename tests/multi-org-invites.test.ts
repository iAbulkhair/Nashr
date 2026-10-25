import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import * as acceptRoute from "@/app/api/team/accept/route";
import { acct, currentUser, getUser, saveUser, sessionKey, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey, storedAccountId, type PersonId } from "@/lib/keys";
import { getMembership, ownerOf } from "@/lib/membership";
import { PERSON_ID } from "@/lib/multi-org";
import { getPerson } from "@/lib/person";
import { createInvite, listInvites, writeMembership } from "@/lib/team";
import { readTeamLog } from "@/lib/teamlog";
import { wsHandle } from "@/lib/ws-handle";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";


/**
 * Multi-workspace M2, invitations (docs/specs/2026-10-18-multi-org.md section 9), with `MULTI_ORG` on (the release switch since M2 enable).
 * Rule 2116: an address that already signs in is invited like a new one (only this account's own people get
 * `already_member`); it is accepted only from the person's own signed-in session with the verified address equal to the
 * invite's, never by address alone and never with a new password. Rule 2117: accepting as a new person makes a `p_`
 * person and a membership, no account. Rule 2118: the seats are counted under `lock:team` as before.
 */

const freshEmail = (p = "inv") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
/** The owner and its actor as a session resolves them (`currentUser`), so the invite runs as the routes run it. */
async function ownerSession(prefix: string) {
  const u = await pro(await newUser(prefix, { shadow: false }));
  await signIn(u.email);
  const me = (await currentUser())!;
  signOut();
  return { u, me, actor: me.actor! };
}
const invite = async (o: Awaited<ReturnType<typeof ownerSession>>, email: string, role: "admin" | "member" = "member") => createInvite(o.me, o.actor, email, role, "ar");
const accept = (body: Record<string, unknown>) => acceptRoute.POST(json("/api/team/accept", "POST", body));
const peek = async (token: string) => ((await (await accept({ token })).json()) as { preview?: { signIn?: boolean } }).preview;

describe("rule 2116: inviting an address that already signs in", () => {
  it("is answered like a new address; only this account's owner, members and the inviter get already_member", async () => {
    const A = await ownerSession("ia");
    const B = await newUser("ib", { shadow: false });
    const elsewhere = await newMember(B, "member", "ie", { shadow: false });
    const mine = await newMember(A.u, "member", "im", { shadow: false });
    const fresh = await invite(A, freshEmail());
    const other = await invite(A, B.email);
    const memberElsewhere = await invite(A, elsewhere.email);
    expect([fresh.ok, other.ok, memberElsewhere.ok]).toEqual([true, true, true]);
    expect(await invite(A, mine.email)).toEqual({ ok: false, error: "already_member" });
    expect(await invite(A, A.u.email)).toEqual({ ok: false, error: "already_member" });
    // A pending invite in this team stays "unavailable", as before.
    expect(await invite(A, B.email)).toEqual({ ok: false, error: "unavailable" });
  });

  it("the preview tells the invitee to sign in only when the address already has a login", async () => {
    const A = await ownerSession("ip");
    const B = await newUser("iq", { shadow: false });
    const toB = await invite(A, B.email);
    const toNew = await invite(A, freshEmail());
    if (!toB.ok || !toNew.ok) throw new Error("invite");
    expect((await peek(toB.token))?.signIn).toBe(true);
    expect((await peek(toNew.token))?.signIn).toBe(false);
  });
});

describe("rule 2116: an existing person accepts from their own session", () => {
  async function invited(role: "admin" | "member" = "member") {
    const A = await ownerSession("ja");
    const B = await newUser("jb", { shadow: false });
    const r = await invite(A, B.email, role);
    if (!r.ok) throw new Error(r.error);
    return { A, B, pid: ownerOf(B) as PersonId, token: r.token, aid: storedAccountId(acct(A.u)) };
  }

  it("signed in with the invited, verified address: the membership, the roster, orgs:, a joined row, the session and lastorg: move", async () => {
    const { A, B, pid, token, aid } = await invited("admin");
    const before = (await getPerson(pid))!;
    const sess = await signIn(B.email);
    const r = await accept({ token, join: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, href: `/ar/app/w/${wsHandle(aid)}` });
    const [ms, listed, org, last, s, invites, log, after] = await Promise.all([
      getMembership(aid, pid),
      db.sismember(accountKey.members(aid), pid),
      db.sismember(personKey.orgs(pid), aid),
      db.get(personKey.lastOrg(pid)),
      db.get<{ acct?: string }>(sessionKey(sess)),
      listInvites(aid),
      readTeamLog(aid),
      getPerson(pid),
    ]);
    expect(ms?.role).toBe("admin");
    expect([!!listed, !!org, last, s?.acct]).toEqual([true, true, aid, aid]);
    expect(invites).toEqual([]);
    expect(log.map((x) => x.kind)).toContain("joined");
    // No new password, no new person: the person's credentials are what they were.
    expect(after!.passHash).toBe(before.passHash);
    // B's own account is untouched and still B's.
    expect(ownerOf((await getUser(acct(B)))!)).toBe(pid);
    expect(A.u.email).not.toBe(B.email);
  });

  it("never by address alone: signed out 401, another person's session or an unverified address refused, nothing written", async () => {
    const { pid, token, aid } = await invited();
    signOut();
    expect((await accept({ token, join: true })).status).toBe(401);
    const stranger = await newUser("js", { shadow: false });
    await signIn(stranger.email);
    expect((await accept({ token, join: true })).status).toBe(400);
    const p = (await getPerson(pid))!;
    await db.set(personKey.person(pid), { ...(await db.get<Record<string, unknown>>(personKey.person(pid))), emailVerifiedAt: undefined });
    expect((await getPerson(pid))!.emailVerifiedAt).toBeUndefined();
    await signIn(p.email);
    expect((await accept({ token, join: true })).status).toBe(400);
    expect(await getMembership(aid, pid)).toBeNull();
    expect(await listInvites(aid)).toHaveLength(1);
  });

  it("the password way is refused for an address that signs in: signin_required, the invite and the person unchanged", async () => {
    const { pid, token, aid } = await invited();
    const before = (await getPerson(pid))!;
    signOut();
    const r = await accept({ token, name: "Someone", password: "newpass123" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("signin_required");
    expect((await getPerson(pid))!.passHash).toBe(before.passHash);
    expect(await getMembership(aid, pid)).toBeNull();
    expect(await listInvites(aid)).toHaveLength(1);
  });

  it("a person who joined since the invite gets already_member, and the invite stays", async () => {
    const { B, pid, token, aid } = await invited();
    await writeMembership(aid, pid, { aid, pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: ownerOf((await getUser(aid))!) }, { home: false, teamLocked: true });
    await signIn(B.email);
    const r = await accept({ token, join: true });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("already_member");
    expect(await listInvites(aid)).toHaveLength(1);
  });

  it("an impersonation cannot accept: 401", async () => {
    const { B, token } = await invited();
    await signIn(B.email, { imp: "founder@test.example" });
    expect((await accept({ token, join: true })).status).toBe(401);
  });

  it("rule 2118: no free seat is a 409 seats, nothing written", async () => {
    const { B, pid, token, aid } = await invited();
    const u = (await getUser(aid))!;
    // The owner and this invite already use both seats; the accept turns the invite into the member, so 1 seat is short.
    await saveUser({ ...u, seats: 1 });
    await signIn(B.email);
    const r = await accept({ token, join: true });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("seats");
    expect(await getMembership(aid, pid)).toBeNull();
  });
});

describe("rule 2117: accepting as a new person", () => {
  it("a p_ person and a membership: no account, no credits, not in users:all", async () => {
    const A = await ownerSession("ka");
    const email = freshEmail("knew");
    const r0 = await invite(A, email);
    if (!r0.ok) throw new Error(r0.error);
    const r = await accept({ token: r0.token, name: "New Person", password: "abc12345", lang: "ar" });
    expect(r.status).toBe(200);
    const aid = storedAccountId(acct(A.u));
    const roster = await db.smembers(accountKey.members(aid));
    const pid = roster.find((p) => PERSON_ID.test(p)) as PersonId;
    expect(pid).toBeTruthy();
    const [person, ms, own, inAll, legacy] = await Promise.all([getPerson(pid), getMembership(aid, pid), db.get(accountKey.user(pid)), db.sismember(globalKey.usersAll(), pid), db.get(accountKey.member(email))]);
    expect(person!.email).toBe(email);
    expect(ms?.role).toBe("member");
    expect(own).toBeNull();
    expect(inAll).toBeFalsy();
    expect(legacy).toBeNull();
    // Signed in, in the account just joined.
    const me = await currentUser();
    expect(me && acct(me)).toBe(acct(A.u));
    expect(me?.actor?.pid).toBe(pid);
  });
});
