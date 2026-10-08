import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser, sc, type Plan, type User } from "@/lib/auth";
import { saveBrand, type Brand } from "@/lib/brand";
import { scopeFor } from "@/lib/brands";
import { createMember, getMember, listInvites, saveMember } from "@/lib/team";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { listNotifs } from "@/lib/notifications";
import { day } from "@/lib/track";
import { db } from "@/lib/db";

const sent: { to: string; subject: string; text: string }[] = [];
/** Switched off to play a provider that refuses the message (a rate limit, a quota, a rejected recipient). */
const mail = { works: true };
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (to: string, subject: string, text: string) => { if (!mail.works) return false; sent.push({ to, subject, text }); return true; } }));

import * as login from "@/app/api/auth/login/route";
import * as forgot from "@/app/api/auth/forgot/route";
import * as reset from "@/app/api/auth/reset/route";
import * as signup from "@/app/api/auth/signup/route";
import * as account from "@/app/api/account/route";
import * as profile from "@/app/api/profile/route";
import * as team from "@/app/api/team/route";
import * as invite from "@/app/api/team/invite/route";
import * as accept from "@/app/api/team/accept/route";
import * as memberRoute from "@/app/api/team/member/route";
import * as leave from "@/app/api/team/leave/route";
import * as plan from "@/app/api/admin/plan/route";
import * as notifications from "@/app/api/notifications/route";
import * as adminUsers from "@/app/api/admin/users/[email]/route";

/**
 * The teams flows at the route level (docs/superpowers/specs/2026-09-29-teams-design.md §6): every login acts on its own
 * record, a member never touches the owner's hash, sessions or tokens, invites are single use and seat-counted, and a
 * removed or paused member is out at its next request. The library rules underneath are pinned in teams-core.test.ts.
 */

const FOUNDER = "founder-flows@test.example";
const ADMIN_KEY = "flows-admin-key-0123456789";
const MEMBER_PW = "member999";

// Every call gets its own client IP, so one test's throttle window never leaks into another's.
let ipN = 0;
const ip = () => { ipN++; return { "x-forwarded-for": `198.18.${Math.floor(ipN / 250)}.${ipN % 250}` }; };
const freshEmail = (p = "inv") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const withPlan = async (u: User, p: Plan, seats?: number) => { const x = { ...(await getUser(u.email))!, plan: p, seats }; await saveUser(x); return x; };
/** A member with its OWN password (newMember shares the owner's test password, which would hide a cross-check). */
const memberWithOwnPassword = async (owner: User, role: "admin" | "member" = "member") => {
  const email = freshEmail("m");
  await createMember(owner.email, { email, name: "Own Pass", password: MEMBER_PW, lang: "en", role, invitedBy: owner.email });
  return email;
};
const loginAs = (email: string, password: string) => login.POST(json("/api/auth/login", "POST", { email, password }, ip()));
const inviteReq = (body: unknown) => invite.POST(json("/api/team/invite", "POST", body, ip()));
const tokenOf = (text: string) => text.match(/#t=([a-f0-9]{64})/)![1];
const resetTokenOf = (text: string) => text.match(/\/app\/reset#t=([a-f0-9]{64})/)![1];
const sessionRec = () => db.get<{ email: string; at: number }>(`session:${jar().get("nashr_session")}`);

beforeEach(() => {
  sent.length = 0;
  mail.works = true;
  signOut();
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>");
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  vi.stubEnv("WAITLIST_ADMIN_KEY", ADMIN_KEY);
});

describe("login: every login is checked against its own password", () => {
  it("a member signs in with its own password into the owner's workspace; the owner's password does not open it, and the member's does not open the owner", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);

    expect((await loginAs(m, "abc12345")).status, "the owner's password is not the member's").toBe(401);
    expect((await loginAs(owner.email, MEMBER_PW)).status, "the member's password is not the owner's").toBe(401);

    expect((await loginAs(m, MEMBER_PW)).status).toBe(200);
    expect((await sessionRec())!.email, "the session is issued for the member's own login").toBe(m);
    const u = (await currentUser())!;
    expect(u.email).toBe(owner.email);
    expect(u.actor).toMatchObject({ kind: "member", email: m, role: "member" });
    expect(sc(u)).toBe(scopeFor(owner.email, "default"));
    // Analytics count the ACCOUNT, so nothing keyed by the member's address is left behind when the account is wiped.
    const active = await db.smembers(`active:d:${day()}`);
    expect(active).toContain(owner.email);
    expect(active).not.toContain(m);

    expect((await loginAs(owner.email, "abc12345")).status).toBe(200);
    expect((await currentUser())!.actor).toMatchObject({ kind: "owner", email: owner.email });
  });

  it("refuses a member whose owner is suspended, and a member paused by the seat limit", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    await saveMember({ ...(await getMember(m))!, disabled: "seats" });
    const paused = await loginAs(m, MEMBER_PW);
    expect(paused.status).toBe(403);
    expect(await paused.json()).toMatchObject({ error: "disabled" });
    expect(jar().get("nashr_session"), "no session is issued").toBeUndefined();

    const m2 = await memberWithOwnPassword(owner);
    await saveUser({ ...(await getUser(owner.email))!, suspended: true });
    const susp = await loginAs(m2, MEMBER_PW);
    expect(susp.status).toBe(403);
    expect(await susp.json()).toMatchObject({ error: "suspended" });
  });
});

describe("a member's password is its own", () => {
  it("changing it rewrites the member record only: the owner's hash, sessions and MCP token are untouched, and this device stays the member", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    const ownerSession = await signIn(owner.email);
    const token = await createMcpToken(owner.email);
    const before = (await getUser(owner.email))!;
    const otherDevice = await signIn(m);
    await signIn(m);

    const wrong = await account.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "fresh1234" }));
    expect(wrong.status, "the owner's password does not authorise a member's change").toBe(401);

    const ok = await account.PATCH(json("/api/account", "PATCH", { currentPassword: MEMBER_PW, newPassword: "fresh1234" }));
    expect(ok.status).toBe(200);
    expect((await sessionRec())!.email, "re-signed in as the member, never as the owner").toBe(m);
    expect((await currentUser())!.actor).toMatchObject({ kind: "member", email: m });

    const after = (await getUser(owner.email))!;
    expect(after.passHash).toBe(before.passHash);
    expect(after.sessionsAfter).toBe(before.sessionsAfter);
    expect(after.teamSessionsAfter).toBeUndefined();
    expect(await userFromBearer(new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${token}` } }))).not.toBeNull();
    jar().set("nashr_session", ownerSession);
    expect((await currentUser())!.actor!.kind, "the owner stays signed in").toBe("owner");
    jar().set("nashr_session", otherDevice);
    expect(await currentUser(), "the member's other device is signed out").toBeNull();

    expect((await loginAs(m, MEMBER_PW)).status).toBe(401);
    expect((await loginAs(m, "fresh1234")).status).toBe(200);
  });

  it("a member cannot delete the account, not even with the owner's password, and neither can a founder impersonating; the owner's delete takes the team with it", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner, "admin");
    await signIn(m);
    for (const password of ["abc12345", MEMBER_PW]) {
      const res = await account.DELETE(json("/api/account", "DELETE", { password }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    await signIn(owner.email, { imp: FOUNDER });
    expect((await account.DELETE(json("/api/account", "DELETE", { password: "abc12345" }))).status).toBe(403);
    expect((await account.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "fresh1234" }))).status).toBe(403);
    expect(await getUser(owner.email)).not.toBeNull();

    await signIn(owner.email);
    expect((await account.DELETE(json("/api/account", "DELETE", { password: MEMBER_PW }))).status).toBe(401);
    expect((await account.DELETE(json("/api/account", "DELETE", { password: "abc12345" }))).status).toBe(200);
    expect(await getUser(owner.email)).toBeNull();
    expect(await getMember(m), "every member login goes with the account").toBeNull();
  });
});

describe("forgot and reset act on the login the link was issued for", () => {
  it("a member's reset sets the member's password and signs the member in; the owner is untouched", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    const ownerSession = await signIn(owner.email);
    const token = await createMcpToken(owner.email);
    const before = (await getUser(owner.email))!;
    signOut();

    await forgot.POST(json("/api/auth/forgot", "POST", { email: m }, ip()));
    expect(sent.map((x) => x.to)).toEqual([m]);
    const t = resetTokenOf(sent[0].text);
    expect(await db.get(`pwreset:${sha(t)}`)).toEqual({ email: m, kind: "member" });

    expect((await reset.POST(json("/api/auth/reset", "POST", { token: t, password: "reset1234" }, ip()))).status).toBe(200);
    expect((await sessionRec())!.email).toBe(m);
    expect((await currentUser())!.actor).toMatchObject({ kind: "member", email: m });
    expect((await reset.POST(json("/api/auth/reset", "POST", { token: t, password: "again1234" }, ip()))).status, "single use").toBe(400);

    const after = (await getUser(owner.email))!;
    expect(after.passHash).toBe(before.passHash);
    expect(after.sessionsAfter).toBe(before.sessionsAfter);
    expect(after.teamSessionsAfter, "a member's reset never signs the team out").toBeUndefined();
    expect(await userFromBearer(new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${token}` } }))).not.toBeNull();
    jar().set("nashr_session", ownerSession);
    expect((await currentUser())!.actor!.kind).toBe("owner");
    expect((await loginAs(m, "reset1234")).status).toBe(200);
    expect((await loginAs(owner.email, "reset1234")).status).toBe(401);
  });

  it("an owner's reset signs every member out; each signs back in with its own password", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    const memberSession = await signIn(m);
    signOut();
    await forgot.POST(json("/api/auth/forgot", "POST", { email: owner.email }, ip()));
    const t = resetTokenOf(sent[0].text);
    expect(await db.get(`pwreset:${sha(t)}`)).toEqual({ email: owner.email, kind: "owner" });
    expect((await reset.POST(json("/api/auth/reset", "POST", { token: t, password: "owner1234" }, ip()))).status).toBe(200);
    jar().set("nashr_session", memberSession);
    expect(await currentUser()).toBeNull();
    expect((await loginAs(m, MEMBER_PW)).status).toBe(200);
  });

  it("a reset link is refused once its login changed sides", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    await forgot.POST(json("/api/auth/forgot", "POST", { email: m }, ip()));
    const t = resetTokenOf(sent[0].text);
    await signIn(owner.email);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email: m }))).status).toBe(200);
    signOut();
    expect((await reset.POST(json("/api/auth/reset", "POST", { token: t, password: "reset1234" }, ip()))).status).toBe(400);
    expect(jar().get("nashr_session")).toBeUndefined();
  });
});

describe("signup", () => {
  it("refuses an address that is a member login, with the same answer as an existing account", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    const asMember = await signup.POST(json("/api/auth/signup", "POST", { email: m, password: "abc12345", name: "Squat" }, ip()));
    const asOwner = await signup.POST(json("/api/auth/signup", "POST", { email: owner.email, password: "abc12345", name: "Squat" }, ip()));
    expect(asMember.status).toBe(409);
    expect(await asMember.json()).toEqual(await asOwner.json());
    expect(await getUser(m), "no owner record at a member's address").toBeNull();
    expect(await db.smembers("users:all")).not.toContain(m);
    expect((await getMember(m))!.memberOf).toBe(owner.email);
  });
  it("the founder console finds a member login by address and can remove it, which frees the address for signup", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    const byKey = { "x-admin-key": ADMIN_KEY };
    const at = { params: Promise.resolve({ email: encodeURIComponent(m) }) };
    const found = await adminUsers.GET(new Request(`https://nashr.test/api/admin/users/${m}`, { headers: byKey }), at);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ ok: true, kind: "member", member: { email: m, memberOf: owner.email, ownerExists: true, onRoster: true } });
    // Only removal applies to a member login, and only the console may do it.
    expect((await adminUsers.POST(json(`/api/admin/users/${m}`, "POST", { action: "suspend" }, byKey), { params: Promise.resolve({ email: m }) })).status).toBe(400);
    expect((await adminUsers.POST(json(`/api/admin/users/${m}`, "POST", { action: "removeMember" }), { params: Promise.resolve({ email: m }) })).status).toBe(401);
    const gone = await adminUsers.POST(json(`/api/admin/users/${m}`, "POST", { action: "removeMember", reason: "address owner asked" }, byKey), { params: Promise.resolve({ email: m }) });
    expect(gone.status).toBe(200);
    expect(await getMember(m)).toBeNull();
    const log = (await db.lrange("admin:log", 0, 0)).map((x) => JSON.parse(x) as { what: string; email: string; actor: string });
    expect(log[0]).toMatchObject({ what: "removeMember", email: m, actor: "key" });
    expect((await signup.POST(json("/api/auth/signup", "POST", { email: m, password: "abc12345", name: "Real owner" }, ip()))).status).toBe(200);
  });
});

describe("invite, preview and accept", () => {
  it("end to end: the link previews without consuming, accepting creates a member login signed in to the owner's workspace", async () => {
    const owner = await newUser("own");
    const addr = freshEmail("join");
    await signIn(owner.email);
    const res = await inviteReq({ email: addr, role: "member" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; invite: { id: string; email: string; role: string; expiresAt: string }; emailed: boolean; link?: string };
    expect(body).toMatchObject({ ok: true, emailed: true, invite: { email: addr, role: "member" } });
    expect(body.link, "an emailed link is never also handed back").toBeUndefined();
    expect(sent.map((x) => x.to)).toEqual([addr]);
    expect(sent[0].text, "the token travels in the fragment, never a query string").toMatch(/\/ar\/app\/join#t=[a-f0-9]{64}/);
    const token = tokenOf(sent[0].text);
    expect(body.invite.id).toBe(sha(token));
    expect(await db.get(`invite:${token}`), "the token itself is never a key").toBeNull();

    const view = (await (await team.GET()).json()) as { seats: { used: number; limit: number }; invites: { id: string }[] };
    expect(view.seats).toEqual({ used: 2, limit: 3 });
    expect(view.invites.map((i) => i.id)).toEqual([body.invite.id]);

    signOut();
    const peek = await accept.POST(json("/api/team/accept", "POST", { token }, ip()));
    expect(peek.status).toBe(200);
    expect(((await peek.json()) as { preview: unknown }).preview).toMatchObject({ email: addr, role: "member", inviter: owner.name });
    expect(await listInvites(owner.email), "a preview consumes nothing").toHaveLength(1);

    expect((await accept.POST(json("/api/team/accept", "POST", { token, name: "Sara", password: "weak" }, ip()))).status).toBe(400);
    const ok = await accept.POST(json("/api/team/accept", "POST", { token, name: "Sara", password: "sara12345" }, ip()));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const u = (await currentUser())!;
    expect(u.email).toBe(owner.email);
    expect(u.actor).toMatchObject({ kind: "member", email: addr, name: "Sara", role: "member" });
    expect(sc(u), "the member works in the OWNER's workspace, never one keyed by its own address").toBe(scopeFor(owner.email, "default"));
    expect(await getUser(addr), "accepting never creates an owner account").toBeNull();
    expect(await db.smembers("users:all")).not.toContain(addr);

    expect((await accept.POST(json("/api/team/accept", "POST", { token, name: "Again", password: "sara12345" }, ip()))).status, "single use").toBe(400);
    expect((await accept.POST(json("/api/team/accept", "POST", { token }, ip()))).status).toBe(400);

    const roster = (await (await team.GET()).json()) as { you: { email: string; role: string }; members: { email: string; role: string }[]; invites: unknown[] };
    expect(roster.you).toMatchObject({ email: addr, role: "member" });
    expect(roster.members.map((x) => [x.email, x.role])).toEqual([[owner.email, "owner"], [addr, "member"]]);
    expect(roster.invites, "pending invites are for admins and the owner").toEqual([]);

    const bell = await listNotifs(owner.email);
    expect(bell.map((n) => n.href)).toEqual(["/ar/app/team", "/ar/app/team"]);
    // Only the "joined" notice names the address, and a member who joined is on the roster anyway. The invite notice
    // names nobody: the bell is shared by every login, and pending invites are for admins and the owner.
    expect(bell.filter((n) => JSON.stringify(n).includes(addr))).toHaveLength(1);
    expect((await loginAs(addr, "sara12345")).status).toBe(200);
  });

  it("without working mail the link is returned once to the inviter, and only its hash is stored", async () => {
    vi.stubEnv("MAIL_FROM", "");
    const owner = await newUser("own");
    await signIn(owner.email);
    const body = (await (await inviteReq({ email: freshEmail(), role: "member", lang: "en" })).json()) as { emailed: boolean; link: string; invite: { id: string } };
    expect(body.emailed).toBe(false);
    expect(body.link).toMatch(/\/en\/app\/join#t=[a-f0-9]{64}$/);
    expect(sent).toHaveLength(0);
    const token = tokenOf(body.link);
    expect(sha(token)).toBe(body.invite.id);
    expect(await db.get(`invite:${token}`)).toBeNull();
    expect(await db.get(`invite:${body.invite.id}`)).not.toBeNull();
  });

  it("with mail set up, a failed send withdraws the invite and never hands the link to the inviter", async () => {
    const owner = await newUser("own");
    await signIn(owner.email);
    mail.works = false;
    const res = await inviteReq({ email: freshEmail(), role: "member" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "send_failed" });
    expect(JSON.stringify(body)).not.toMatch(/#t=/);
    expect(await listInvites(owner.email), "no invite is left holding a seat").toEqual([]);
    expect(await listNotifs(owner.email)).toEqual([]);
  });

  it("the invitation email is a fixed template: the inviter's address, never a display name or brand name typed by the sender", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    await saveUser({ ...(await getUser(owner.email))!, name: "Thakeen Security Team" });
    await saveBrand(owner.email, { name: "Account locked - verify at evil.example", website: "", industry: "", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" } as Brand);
    await signIn(owner.email);
    for (const lang of ["ar", "en"] as const) {
      sent.length = 0;
      expect((await inviteReq({ email: freshEmail(), role: "member", lang })).status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain(owner.email);
      expect(sent[0].text).not.toContain("evil.example");
      expect(sent[0].text).not.toContain("Thakeen Security Team");
    }
  });

  it("a plain member's bell never shows who was invited, as the Members page does not", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const plain = await newMember(owner, "member");
    const secret = freshEmail("secret-hire");
    await signIn(owner.email);
    expect((await inviteReq({ email: secret, role: "admin" })).status).toBe(200);
    await signIn(plain.email);
    expect(((await (await team.GET()).json()) as { invites: unknown[] }).invites).toEqual([]);
    const bell = await (await notifications.GET(new Request("https://nashr.test/api/notifications"))).text();
    expect(bell).not.toContain(secret);
    expect(bell).not.toContain("secret-hire");
  });

  it("caps invites per address across accounts, and a free trial sends fewer a day than a paid plan", async () => {
    const target = freshEmail("target");
    for (let i = 0; i < 5; i++) {
      const o = await withPlan(await newUser("own"), "agency");
      await signIn(o.email);
      expect((await inviteReq({ email: target, role: "member" })).status).toBe(200);
    }
    const sixth = await withPlan(await newUser("own"), "agency");
    await signIn(sixth.email);
    expect((await inviteReq({ email: target, role: "member" })).status, "the sixth account to invite one address in a day").toBe(429);

    const trial = await newUser("own");
    await signIn(trial.email);
    for (let i = 0; i < 5; i++) expect((await inviteReq({ email: `bad-${i}`, role: "member" })).status).toBe(400);
    expect((await inviteReq({ email: freshEmail(), role: "member" })).status, "the sixth attempt from a trial in a day").toBe(429);
  });

  it("an admin invites plain members only, a plain member and a founder impersonating cannot invite at all", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    const plain = await newMember(owner, "member");

    await signIn(admin.email);
    const ok = await inviteReq({ email: freshEmail(), role: "member" });
    expect(ok.status).toBe(200);
    const id = ((await ok.json()) as { invite: { id: string } }).invite.id;
    const promote = await inviteReq({ email: freshEmail(), role: "admin" });
    expect(promote.status).toBe(403);
    expect(await promote.json()).toEqual({ error: "forbidden" });
    const seen = (await (await team.GET()).json()) as { invites: { id: string; invitedBy: string }[] };
    expect(seen.invites).toEqual([expect.objectContaining({ id, invitedBy: admin.email })]);

    await signIn(plain.email);
    expect((await inviteReq({ email: freshEmail(), role: "member" })).status).toBe(403);
    expect((await invite.DELETE(json("/api/team/invite", "DELETE", { id }))).status).toBe(403);
    await signIn(owner.email, { imp: FOUNDER });
    expect((await inviteReq({ email: freshEmail(), role: "member" })).status).toBe(403);

    await signIn(admin.email);
    expect((await invite.DELETE(json("/api/team/invite", "DELETE", { id }))).status).toBe(200);
    expect(await listInvites(owner.email)).toHaveLength(0);
    expect((await invite.DELETE(json("/api/team/invite", "DELETE", { id }))).status).toBe(404);
  });

  it("answers one generic 409 for the owner's own address, an existing login and a pending invite, and validates input", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const other = await newUser("other");
    const m = await memberWithOwnPassword(await newUser("elsewhere"));
    const pending = freshEmail();
    await signIn(owner.email);
    expect((await inviteReq({ email: pending, role: "member" })).status).toBe(200);
    for (const email of [owner.email, other.email, m, pending, ` ${pending.toUpperCase()} `]) {
      const res = await inviteReq({ email, role: "member" });
      expect(res.status, email).toBe(409);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
    const bad = await inviteReq({ email: "not-an-email", role: "member" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_email" });
    const role = await inviteReq({ email: freshEmail(), role: "owner" });
    expect(role.status).toBe(400);
    expect(await role.json()).toEqual({ error: "invalid_role" });
  });

  it("counts seats: Starter has one, so any invite is refused with the count; a trial fills at three", async () => {
    const starter = await withPlan(await newUser("own"), "starter");
    await signIn(starter.email);
    const full = await inviteReq({ email: freshEmail(), role: "member" });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "seats", used: 1, limit: 1 });

    const trial = await newUser("own");
    await signIn(trial.email);
    expect((await inviteReq({ email: freshEmail(), role: "member" })).status).toBe(200);
    expect((await inviteReq({ email: freshEmail(), role: "admin" })).status).toBe(200);
    expect(await (await inviteReq({ email: freshEmail(), role: "member" })).json()).toEqual({ error: "seats", used: 3, limit: 3 });
  });

  it("an accept is re-checked against the seats at that moment", async () => {
    const owner = await withPlan(await newUser("own"), "pro");
    await signIn(owner.email);
    const body = (await (await inviteReq({ email: freshEmail(), role: "member" })).json()) as { invite: { id: string } };
    const token = tokenOf(sent[0].text);
    expect(sha(token)).toBe(body.invite.id);
    // The plan shrinks after the invite was sent: the founder console cancels invites that no longer fit.
    const res = await plan.POST(json("/api/admin/plan", "POST", { email: owner.email, plan: "starter" }, { "x-admin-key": ADMIN_KEY }));
    expect(res.status).toBe(200);
    signOut();
    expect((await accept.POST(json("/api/team/accept", "POST", { token, name: "Late", password: "late12345" }, ip()))).status).toBe(400);
    expect(jar().get("nashr_session")).toBeUndefined();
  });

  it("is rate limited: invites per account per day, accepts and previews per IP", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    await signIn(owner.email);
    for (let i = 0; i < 20; i++) expect((await inviteReq({ email: `bad-${i}`, role: "member" })).status).toBe(400);
    const limited = await inviteReq({ email: freshEmail(), role: "member" });
    expect(limited.status, "the 21st attempt from one account in a day").toBe(429);
    expect(limited.headers.get("retry-after"), "the daily bucket refused (rule 680)").toBe("86400");
    expect(await limited.json()).toEqual({ error: "rate_limited" });

    signOut();
    const h = ip();
    const guess = () => accept.POST(json("/api/team/accept", "POST", { token: "a".repeat(64), name: "X", password: "abc12345" }, h));
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(400);
    expect((await guess()).status).toBe(429);
    const p = ip();
    const peek = () => accept.POST(json("/api/team/accept", "POST", { token: "b".repeat(64) }, p));
    for (let i = 0; i < 30; i++) expect((await peek()).status).toBe(400);
    expect((await peek()).status).toBe(429);
  });
});

describe("removal, leaving and roles take effect at the next request", () => {
  it("a removed member is out at once; a member who leaves is signed out; the owner cannot leave", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const gone = await memberWithOwnPassword(owner);
    const leaver = await memberWithOwnPassword(owner);
    const goneSession = await signIn(gone);
    expect(await currentUser()).not.toBeNull();

    await signIn(owner.email);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email: gone }))).status).toBe(200);
    jar().set("nashr_session", goneSession);
    expect(await currentUser()).toBeNull();
    expect((await loginAs(gone, MEMBER_PW)).status).toBe(401);
    expect(await db.get(`activebrand:${gone}`)).toBeNull();

    const leaverSession = await signIn(leaver);
    expect((await leave.POST()).status).toBe(200);
    expect(jar().get("nashr_session"), "the cookie is cleared").toBeUndefined();
    jar().set("nashr_session", leaverSession);
    expect(await currentUser()).toBeNull();
    expect(await getMember(leaver)).toBeNull();

    await signIn(owner.email);
    expect((await leave.POST()).status).toBe(403);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email: gone }))).status).toBe(404);
  });

  it("an admin removes plain members but not another admin", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    const admin2 = await newMember(owner, "admin");
    const plain = await newMember(owner, "member");
    await signIn(admin.email);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email: admin2.email }))).status).toBe(403);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email: plain.email }))).status).toBe(200);
    expect(await getMember(admin2.email)).not.toBeNull();
  });

  it("only the owner changes roles, and the change applies at the member's next request", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const m = await newMember(owner, "member");
    const admin = await newMember(owner, "admin");
    await signIn(admin.email);
    expect((await memberRoute.PATCH(json("/api/team/member", "PATCH", { email: m.email, role: "admin" }))).status).toBe(403);
    await signIn(owner.email);
    expect((await memberRoute.PATCH(json("/api/team/member", "PATCH", { email: m.email, role: "owner" }))).status).toBe(400);
    const session = await signIn(m.email);
    expect((await currentUser())!.actor!.role).toBe("member");
    await signIn(owner.email);
    expect((await memberRoute.PATCH(json("/api/team/member", "PATCH", { email: m.email, role: "admin" }))).status).toBe(200);
    jar().set("nashr_session", session);
    expect((await currentUser())!.actor!.role).toBe("admin");
  });

  it("every team route needs a session", async () => {
    signOut();
    const calls = [
      () => team.GET(),
      () => inviteReq({ email: freshEmail(), role: "member" }),
      () => invite.DELETE(json("/api/team/invite", "DELETE", { id: "a".repeat(64) })),
      () => memberRoute.PATCH(json("/api/team/member", "PATCH", { email: "x@test.example", role: "admin" })),
      () => memberRoute.DELETE(json("/api/team/member", "DELETE", { email: "x@test.example" })),
      () => leave.POST(),
    ];
    for (const c of calls) expect((await c()).status).toBe(401);
  });
});

describe("a plan change refits the team (founder console)", () => {
  it("a downgrade pauses the newest members, an upgrade or a seat override brings them back, and each change is logged by its actor", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const emails = [await memberWithOwnPassword(owner), await memberWithOwnPassword(owner), await memberWithOwnPassword(owner)];
    // Distinct join times after the account was created, oldest first, so "newest" is not decided by a tie.
    const created = new Date(owner.createdAt).getTime();
    await Promise.all(emails.map(async (e, i) => saveMember({ ...(await getMember(e))!, acceptedAt: new Date(created + (i + 1) * 1000).toISOString() })));
    const newestSession = await signIn(emails[2]);
    expect((await currentUser())!.actor!.email, "the newest member is signed in before the downgrade").toBe(emails[2]);
    const call = (body: Record<string, unknown>) => plan.POST(json("/api/admin/plan", "POST", { email: owner.email, ...body }, { "x-admin-key": ADMIN_KEY }));
    const paused = async () => (await Promise.all(emails.map(getMember))).map((m) => !!m!.disabled);

    const down = await call({ plan: "pro" });
    expect(down.status).toBe(200);
    expect(((await down.json()) as { team: { disabled: string[] } }).team.disabled).toEqual([emails[2]]);
    expect(await paused()).toEqual([false, false, true]);
    jar().set("nashr_session", newestSession);
    expect(await currentUser(), "a paused member is out at its next request").toBeNull();
    expect(await (await loginAs(emails[2], MEMBER_PW)).json()).toMatchObject({ error: "disabled" });

    expect((await call({ plan: "starter" })).status).toBe(200);
    expect(await paused()).toEqual([true, true, true]);

    const up = await call({ seats: 7, reason: "custom deal" });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { user: { seats: number } }).user.seats).toBe(7);
    expect(await paused()).toEqual([false, false, false]);
    expect((await getUser(owner.email))!.seats).toBe(7);
    const last = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { actor: string; what: string; team?: { enabled: string[] } };
    expect(last.actor, "logged as the console key, not a generic 'founder'").toBe("key");
    expect(last.what).toBe("seats:7");
    expect(last.team!.enabled).toEqual(emails);

    expect((await call({ seats: -1 })).status).toBe(400);
    expect((await call({ seats: 2.5 })).status).toBe(400);
    expect((await call({ seats: null })).status).toBe(200);
    expect((await getUser(owner.email))!.seats, "null goes back to the plan's seats").toBeUndefined();
    expect(await paused()).toEqual([true, true, true]);
  });
});

describe("profile", () => {
  it("GET gives a member its own identity and the account summary, never the owner's phone or account settings", async () => {
    const owner = await newUser("own");
    await saveUser({ ...(await getUser(owner.email))!, phone: "+966500000123" });
    const m = await memberWithOwnPassword(owner);
    await signIn(m);
    const res = await profile.GET();
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown> & { user: Record<string, unknown> };
    expect(body.role).toBe("member");
    expect(body.me).toEqual({ name: "Own Pass", email: m, lang: "en", role: "member" });
    expect(body.user).toMatchObject({ email: m, name: "Own Pass", role: "member", plan: "trial", credits: 50 });
    for (const k of ["phone", "sessionsAfter", "agentSpend", "passHash", "teamSessionsAfter"]) expect(body.user, k).not.toHaveProperty(k);
    expect(body).not.toHaveProperty("emails");
    expect(raw).not.toContain("500000123");
    expect(raw).not.toContain("passHash");

    await signIn(owner.email);
    const own = (await (await profile.GET()).json()) as { role: string; emails: string; user: Record<string, unknown> };
    expect(own.role).toBe("owner");
    expect(own.user).toMatchObject({ email: owner.email, phone: "+966500000123", role: "owner" });
    expect(own.emails).toBe("all");
    expect(own.user).not.toHaveProperty("passHash");
    expect(own.user).not.toHaveProperty("actor");
  });

  it("GET says which account forms this person may use: a founder viewing the account holds the owner role yet may use neither", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    const may = async () => (await (await profile.GET()).json()) as { role: string; may: { passwordChange: boolean; accountDelete: boolean }; impersonating: boolean };
    await signIn(owner.email);
    expect(await may()).toMatchObject({ role: "owner", may: { passwordChange: true, accountDelete: true }, impersonating: false });
    await signIn(m);
    expect(await may()).toMatchObject({ role: "member", may: { passwordChange: true, accountDelete: false }, impersonating: false });
    await signIn(owner.email, { imp: FOUNDER });
    expect(await may()).toMatchObject({ role: "owner", may: { passwordChange: false, accountDelete: false }, impersonating: true });
  });

  it("PUT by a member changes only the member's own name and language; account and brand fields are refused whole", async () => {
    const owner = await newUser("own");
    const m = await memberWithOwnPassword(owner);
    await signIn(m);
    const put = (body: Record<string, string>) => profile.PUT(json("/api/profile", "PUT", body));

    expect((await put({ name: "Renamed Member", lang: "ar" })).status).toBe(200);
    expect(await getMember(m)).toMatchObject({ name: "Renamed Member", lang: "ar" });
    const acct = (await getUser(owner.email))!;
    expect(acct.name, "the owner's name is the account's, not the member's").toBe(owner.name);
    expect(acct.lang).toBe(owner.lang);

    const refused: Record<string, string>[] = [{ phone: "0500000999" }, { emails: "none" }, { name: "Sneaky", tone: "loud" }, { social_x: "@me" }];
    for (const body of refused) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    expect((await getMember(m))!.name, "a refused request writes nothing").toBe("Renamed Member");
    expect((await getUser(owner.email))!.phone).toBe(owner.phone);
    expect(await db.get(`profile:${owner.email}`)).toBeNull();
  });

  it("an admin edits the brand fields but not the account's; the owner edits both", async () => {
    const owner = await newUser("own");
    const brand: Brand = { name: "Roastery", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "beans", audience: "locals", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "Riyadh", updatedAt: new Date().toISOString() };
    await saveBrand(owner.email, brand);
    const admin = await memberWithOwnPassword(owner, "admin");
    await signIn(admin);
    expect((await profile.PUT(json("/api/profile", "PUT", { tone: "bold" }))).status).toBe(200);
    expect((await profile.PUT(json("/api/profile", "PUT", { phone: "0500000999" }))).status).toBe(403);
    const { getBrand } = await import("@/lib/brand");
    expect((await getBrand(owner.email))!.tone).toBe("bold");

    await signIn(owner.email);
    expect((await profile.PUT(json("/api/profile", "PUT", { phone: "0500000999", tone: "calm", emails: "important" }))).status).toBe(200);
    expect((await getUser(owner.email))!.phone).toBe("0500000999");
    expect((await getBrand(owner.email))!.tone).toBe("calm");
  });
});
