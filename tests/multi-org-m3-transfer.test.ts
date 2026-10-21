import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import * as offerRoute from "@/app/api/team/transfer/route";
import * as acceptRoute from "@/app/api/workspaces/transfer/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";
import { acct, createUser, currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { cardKey } from "@/lib/billing";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { createMcpToken, getMcpToken } from "@/lib/mcp";
import { getMembership, ownerOf } from "@/lib/membership";
import { newPersonId } from "@/lib/multi-org";
import { getPerson, updatePerson } from "@/lib/person";
import { can } from "@/lib/roles";
import { createMember, setRole } from "@/lib/team";
import { readTeamLog } from "@/lib/teamlog";
import { createWorkspace } from "@/lib/workspaces";
import { wsHandle } from "@/lib/ws-handle";
import { codeAt } from "./helpers/staff";
import { json, markVerified, newUser, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/** The mail the offer route sends, captured: the token rides only in the mailed link. */
const mail = vi.hoisted(() => ({ on: true, ok: true, sent: [] as { to: string; text: string; locale?: string }[] }));
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  mailReady: () => mail.on,
  sendEmail: async (m: { to: string; text: string; locale?: string }) => { mail.sent.push(m); return mail.ok; },
}));

/** The lock order of the accept (rule 2139): team → login → person → user, recorded as each lock is entered. */
const order = vi.hoisted(() => ({ on: false, seen: [] as string[] }));
vi.mock("@/lib/team", async (orig) => {
  const m = await orig<typeof import("@/lib/team")>();
  return {
    ...m,
    withAccountTeamLock: ((aid, fn) => { if (order.on) order.seen.push("team"); return m.withAccountTeamLock(aid, fn); }) as typeof m.withAccountTeamLock,
    withLoginLock: ((email, fn) => { if (order.on) order.seen.push("login"); return m.withLoginLock(email, fn); }) as typeof m.withLoginLock,
  };
});
vi.mock("@/lib/person", async (orig) => {
  const m = await orig<typeof import("@/lib/person")>();
  return { ...m, withPersonLock: ((pid, fn) => { if (order.on) order.seen.push("person"); return m.withPersonLock(pid, fn); }) as typeof m.withPersonLock };
});
vi.mock("@/lib/credits", async (orig) => {
  const m = await orig<typeof import("@/lib/credits")>();
  return { ...m, withUserLock: ((id, fn) => { if (order.on) order.seen.push("user"); return m.withUserLock(id, fn); }) as typeof m.withUserLock };
});

/**
 * Multi-workspace M3, ownership transfer (docs/specs/2026-10-18-multi-org.md section 11; rules 2128, 2139, 2750-2752),
 * with `MULTI_ORG` on for this file. The fixtures are `a_` accounts owned by `p_` persons and `p_` admins whatever
 * `TEST_PERSONS` says, because only that shape transfers (ruling 1); the legacy shape is pinned as refused.
 */

beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "xfer-connect-secret-one"); });
afterEach(() => { signOut(); mail.on = true; mail.ok = true; mail.sent.length = 0; order.on = false; order.seen.length = 0; });

let n = 0;
const address = (prefix: string) => `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`;
const PASSWORD = "abc12345";
const XFER = /#xfer=(w_[a-z2-7]{16})\.([a-f0-9]{64})/;

/** An `a_` account owned by a verified `p_` person, on a paid plan with a saved card and renewals on. */
async function owner(prefix: string): Promise<{ u: User; aid: AccountId; pid: PersonId }> {
  const made = await createUser({ email: address(prefix), name: "Owner", phone: "+966500000000", password: PASSWORD, lang: "ar" }, { opaque: true, person: "p" });
  await markVerified(made.email);
  const aid = storedAccountId(acct(made));
  const x = (await getUser(aid))!;
  const billing = { provider: "paymob" as const, plan: "pro" as const, status: "active" as const, paidThrough: "2026-11-20", anchor: 20, autoRenew: true, failures: 0, card: { brand: "visa", last4: "4242" }, txns: [] };
  await saveUser({ ...x, plan: "pro", seats: 10, billing } as User);
  await db.set(cardKey(aid), { token: "card-token-of-the-old-owner" });
  return { u: (await getUser(aid))!, aid, pid: storedPersonId(ownerOf(x)) };
}
/** A verified `p_` person holding `role` in the owner's account. */
async function person(o: { u: User; pid: PersonId }, role: "admin" | "member", prefix: string): Promise<{ email: string; pid: PersonId }> {
  const email = address(prefix);
  const pid = storedPersonId(newPersonId());
  await createMember(acct(o.u), { email, name: `P ${n}`, password: PASSWORD, lang: "en", role, invitedBy: o.u.email, invitedByPid: o.pid }, { pid });
  await updatePerson(pid, { emailVerifiedAt: new Date().toISOString() });
  return { email, pid };
}
const offer = (body: Record<string, unknown>) => offerRoute.POST(json("/api/team/transfer", "POST", body));
const accept = (body: Record<string, unknown>) => acceptRoute.POST(json("/api/workspaces/transfer", "POST", body));
const lastLink = () => { const m = XFER.exec(mail.sent.at(-1)?.text ?? ""); if (!m) throw new Error("no link"); return { handle: m[1], token: m[2] }; };

/** Owner offers to admin; returns the mailed handle and token. */
async function offered(o: { u: User }, to: { email: string }) {
  await signIn(o.u.email);
  const r = await offer({ email: to.email, password: PASSWORD });
  expect(r.status).toBe(200);
  signOut();
  return lastLink();
}

describe("rule 2750: an offer needs the owner's own session, password and (when on) authenticator code", () => {
  it("the owner offers to an enabled admin: one mail to the admin's address, the token only in the link's fragment, only its hash stored", async () => {
    const o = await owner("xo");
    const a = await person(o, "admin", "xa");
    await signIn(o.u.email);
    const r = await offer({ email: a.email, password: PASSWORD });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; offer: { email: string; expiresAt: string } };
    expect(body.offer.email).toBe(a.email);
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{64}/);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(a.email);
    expect(mail.sent[0].locale).toBe("en");
    const { handle, token } = lastLink();
    expect(handle).toBe(wsHandle(o.aid));
    const stored = (await db.get<Record<string, unknown>>(accountKey.xfer(o.aid)))!;
    expect(stored.toPid).toBe(a.pid);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(await db.ttl(accountKey.xfer(o.aid))).toBeGreaterThan(6 * 24 * 3600);
    expect((await readTeamLog(o.aid)).filter((x) => x.kind === "ownership_offered")).toHaveLength(1);
  });

  it("a wrong or missing password is refused and nothing is offered or mailed", async () => {
    const o = await owner("xp");
    const a = await person(o, "admin", "xpa");
    await signIn(o.u.email);
    expect((await offer({ email: a.email, password: "wrong-pass" })).status).toBe(401);
    expect((await offer({ email: a.email })).status).toBe(401);
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
    expect(mail.sent).toHaveLength(0);
  });

  it("with two-step sign-in on, the password alone and a recovery code are refused; a fresh authenticator code passes", async () => {
    const o = await owner("xm");
    const a = await person(o, "admin", "xma");
    await signIn(o.u.email);
    const ip = { "x-forwarded-for": "198.51.100.77" };
    const s = (await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: PASSWORD }, ip))).json()) as { ok: boolean; secret: string };
    expect(s.ok).toBe(true);
    const c = (await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, ip))).json()) as { ok: boolean; codes: string[] };
    expect(c.ok).toBe(true);
    expect((await offer({ email: a.email, password: PASSWORD })).status).toBe(400);
    expect((await offer({ email: a.email, password: PASSWORD, code: c.codes[0] })).status).toBe(400);
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
    expect((await offer({ email: a.email, password: PASSWORD, code: codeAt(s.secret, Date.now() + 30_000) })).status).toBe(200);
  });

  it("an impersonation, an admin and a member cannot offer or withdraw (403)", async () => {
    const o = await owner("xi");
    const a = await person(o, "admin", "xia");
    const m = await person(o, "member", "xim");
    await signIn(o.u.email, { imp: "support-founder@test.example" });
    expect(can((await currentUser())!, "team.transfer")).toBe(false);
    expect((await offer({ email: a.email, password: PASSWORD })).status).toBe(403);
    expect((await offerRoute.DELETE()).status).toBe(403);
    for (const who of [a, m]) {
      await signIn(who.email);
      expect((await offer({ email: a.email, password: PASSWORD })).status).toBe(403);
      expect((await offerRoute.DELETE()).status).toBe(403);
    }
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
    expect(mail.sent).toHaveLength(0);
  });

  it("only to an enabled admin of this account: a member, a stranger and an unverified admin are refused", async () => {
    const o = await owner("xn");
    const m = await person(o, "member", "xnm");
    const other = await owner("xnx");
    const theirs = await person(other, "admin", "xnt");
    const unverified = address("xnu");
    const upid = storedPersonId(newPersonId());
    await createMember(acct(o.u), { email: unverified, name: "U", password: PASSWORD, lang: "ar", role: "admin", invitedBy: o.u.email, invitedByPid: o.pid }, { pid: upid });
    await signIn(o.u.email);
    expect((await (await offer({ email: m.email, password: PASSWORD })).json()).error).toBe("not_admin");
    expect((await (await offer({ email: theirs.email, password: PASSWORD })).json()).error).toBe("not_admin");
    expect((await (await offer({ email: unverified, password: PASSWORD })).json()).error).toBe("transfer_unavailable");
    expect((await (await offer({ email: "not-an-address", password: PASSWORD })).json()).error).toBe("invalid_email");
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
  });

  it("a legacy-shape account and a partner account never transfer (ruling 1)", async () => {
    const legacy = await newUser("xl", { legacy: true, shadow: false });
    await signIn(legacy.email);
    const r = await offer({ email: address("xla"), password: PASSWORD });
    expect([403, 409]).toContain(r.status);
    const o = await owner("xq");
    const a = await person(o, "admin", "xqa");
    await db.set(`partner:${o.aid}`, { email: o.aid, name: "P", code: "PTEST", approvedAt: new Date().toISOString(), approvedBy: "founder@test.example" });
    await signIn(o.u.email);
    expect((await (await offer({ email: a.email, password: PASSWORD })).json()).error).toBe("transfer_unavailable");
  });

  it("no mail set up: 409 and nothing offered; a send that fails withdraws the offer (502)", async () => {
    const o = await owner("xs");
    const a = await person(o, "admin", "xsa");
    await signIn(o.u.email);
    mail.on = false;
    expect((await (await offer({ email: a.email, password: PASSWORD })).json()).error).toBe("mail_unavailable");
    mail.on = true;
    mail.ok = false;
    const r = await offer({ email: a.email, password: PASSWORD });
    expect(r.status).toBe(502);
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
  });
});

describe("rules 2128, 2751: the receiving admin accepts it, signed in as themselves, with the mailed token", () => {
  it("a wrong token, another person and an impersonation change nothing", async () => {
    const o = await owner("ya");
    const a = await person(o, "admin", "yaa");
    const b = await person(o, "admin", "yab");
    const { handle, token } = await offered(o, a);
    await signIn(a.email);
    expect((await accept({ handle, token: randomBytes(32).toString("hex") })).status).toBe(400);
    expect((await accept({ handle: "w_aaaaaaaaaaaaaaaa", token })).status).toBe(400);
    await signIn(b.email);
    expect((await accept({ handle, token })).status).toBe(400);
    const stranger = await owner("yas");
    await signIn(stranger.u.email);
    expect((await accept({ handle, token })).status).toBe(400);
    await signIn(o.u.email, { imp: "support-founder@test.example" });
    expect((await accept({ handle, token })).status).toBe(401);
    signOut();
    expect((await accept({ handle, token })).status).toBe(401);
    expect(ownerOf((await getUser(o.aid))!)).toBe(o.pid);
    expect(await db.get(accountKey.xfer(o.aid))).not.toBeNull();
  });

  it("rule 2752: the accept moves the account: owner, contact, card and renewals, AI access, memberships, one log row; single use", async () => {
    const o = await owner("yb");
    const a = await person(o, "admin", "yba");
    const { handle, token } = await offered(o, a);
    const mcp = await createMcpToken(o.aid);
    expect(mcp).toBeTruthy();
    await signIn(a.email);
    order.on = true;
    const r = await accept({ handle, token });
    order.on = false;
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; handle: string; href: string };
    expect(body.handle).toBe(handle);
    expect(body.href).toContain(handle);
    expect(order.seen.slice(0, 4)).toEqual(["team", "login", "person", "user"]);

    const after = (await getUser(o.aid))!;
    expect(after.ownerPid).toBe(a.pid);
    expect(after.email).toBe(a.email);
    expect(after.phone).toBe("");
    expect(after.emailVerifiedAt).toBeTruthy();
    expect(after.billing?.autoRenew).toBe(false);
    expect(after.billing?.card).toBeUndefined();
    expect(after.billing?.paidThrough).toBe("2026-11-20");
    expect(await db.get(cardKey(o.aid))).toBeNull();
    expect(await getMcpToken(o.aid)).toBeNull();
    expect((await getMembership(o.aid, o.pid))?.role).toBe("admin");
    expect(await getMembership(o.aid, a.pid)).toBeNull();
    const roster = await db.smembers(accountKey.members(o.aid));
    expect(roster).toContain(o.pid);
    expect(roster).not.toContain(a.pid);
    const rows = (await readTeamLog(o.aid)).filter((x) => x.kind === "ownership_transferred");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor.pid).toBe(o.pid);
    expect(rows[0].target.pid).toBe(a.pid);
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
    expect((await getPerson(o.pid))?.email).toBe(o.u.email);

    // The new owner's session is the owner now; the old owner's is an admin that cannot offer it back.
    expect(can((await currentUser())!, "team.transfer")).toBe(true);
    await signIn(o.u.email, { acct: o.aid });
    const old = (await currentUser())!;
    expect(acct(old)).toBe(o.aid);
    expect(old.actor?.role).toBe("admin");
    expect(can(old, "team.transfer")).toBe(false);

    await signIn(a.email);
    expect((await accept({ handle, token })).status).toBe(400);
    expect((await readTeamLog(o.aid)).filter((x) => x.kind === "ownership_transferred")).toHaveLength(1);
  });

  it("a withdrawn or expired offer no longer works", async () => {
    const o = await owner("yc");
    const a = await person(o, "admin", "yca");
    const first = await offered(o, a);
    await signIn(o.u.email);
    expect(await (await offerRoute.DELETE()).json()).toEqual({ ok: true, cancelled: true });
    await signIn(a.email);
    expect((await accept(first)).status).toBe(400);
    const second = await offered(o, a);
    const stored = (await db.get<Record<string, unknown>>(accountKey.xfer(o.aid)))!;
    await db.set(accountKey.xfer(o.aid), { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await signIn(a.email);
    expect((await accept(second)).status).toBe(400);
    expect(ownerOf((await getUser(o.aid))!)).toBe(o.pid);
  });

  it("a changed account voids the offer (admin demoted); a full owned-workspace cap keeps it (409)", async () => {
    const o = await owner("yd");
    const a = await person(o, "admin", "yda");
    const link = await offered(o, a);
    await signIn(o.u.email);
    const me = (await currentUser())!;
    const demoted = await setRole(me, me.actor!, a.email, "member");
    expect(demoted).toMatchObject({ ok: true });
    await signIn(a.email);
    expect((await (await accept(link)).json()).error).toBe("transfer_unavailable");
    expect(await db.get(accountKey.xfer(o.aid))).toBeNull();
    expect(ownerOf((await getUser(o.aid))!)).toBe(o.pid);

    const o2 = await owner("ye");
    const b = await person(o2, "admin", "yeb");
    const row = (await db.get<Record<string, unknown>>(personKey.person(b.pid)))!;
    await db.set(personKey.person(b.pid), { ...row, ownedCap: 1 });
    const made = await createWorkspace((await getPerson(b.pid))!, { name: "Own", lang: "en" });
    expect(made.ok).toBe(true);
    const link2 = await offered(o2, b);
    await signIn(b.email);
    const r = await accept(link2);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("workspace_cap");
    expect(await db.get(accountKey.xfer(o2.aid))).not.toBeNull();
    expect(ownerOf((await getUser(o2.aid))!)).toBe(o2.pid);
  });
});
