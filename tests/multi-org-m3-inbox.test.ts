import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import * as acceptRoute from "@/app/api/team/accept/route";
import * as invitesRoute from "@/app/api/workspaces/invites/route";
import { acct, currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey, storedAccountId } from "@/lib/keys";
import { cancelInvite, createInvite, discardInvite, inviteId } from "@/lib/team";
import { json, newUser, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M3, the invitations inbox (docs/specs/2026-10-18-multi-org.md section 9; rule 2753), with `MULTI_ORG`
 * on for this file. `invitesfor:{email}` is written with the invite and read only for the signed-in person's own
 * verified address; the answer never holds an invite id, a token or an account id; accept, cancel and discard take the
 * entry out, and what no longer stands is dropped at read.
 */

const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
async function owner(prefix: string) {
  const u = await pro(await newUser(prefix, { shadow: false }));
  await signIn(u.email);
  const me = (await currentUser())!;
  signOut();
  return { u, me, actor: me.actor!, aid: storedAccountId(acct(u)) };
}
const inbox = async () => {
  const r = await invitesRoute.GET();
  return { status: r.status, text: await r.clone().text(), body: (await r.json()) as { ok: boolean; invites?: { workspace: string; inviter: string; role: string; expiresAt: string }[] } };
};
const HEX64 = /[a-f0-9]{64}/;

describe("rule 2753: the invitations inbox", () => {
  it("lists the open invites to the person's own address: workspace, inviter, role and expiry, never an id, token or account id", async () => {
    const A = await owner("xa");
    const C = await owner("xc");
    const B = await newUser("xb", { shadow: false });
    const one = await createInvite(A.me, A.actor, B.email, "admin", "ar");
    const two = await createInvite(C.me, C.actor, B.email, "member", "en");
    if (!one.ok || !two.ok) throw new Error("invite");
    expect((await db.smembers(accountKey.invitesFor(B.email))).sort()).toEqual([one.id, two.id].sort());
    expect(await db.ttl(accountKey.invitesFor(B.email))).toBeGreaterThan(0);
    await signIn(B.email);
    const r = await inbox();
    expect(r.status).toBe(200);
    expect(r.body.invites).toHaveLength(2);
    expect(r.body.invites!.map((i) => i.role).sort()).toEqual(["admin", "member"]);
    for (const i of r.body.invites!) expect(Object.keys(i).sort()).toEqual(["expiresAt", "inviter", "role", "workspace"]);
    expect(r.text).not.toMatch(HEX64);
    for (const s of [one.id, two.id, one.token, two.token, A.aid, C.aid]) expect(r.text).not.toContain(s);
  });

  it("is the session's own address only: another person sees nothing of it, an unverified address reads nothing", async () => {
    const A = await owner("ya");
    const B = await newUser("yb", { shadow: false });
    const r = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!r.ok) throw new Error(r.error);
    const stranger = await newUser("ys", { shadow: false });
    await signIn(stranger.email);
    expect((await inbox()).body.invites).toEqual([]);
    const late = await newUser("yu", { shadow: false, verified: false });
    const r2 = await createInvite(A.me, A.actor, late.email, "member", "ar");
    if (!r2.ok) throw new Error(r2.error);
    await signIn(late.email);
    const res = await invitesRoute.GET();
    // An unverified owner has no session that resolves; whatever the answer, it lists nothing.
    const body = (await res.json()) as { invites?: unknown[] };
    expect(body.invites ?? []).toEqual([]);
  });

  it("a forged entry naming another address's invite shows nothing and is dropped", async () => {
    const A = await owner("za");
    const B = await newUser("zb", { shadow: false });
    const C = await newUser("zc", { shadow: false });
    const toC = await createInvite(A.me, A.actor, C.email, "member", "ar");
    if (!toC.ok) throw new Error(toC.error);
    await db.sadd(accountKey.invitesFor(B.email), toC.id);
    await db.sadd(accountKey.invitesFor(B.email), "not-an-id");
    await signIn(B.email);
    expect((await inbox()).body.invites).toEqual([]);
    expect(await db.smembers(accountKey.invitesFor(B.email))).not.toContain(toC.id);
  });

  it("cancel and discard take the entry out; an accept does too", async () => {
    const A = await owner("wa");
    const B = await newUser("wb", { shadow: false });
    const c = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!c.ok) throw new Error(c.error);
    expect(await cancelInvite(A.me, A.actor, c.id)).toEqual({ ok: true });
    expect(await db.smembers(accountKey.invitesFor(B.email))).toEqual([]);

    const d = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!d.ok) throw new Error(d.error);
    await discardInvite(acct(A.u), d.id);
    expect(await db.smembers(accountKey.invitesFor(B.email))).toEqual([]);

    const e = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!e.ok) throw new Error(e.error);
    await signIn(B.email);
    const r = await acceptRoute.POST(json("/api/team/accept", "POST", { token: e.token, join: true }));
    expect(r.status).toBe(200);
    expect(await db.smembers(accountKey.invitesFor(B.email))).toEqual([]);
    expect(await db.get(globalKey.invite(inviteId(e.token)))).toBeNull();
  });

  it("an expired invite is not listed", async () => {
    const A = await owner("va");
    const B = await newUser("vb", { shadow: false });
    const r = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!r.ok) throw new Error(r.error);
    await db.set(globalKey.invite(r.id), { ...r.invite, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await signIn(B.email);
    expect((await inbox()).body.invites).toEqual([]);
  });

  it("signed out 401; an impersonation (no person) 401", async () => {
    signOut();
    expect((await invitesRoute.GET()).status).toBe(401);
    const B = await newUser(`ib${randomBytes(2).toString("hex")}`, { shadow: false });
    await signIn(B.email, { imp: "support-founder@test.example" });
    expect((await invitesRoute.GET()).status).toBe(401);
  });
});
