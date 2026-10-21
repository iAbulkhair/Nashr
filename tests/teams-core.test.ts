import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { jar, json, markVerified, newMember as helperNewMember, newUser as helperNewUser, params, readActiveBrand, seedActiveBrand, signIn, signOut } from "./helpers/session";
import { acct, adminActor, createUser, currentUser, getLogin, getUser, isAdmin, isAdminCookie, isFounderActor, PLAN_SEATS, saveUser, sc, seatLimit, type Actor, type Plan, type User } from "@/lib/auth";
import { accountKey, personKey, storedAccountId, storedPersonId } from "@/lib/keys";
import { getPerson, updatePerson, withPersonLock } from "@/lib/person";
import { can, forbid, IMPERSONATION_BLOCKED, roleOf, type Action } from "@/lib/roles";
import { acceptInvite, cancelInvite, createInvite, enforceSeats, INVITE_TTL_SECONDS, leaveTeam, listInvites, listMembers, peekInvite, removeMember, seatsUsed, setRole, teamView } from "@/lib/team";
import { addBrand, saveBrands, scopeFor } from "@/lib/brands";
import { wipeAccount } from "@/lib/account";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { db } from "@/lib/db";
import * as users from "@/app/api/admin/users/[email]/route";

// Pins the legacy shape (multi-org M1): this file reads and writes R1's records by address (`user:`/`member:`, address-shaped
// person ids and actors), so its persons are legacy ones; each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

const FOUNDER = "founder-teams@test.example";
const ownerActor = (u: User): Actor => ({ kind: "owner", pid: storedPersonId(u.email), email: u.email, name: u.name, lang: u.lang, role: "owner" });
const memberActor = (email: string, role: "admin" | "member"): Actor => ({ kind: "member", pid: storedPersonId(email), email, name: "M", lang: "ar", role });
const as = (u: User, actor?: Actor): User => ({ ...u, actor });
const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
const withPlan = async (u: User, plan: Plan, seats?: number) => { const x = { ...(await getUser(u.email))!, plan, seats }; await saveUser(x); return x; };
const freshEmail = (p = "inv") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
/** Sign in as `email` and resolve the request's user. */
const resolveAs = async (email: string, opts: { imp?: string } = {}) => { await signIn(email, opts); return currentUser(); };
type Row = { role?: string; disabled?: string; acceptedAt?: string };
/** A member's membership row in the owner's account (rule 2138: the `mbr:` row is the membership; no `member:` record). */
const rowKey = (owner: User, email: string) => accountKey.membership(storedAccountId(acct(owner)), storedPersonId(email));
const rowOf = (owner: User, email: string) => db.get<Row>(rowKey(owner, email));
const patchRow = async (owner: User, email: string, patch: Row) => db.set(rowKey(owner, email), { ...(await rowOf(owner, email))!, ...patch });

beforeAll(() => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  vi.stubEnv("WAITLIST_ADMIN_KEY", "");
});

describe("resolving a member session", () => {
  it("returns the OWNER account with the member as actor, scoped to the owner's workspace", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner, "admin");
    const u = await resolveAs(m.email);
    expect(u!.email).toBe(owner.email); // the account: credits, plan, brands
    expect(sc(u!)).toBe(sc((await resolveAs(owner.email))!)); // same workspace as the owner
    await signIn(m.email);
    const again = (await currentUser())!;
    expect(sc(again)).toBe(owner.email);
    expect(again.actor).toEqual({ kind: "member", pid: storedPersonId(m.email), email: m.email, name: expect.any(String), lang: "ar", role: "admin" });
    expect(roleOf(again)).toBe("admin");
  });
  it("gives the owner an owner actor", async () => {
    const owner = await newUser("own");
    const u = await resolveAs(owner.email);
    expect(u!.actor).toMatchObject({ kind: "owner", email: owner.email, role: "owner" });
  });
  it("keeps the active brand per login, validated against the owner's active brands", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const b = (await addBrand(as(owner, ownerActor(owner)), "Second")) as { id: string };
    const m = await newMember(owner);
    // addBrand activated the new brand for the owner only; the member still sits on the default brand.
    expect(sc((await resolveAs(owner.email))!)).toBe(scopeFor(owner.email, b.id));
    expect(sc((await resolveAs(m.email))!)).toBe(owner.email);
    // The member's own pick, never the member's email as a scope.
    await seedActiveBrand(m.email, b.id);
    expect(sc((await resolveAs(m.email))!)).toBe(scopeFor(owner.email, b.id));
    // A brand id the owner does not have, or an archived one, falls back to default.
    await seedActiveBrand(m.email, "nope1234");
    expect(sc((await resolveAs(m.email))!)).toBe(owner.email);
    await saveBrands(owner.email, [{ ...b, name: "Second", createdAt: new Date().toISOString(), status: "archived" }]);
    await seedActiveBrand(m.email, b.id);
    expect(sc((await resolveAs(m.email))!)).toBe(owner.email);
  });
  it("addBrand by a member activates the new brand for that member, not for the owner", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const m = await newMember(owner, "admin");
    const u = (await resolveAs(m.email))!;
    const b = (await addBrand(u, "Member brand")) as { id: string };
    expect(await readActiveBrand(m.email)).toBe(b.id);
    expect(await readActiveBrand(owner.email)).not.toBe(b.id);
    // Rule 2138: no legacy per-login key is written.
    expect(await db.get(`activebrand:${m.email}`)).toBeNull();
    expect(sc((await resolveAs(owner.email))!)).toBe(owner.email);
  });
  it("refuses a removed member, a disabled member, a suspended owner and a missing owner", async () => {
    const owner = await newUser("own");
    // No shadow memberships for a and b: a removed or paused member who holds nothing else signs in nowhere (multi-org M1).
    const a = await newMember(owner, "member", "m", { shadow: false });
    const b = await newMember(owner, "member", "m", { shadow: false });
    const c = await newMember(owner);
    expect(await resolveAs(a.email)).not.toBeNull();
    expect((await removeMember(owner, ownerActor(owner), a.email)).ok).toBe(true);
    expect(await resolveAs(a.email)).toBeNull();

    await patchRow(owner, b.email, { disabled: "seats" });
    expect(await resolveAs(b.email)).toBeNull();

    await signIn(c.email);
    await saveUser({ ...(await getUser(owner.email))!, suspended: true });
    expect(await currentUser()).toBeNull(); // the cookie is still there
    await saveUser({ ...(await getUser(owner.email))!, suspended: false });
    expect(await currentUser()).not.toBeNull();
    await db.del(`user:${owner.email}`);
    expect(await currentUser()).toBeNull();
  });
  it("refuses a member record older than the owner record (a re-registered owner address never inherits a team)", async () => {
    const owner = await newUser("own");
    // No shadow membership: a refused member who holds nothing else signs in nowhere (multi-org M1).
    const m = await newMember(owner, "member", "m", { shadow: false });
    expect(await resolveAs(m.email)).not.toBeNull();
    await saveUser({ ...(await getUser(owner.email))!, createdAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await resolveAs(m.email)).toBeNull();
  });
  it("teamSessionsAfter signs every member out and leaves the owner signed in", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    const memberTok = await signIn(m.email);
    const ownerTok = await signIn(owner.email);
    await saveUser({ ...(await getUser(owner.email))!, teamSessionsAfter: new Date(Date.now() + 1000).toISOString() });
    jar().set("thakeen_session", memberTok);
    expect(await currentUser()).toBeNull();
    jar().set("thakeen_session", ownerTok);
    expect((await currentUser())!.email).toBe(owner.email);
  });
  it("a member's own sessionsAfter (on its person, rule 2138) kills only that member's older sessions", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    const old = await signIn(m.email);
    await updatePerson(storedPersonId(m.email), { sessionsAfter: new Date(Date.now() + 1000).toISOString() });
    jar().set("thakeen_session", old);
    expect(await currentUser()).toBeNull();
    // A legacy bare-email session never works for a member (issued at 0, before acceptedAt).
    const legacy = randomBytes(32).toString("hex");
    const n = await newMember(owner);
    await db.set(`session:${legacy}`, n.email);
    jar().set("thakeen_session", legacy);
    expect(await currentUser()).toBeNull();
  });
  it("an impersonation session is never honoured for a member login", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    expect(await resolveAs(m.email, { imp: FOUNDER })).toBeNull();
  });
  it("saveUser never persists the actor, the scope or the brand id", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    const u = (await resolveAs(m.email))!;
    expect(u.actor).toBeDefined();
    await saveUser(u);
    const raw = (await db.get<Record<string, unknown>>(`user:${owner.email}`))!;
    expect(raw).not.toHaveProperty("actor");
    expect(raw).not.toHaveProperty("scope");
    expect(raw).not.toHaveProperty("brandId");
  });
  it("members never enter users:all, and createUser stamps sessionsAfter at creation", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    const all = await db.smembers("users:all");
    expect(all).toContain(owner.email);
    expect(all).not.toContain(m.email);
    expect(await getUser(m.email)).toBeNull();
    // Rule 2138: the stamp lives on the person, never on the account record.
    const p = (await getPerson(storedPersonId(owner.email)))!;
    expect(p.sessionsAfter).toBe(p.createdAt);
    expect(owner).not.toHaveProperty("sessionsAfter");
  });
  it("getLogin tells owners from members", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    expect(await getLogin(owner.email.toUpperCase())).toMatchObject({ kind: "owner", user: { email: owner.email } });
    expect(await getLogin(m.email)).toMatchObject({ kind: "member", pid: storedPersonId(m.email), acct: owner.email, membership: { aid: owner.email, role: "member" }, owner: { email: owner.email } });
    expect(await getLogin(freshEmail("nobody"))).toBeNull();
  });
});

describe("founder console follows the actor", () => {
  let founder: User;
  beforeAll(async () => {
    founder = (await getUser(FOUNDER)) ?? (await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" })).email));
  });
  const req = () => json("/api/admin/overview", "GET");
  it("passes the founder signed in as themselves", async () => {
    const u = await resolveAs(FOUNDER);
    expect(isFounderActor(u)).toBe(true);
    expect(await isAdmin(req())).toBe(true);
    expect(await isAdminCookie()).toBe(true);
    expect(await adminActor(req())).toBe(FOUNDER);
  });
  it("refuses a member of the founder's own account, though u.email is the founder's", async () => {
    const m = await newMember(founder, "admin");
    const u = await resolveAs(m.email);
    expect(u!.email).toBe(FOUNDER);
    expect(isFounderActor(u)).toBe(false);
    expect(await isAdmin(req())).toBe(false);
    expect(await isAdminCookie()).toBe(false);
  });
  it("refuses a founder impersonating someone, including the founder's own account", async () => {
    const customer = await newUser("cust");
    expect((await resolveAs(customer.email, { imp: FOUNDER }))!.actor).toMatchObject({ kind: "founder", role: "owner", impersonating: FOUNDER });
    expect(await isAdmin(req())).toBe(false);
    await signIn(FOUNDER, { imp: FOUNDER });
    expect(await isAdmin(req())).toBe(false);
    expect(await isAdminCookie()).toBe(false);
  });
  it("the impersonate action writes the founder into the session, and admin:log names who acted", async () => {
    const customer = await newUser("cust");
    await signIn(FOUNDER);
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", reason: "support" }), params({ email: encodeURIComponent(customer.email) }));
    expect(res.status).toBe(200);
    const u = (await currentUser())!;
    expect(u.email).toBe(customer.email);
    expect(u.actor).toMatchObject({ kind: "founder", impersonating: FOUNDER });
    expect(can(u, "account.delete")).toBe(false);
    expect(can(u, "team.invite.member")).toBe(false);
    expect(await isAdmin(req())).toBe(false);
    const entry = JSON.parse((await db.lrange("admin:log", 0, 0))[0]);
    expect(entry).toMatchObject({ actor: FOUNDER, email: customer.email, what: "impersonate" });
  });
  it("a founder password reset signs every member of that account out", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    const memberTok = await signIn(m.email);
    await signIn(FOUNDER);
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "resetPassword" }), params({ email: encodeURIComponent(owner.email) }));
    expect(res.status).toBe(200);
    expect((await getUser(owner.email))!.teamSessionsAfter).toBeTruthy();
    jar().set("thakeen_session", memberTok);
    expect(await currentUser()).toBeNull();
  });
});

describe("roles table", () => {
  const owner = { email: "o@test.example", name: "O", plan: "trial", lang: "ar" } as User;
  const kinds = {
    owner: as(owner, { kind: "owner", pid: storedPersonId(owner.email), email: owner.email, name: "O", lang: "ar", role: "owner" }),
    token: as(owner, { kind: "token", pid: storedPersonId(owner.email), email: owner.email, name: "O", lang: "ar", role: "owner" }),
    founder: as(owner, { kind: "founder", pid: storedPersonId(owner.email), email: owner.email, name: "O", lang: "ar", role: "owner", impersonating: FOUNDER }),
    admin: as(owner, memberActor("a@test.example", "admin")),
    member: as(owner, memberActor("m@test.example", "member")),
  };
  it("spot checks per role", () => {
    const table: [Action, Record<keyof typeof kinds, boolean>][] = [
      ["billing", { owner: true, token: true, founder: true, admin: false, member: false }],
      ["account.delete", { owner: true, token: true, founder: false, admin: false, member: false }],
      ["account.export", { owner: true, token: true, founder: false, admin: false, member: false }],
      ["governance.write", { owner: true, token: true, founder: true, admin: false, member: false }],
      ["mcp.token", { owner: true, token: true, founder: false, admin: false, member: false }],
      ["team.invite.admin", { owner: true, token: true, founder: false, admin: false, member: false }],
      ["team.role", { owner: true, token: true, founder: false, admin: false, member: false }],
      ["publish", { owner: true, token: true, founder: true, admin: true, member: false }],
      ["brand.write", { owner: true, token: true, founder: true, admin: true, member: false }],
      ["connectors", { owner: true, token: true, founder: true, admin: true, member: false }],
      ["team.invite.member", { owner: true, token: true, founder: false, admin: true, member: false }],
      ["team.invites.view", { owner: true, token: true, founder: true, admin: true, member: false }],
      ["chat", { owner: true, token: true, founder: true, admin: true, member: true }],
      ["brands.switch", { owner: true, token: true, founder: true, admin: true, member: true }],
      ["password.change", { owner: true, token: true, founder: false, admin: true, member: true }],
      ["team.leave", { owner: false, token: false, founder: false, admin: true, member: true }],
    ];
    for (const [action, want] of table) for (const k of Object.keys(kinds) as (keyof typeof kinds)[]) expect(can(kinds[k], action), `${k} ${action}`).toBe(want[k]);
  });
  it("fails closed: no user, no actor, an unknown action, or a kind and role that disagree", () => {
    expect(can(null, "chat")).toBe(false);
    expect(can(owner, "chat")).toBe(false); // an account record with no actor
    expect(can(kinds.owner, "no.such.action" as Action)).toBe(false);
    expect(can(kinds.owner, "__proto__" as Action)).toBe(false);
    expect(can(as(owner, { ...memberActor("x@test.example", "member"), role: "owner" }), "billing")).toBe(false);
    expect(can(as(owner, { kind: "owner", pid: storedPersonId(owner.email), email: owner.email, name: "O", lang: "ar", role: "member" }), "chat")).toBe(false);
  });
  it("every impersonation-blocked action is refused to a founder", () => {
    for (const a of IMPERSONATION_BLOCKED) expect(can(kinds.founder, a), a).toBe(false);
  });
  it("forbid answers 403 {error:'forbidden'} or null", async () => {
    expect(forbid(kinds.admin, "publish")).toBeNull();
    const no = forbid(kinds.member, "publish")!;
    expect(no.status).toBe(403);
    expect(await no.json()).toEqual({ error: "forbidden" });
    expect(forbid(owner, "chat")!.status).toBe(403);
  });
});

describe("invites", () => {
  it("the owner invites; the invite is stored only as its hash, with a seven-day expiry", async () => {
    const owner = await newUser("own");
    const email = freshEmail();
    const r = await createInvite(owner, ownerActor(owner), ` ${email.toUpperCase()} `, "member", "en");
    if (!r.ok) throw new Error(r.error);
    expect(r.token).toMatch(/^[a-f0-9]{64}$/);
    expect(r.id).not.toBe(r.token);
    expect(await db.get(`invite:${r.token}`)).toBeNull();
    expect(await db.get(`invite:${r.id}`)).toMatchObject({ email, role: "member", owner: owner.email, invitedBy: owner.email, lang: "en" });
    expect(new Date(r.invite.expiresAt).getTime() - new Date(r.invite.createdAt).getTime()).toBe(INVITE_TTL_SECONDS * 1000);
    expect((await listInvites(owner.email)).map((i) => i.id)).toEqual([r.id]);
  });
  it("counts seats (owner + members + pending invites) against the plan", async () => {
    const owner = await newUser("own"); // trial: 3 seats
    expect(seatLimit(owner)).toBe(PLAN_SEATS.trial);
    await newMember(owner);
    const r1 = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    expect(r1.ok).toBe(true);
    expect(await seatsUsed(owner.email)).toBe(3);
    expect(await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar")).toEqual({ ok: false, error: "seats", used: 3, limit: 3 });
    // The founder override lifts the plan's number.
    const more = await withPlan(owner, "trial", 5);
    expect((await createInvite(more, ownerActor(more), freshEmail(), "member", "ar")).ok).toBe(true);
  });
  it("refuses self, an existing login anywhere, and a pending invite, all with one generic answer", async () => {
    const owner = await newUser("own");
    const other = await newUser("other");
    const elsewhere = await newMember(other);
    const pending = freshEmail();
    expect((await createInvite(owner, ownerActor(owner), pending, "member", "ar")).ok).toBe(true);
    for (const e of [owner.email, other.email, elsewhere.email, pending]) expect(await createInvite(owner, ownerActor(owner), e, "member", "ar"), e).toEqual({ ok: false, error: "unavailable" });
    expect(await createInvite(owner, ownerActor(owner), "victim@x.com#brand", "member", "ar")).toEqual({ ok: false, error: "invalid_email" });
    expect(await createInvite(owner, ownerActor(owner), freshEmail(), "owner", "ar")).toEqual({ ok: false, error: "invalid_role" });
  });
  it("an admin invites plain members only; a member and an impersonating founder invite nobody", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    const plain = await newMember(owner, "member");
    const adminU = (await resolveAs(admin.email))!;
    expect((await createInvite(adminU, adminU.actor!, freshEmail(), "member", "ar")).ok).toBe(true);
    expect(await createInvite(adminU, adminU.actor!, freshEmail(), "admin", "ar")).toEqual({ ok: false, error: "forbidden" });
    const plainU = (await resolveAs(plain.email))!;
    expect(await createInvite(plainU, plainU.actor!, freshEmail(), "member", "ar")).toEqual({ ok: false, error: "forbidden" });
    const imp = (await resolveAs(owner.email, { imp: FOUNDER }))!;
    expect(await createInvite(imp, imp.actor!, freshEmail(), "member", "ar")).toEqual({ ok: false, error: "forbidden" });
    // An actor the store no longer backs (a demoted admin with a stale actor) is refused too.
    await patchRow(owner, admin.email, { role: "member" });
    expect(await createInvite(owner, memberActor(admin.email, "admin"), freshEmail(), "member", "ar")).toEqual({ ok: false, error: "forbidden" });
  });
  it("peek shows the invite without consuming it; accept creates a signed-out-safe member login once", async () => {
    const owner = await newUser("own");
    const email = freshEmail();
    const r = await createInvite(owner, ownerActor(owner), email, "admin", "ar");
    if (!r.ok) throw new Error(r.error);
    const preview = await peekInvite(r.token);
    expect(preview).toMatchObject({ inviter: owner.name, email, role: "admin", expiresAt: r.invite.expiresAt });
    expect(await peekInvite(r.token)).toEqual(preview); // not consumed
    expect(await acceptInvite(r.token, { name: "New Person", password: "short" })).toEqual({ ok: false, error: "weak_password" });
    expect(await acceptInvite(r.token, { name: "  ", password: "abc12345" })).toEqual({ ok: false, error: "invalid_name" });
    const done = await acceptInvite(r.token, { name: "New Person", password: "abc12345", lang: "en" });
    if (!done.ok) throw new Error(done.error);
    expect(done.member).toMatchObject({ email, memberOf: owner.email, role: "admin", lang: "en", invitedBy: owner.email });
    expect(done.member.sessionsAfter).toBe(done.member.acceptedAt);
    expect(done.member.passHash).not.toContain("abc12345");
    // Single use.
    expect(await acceptInvite(r.token, { name: "Again", password: "abc12345" })).toEqual({ ok: false, error: "invalid" });
    expect(await peekInvite(r.token)).toBeNull();
    expect(await listInvites(owner.email)).toEqual([]);
    // A member, never an account: no user record, not in users:all, the roster has it.
    expect(await getUser(email)).toBeNull();
    expect(await db.smembers("users:all")).not.toContain(email);
    expect((await listMembers(owner.email)).map((m) => m.email)).toEqual([email]);
    expect((await resolveAs(email))!.actor).toMatchObject({ kind: "member", role: "admin" });
  });
  it("two accepts of one token at the same time create one member", async () => {
    const owner = await newUser("own");
    const r = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!r.ok) throw new Error(r.error);
    const both = await Promise.all([acceptInvite(r.token, { name: "A", password: "abc12345" }), acceptInvite(r.token, { name: "B", password: "abc12345" })]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(await listMembers(owner.email)).toHaveLength(1);
    // The single-use lock itself: while an accept holds `inviteuse:{hash}`, another is refused outright.
    const r2 = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!r2.ok) throw new Error(r2.error);
    expect(await db.lock(`inviteuse:${r2.id}`, 30)).toBe(true);
    expect(await acceptInvite(r2.token, { name: "C", password: "abc12345" })).toEqual({ ok: false, error: "invalid" });
    await db.unlock(`inviteuse:${r2.id}`);
    expect((await acceptInvite(r2.token, { name: "C", password: "abc12345" })).ok).toBe(true);
  });
  it("an expired invite can be neither previewed nor accepted", async () => {
    const owner = await newUser("own");
    const r = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!r.ok) throw new Error(r.error);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + INVITE_TTL_SECONDS * 1000 + 1000);
    try {
      expect(await peekInvite(r.token)).toBeNull();
      expect(await acceptInvite(r.token, { name: "Late", password: "abc12345" })).toEqual({ ok: false, error: "invalid" });
      expect(await listInvites(owner.email)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect(await acceptInvite("not-a-token", { name: "X", password: "abc12345" })).toEqual({ ok: false, error: "invalid" });
  });
  it("accept re-checks: inviter still an admin, seats, owner not suspended, address still free", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    const adminU = (await resolveAs(admin.email))!;
    const byAdmin = await createInvite(adminU, adminU.actor!, freshEmail(), "member", "ar");
    if (!byAdmin.ok) throw new Error(byAdmin.error);
    await patchRow(owner, admin.email, { role: "member" }); // demoted after inviting
    expect(await acceptInvite(byAdmin.token, { name: "X", password: "abc12345" })).toEqual({ ok: false, error: "invalid" });

    const email = freshEmail();
    const taken = await createInvite(owner, ownerActor(owner), email, "member", "ar");
    if (!taken.ok) throw new Error(taken.error);
    await createUser({ email, name: "Signed up meanwhile", phone: "", password: "abc12345", lang: "ar" });
    expect(await acceptInvite(taken.token, { name: "X", password: "abc12345" })).toEqual({ ok: false, error: "unavailable" });

    const susp = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!susp.ok) throw new Error(susp.error);
    await saveUser({ ...(await getUser(owner.email))!, suspended: true });
    expect(await acceptInvite(susp.token, { name: "X", password: "abc12345" })).toEqual({ ok: false, error: "invalid" });
    await saveUser({ ...(await getUser(owner.email))!, suspended: false });

    // The plan shrank between invite and accept: the seat no longer fits.
    const late = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!late.ok) throw new Error(late.error);
    await withPlan(owner, "starter");
    expect(await acceptInvite(late.token, { name: "X", password: "abc12345" })).toMatchObject({ ok: false, error: "seats", limit: 1 });
  });
  it("cancel: owner any invite, admin only member invites, never another account's", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const other = await newUser("other");
    const admin = await newMember(owner, "admin");
    const adminU = (await resolveAs(admin.email))!;
    const mInv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    const aInv = await createInvite(owner, ownerActor(owner), freshEmail(), "admin", "ar");
    if (!mInv.ok || !aInv.ok) throw new Error("setup");
    expect(await cancelInvite(other, ownerActor(other), mInv.id)).toEqual({ ok: false, error: "not_found" });
    expect(await cancelInvite(adminU, adminU.actor!, aInv.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await cancelInvite(adminU, adminU.actor!, mInv.id)).toEqual({ ok: true });
    expect(await cancelInvite(owner, ownerActor(owner), aInv.id)).toEqual({ ok: true });
    expect(await listInvites(owner.email)).toEqual([]);
  });
});

describe("roster changes", () => {
  it("remove: owner removes anyone, admin only plain members; removal deletes the member's active brand and invites they sent", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    const admin2 = await newMember(owner, "admin");
    const plain = await newMember(owner, "member");
    const adminU = (await resolveAs(admin.email))!;
    expect(await removeMember(adminU, adminU.actor!, admin2.email)).toEqual({ ok: false, error: "forbidden" });
    const plainU = (await resolveAs(plain.email))!;
    expect(await removeMember(plainU, plainU.actor!, admin.email)).toEqual({ ok: false, error: "forbidden" });
    const sent = await createInvite(adminU, adminU.actor!, freshEmail(), "member", "ar");
    if (!sent.ok) throw new Error(sent.error);
    await seedActiveBrand(admin.email, "default");
    expect(await removeMember(owner, ownerActor(owner), admin.email)).toEqual({ ok: true });
    expect(await rowOf(owner, admin.email)).toBeNull();
    expect(await db.get(personKey.activeBrand(storedPersonId(admin.email), storedAccountId(acct(owner))))).toBeNull();
    expect(await db.get(`invite:${sent.id}`)).toBeNull();
    expect((await listMembers(owner.email)).map((m) => m.email).sort()).toEqual([admin2.email, plain.email].sort());
    const admin2U = (await resolveAs(admin2.email))!;
    expect(await removeMember(admin2U, admin2U.actor!, plain.email)).toEqual({ ok: true });
    expect(await removeMember(owner, ownerActor(owner), owner.email)).toEqual({ ok: false, error: "not_found" });
  });
  it("setRole is owner only; leave is members only", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    // No shadow membership: a member who left its only account signs in nowhere (multi-org M1).
    const plain = await newMember(owner, "member", "m", { shadow: false });
    const adminU = (await resolveAs(admin.email))!;
    expect(await setRole(adminU, adminU.actor!, plain.email, "admin")).toEqual({ ok: false, error: "forbidden" });
    expect(await setRole(owner, ownerActor(owner), plain.email, "owner")).toEqual({ ok: false, error: "invalid_role" });
    expect(await setRole(owner, ownerActor(owner), plain.email, "admin")).toEqual({ ok: true });
    expect((await resolveAs(plain.email))!.actor!.role).toBe("admin");

    expect(await leaveTeam((await resolveAs(owner.email))!)).toEqual({ ok: false, error: "forbidden" });
    expect(await leaveTeam((await resolveAs(plain.email))!)).toEqual({ ok: true });
    expect(await rowOf(owner, plain.email)).toBeNull();
    expect(await resolveAs(plain.email)).toBeNull();
  });
  it("teamView lists the owner first and hides invites from plain members", async () => {
    const owner = await newUser("own");
    const plain = await newMember(owner);
    const inv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    const mine = (await teamView((await resolveAs(owner.email))!))!;
    expect(mine.you).toEqual({ email: owner.email, name: owner.name, role: "owner" });
    expect(mine.seats).toEqual({ used: 3, limit: 3 });
    expect(mine.members[0]).toEqual({ email: owner.email, name: owner.name, role: "owner" });
    expect(mine.invites).toEqual([{ id: inv.id, email: inv.invite.email, role: "member", expiresAt: inv.invite.expiresAt, invitedBy: owner.email }]);
    expect(JSON.stringify(mine)).not.toContain("passHash");
    const theirs = (await teamView((await resolveAs(plain.email))!))!;
    expect(theirs.you).toMatchObject({ email: plain.email, role: "member" });
    expect(theirs.invites).toEqual([]);
  });
});

describe("enforceSeats on a plan change", () => {
  it("disables the newest members over the limit, re-enables them oldest-first, and cancels invites that no longer fit", async () => {
    const owner = await withPlan(await newUser("own"), "agency"); // 7 seats
    // No shadow memberships: a paused member who holds nothing else signs in nowhere (rule 2138: sign-in takes the first
    // live membership, so a shadow one would sign the paused member in there).
    const solo = () => newMember(owner, "member", "m", { shadow: false });
    const ms = [await solo(), await solo(), await solo(), await solo()];
    // Distinct, ordered acceptance times, all after the owner's creation.
    const base = new Date(owner.createdAt).getTime();
    await Promise.all(ms.map((m, i) => patchRow(owner, m.email, { acceptedAt: new Date(base + (i + 1) * 1000).toISOString() })));
    const inv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!inv.ok) throw new Error(inv.error);

    await withPlan(owner, "pro"); // 3 seats: owner + the two oldest
    const down = await enforceSeats(owner.email);
    expect(down.limit).toBe(3);
    expect(down.disabled.sort()).toEqual([ms[2].email, ms[3].email].sort());
    expect(down.cancelled).toEqual([inv.id]);
    expect((await rowOf(owner, ms[3].email))!.disabled).toBe("seats");
    expect(await resolveAs(ms[3].email)).toBeNull();
    expect(await resolveAs(ms[0].email)).not.toBeNull();
    expect(await seatsUsed(owner.email)).toBe(3);
    expect(await rowOf(owner, ms[3].email)).not.toBeNull(); // kept, never deleted

    await withPlan(owner, "pro", 4); // one seat more: the oldest disabled member comes back first
    const up = await enforceSeats(owner.email);
    expect(up.enabled).toEqual([ms[2].email]);
    expect((await rowOf(owner, ms[3].email))!.disabled).toBe("seats");

    await withPlan(owner, "agency");
    expect((await enforceSeats(owner.email)).enabled).toEqual([ms[3].email]);
    expect(await resolveAs(ms[3].email)).not.toBeNull();
  });
});

describe("enforceSeats works from the team as it is now", () => {
  it("re-applying the same limit changes nothing: the member the owner chose stays, the paused one stays paused", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const [a, b, c] = [await newMember(owner), await newMember(owner), await newMember(owner)];
    const base = new Date(owner.createdAt).getTime();
    await Promise.all([a, b, c].map((m, i) => patchRow(owner, m.email, { acceptedAt: new Date(base + (i + 1) * 1000).toISOString() })));
    await withPlan(owner, "pro"); // 3 seats: A and B keep theirs, C is paused
    expect((await enforceSeats(owner.email)).disabled).toEqual([c.email]);
    // The owner removes B and brings D in; D is newer than the paused C.
    expect(await removeMember(owner, ownerActor(owner), b.email)).toEqual({ ok: true });
    const d = await newMember(owner);
    await patchRow(owner, d.email, { acceptedAt: new Date(base + 10_000).toISOString() });
    // The founder re-applies Pro (a renewal, a credits reset): nobody is swapped.
    expect(await enforceSeats(owner.email)).toEqual({ limit: 3, disabled: [], enabled: [], cancelled: [] });
    expect(await resolveAs(d.email)).not.toBeNull();
    expect((await rowOf(owner, c.email))!.disabled).toBe("seats");
  });
  it("brings paused members back only into seats nobody holds: a pending invite keeps its seat", async () => {
    const owner = await withPlan(await newUser("own"), "pro"); // 3 seats
    const [a, b] = [await newMember(owner), await newMember(owner)];
    const base = new Date(owner.createdAt).getTime();
    await Promise.all([a, b].map((m, i) => patchRow(owner, m.email, { acceptedAt: new Date(base + (i + 1) * 1000).toISOString() })));
    await withPlan(owner, "starter");
    expect((await enforceSeats(owner.email)).disabled.sort()).toEqual([a.email, b.email].sort());
    // Back on Pro, the owner invites someone before the limit is refitted: the invite takes one of the two free seats.
    await withPlan(owner, "pro");
    const inv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    const up = await enforceSeats(owner.email);
    expect(up.enabled).toEqual([a.email]); // the oldest paused member, into the one seat left
    expect(up.cancelled).toEqual([]);
    expect((await rowOf(owner, b.email))!.disabled).toBe("seats");
    expect(await seatsUsed(owner.email)).toBe(3);
  });
});

describe("the locks close the races (a removal, a cancel, a plan change or a deletion against a write in flight)", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it("a removal waits for a person write in flight, and the removed login stays removed", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const m = await newMember(owner, "admin");
    const tok = await signIn(m.email);
    let removal: Promise<unknown> = Promise.resolve();
    // PUT /api/profile, PATCH /api/account and the member reset all write the person under lock:person (rule 2138:
    // no member record); the removal takes that lock too (rule 2139), so it lands after the write below.
    await withPersonLock(m.pid, async () => {
      removal = removeMember(owner, ownerActor(owner), m.email);
      await pause(200);
      await updatePerson(m.pid, { name: "Renamed" }, { personLocked: true });
    });
    expect(await removal).toEqual({ ok: true });
    expect(await rowOf(owner, m.email)).toBeNull();
    expect(await listMembers(owner.email)).toEqual([]);
    jar().set("thakeen_session", tok);
    expect(await currentUser()).toBeNull();
  });
  it("a membership row (or a legacy member record) that outlived its roster entry neither signs in nor holds the address", async () => {
    const owner = await newUser("own");
    // No shadow membership: the removed member holds nothing else.
    const m = await newMember(owner, "admin", "m", { shadow: false });
    const rec = (await rowOf(owner, m.email))!;
    const tok = await signIn(m.email);
    expect(await removeMember(owner, ownerActor(owner), m.email)).toEqual({ ok: true });
    // Restored behind the roster's back, with a legacy member record beside it (rule 2138: never read).
    await Promise.all([
      db.set(rowKey(owner, m.email), rec),
      db.set(accountKey.member(m.email), { email: m.email, name: "Legacy", lang: "ar", passHash: "legacy-hash", memberOf: owner.email, role: "admin", invitedBy: owner.email, acceptedAt: new Date().toISOString() }),
    ]);
    jar().set("thakeen_session", tok);
    expect(await currentUser()).toBeNull();
    expect(await getLogin(m.email)).toBeNull();
  });
  it("an accept waiting for the team lock sees a cancel that landed first, and creates nobody", async () => {
    const owner = await newUser("own");
    const email = freshEmail();
    const inv = await createInvite(owner, ownerActor(owner), email, "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    expect(await db.lock(`lock:team:${owner.email}`, 10)).toBe(true);
    const accepting = acceptInvite(inv.token, { name: "Racer", password: "abc12345" });
    await pause(300); // the accept has read the invite and waits for the lock
    await Promise.all([db.del(`invite:${inv.id}`), db.srem(`invites:${owner.email}`, inv.id)]); // what cancelInvite does
    await db.unlock(`lock:team:${owner.email}`);
    expect(await accepting).toEqual({ ok: false, error: "invalid" });
    expect(await getLogin(email)).toBeNull();
  });
  it("an accept waiting for the team lock counts seats against the plan as it is when it gets the lock", async () => {
    const owner = await withPlan(await newUser("own"), "pro");
    await newMember(owner);
    const inv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    expect(await db.lock(`lock:team:${owner.email}`, 10)).toBe(true);
    const accepting = acceptInvite(inv.token, { name: "Racer", password: "abc12345" });
    await pause(300);
    await withPlan(owner, "starter"); // the founder downgrades while the accept waits
    await db.unlock(`lock:team:${owner.email}`);
    expect(await accepting).toMatchObject({ ok: false, error: "seats", limit: 1 });
    expect(await getLogin(inv.invite.email)).toBeNull();
  });
  it("cancel takes the team lock: it waits for an accept in progress and then finds nothing to cancel", async () => {
    const owner = await newUser("own");
    const inv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    expect(await db.lock(`lock:team:${owner.email}`, 10)).toBe(true);
    const cancelling = cancelInvite(owner, ownerActor(owner), inv.id);
    await pause(150);
    expect(await db.get(`invite:${inv.id}`), "the cancel has not run while the lock is held").not.toBeNull();
    await db.unlock(`lock:team:${owner.email}`);
    expect(await cancelling).toEqual({ ok: true });
  });
  it("an account deleted while an invite is being accepted leaves no member login behind", async () => {
    const owner = await newUser("own");
    const email = freshEmail();
    const inv = await createInvite(owner, ownerActor(owner), email, "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    expect(await db.lock(`lock:team:${owner.email}`, 10)).toBe(true);
    const accepting = acceptInvite(inv.token, { name: "Racer", password: "abc12345" });
    await pause(300);
    const wiping = wipeAccount(owner.email);
    await pause(200);
    await db.unlock(`lock:team:${owner.email}`);
    // Whichever takes the lock first, nothing survives: an accept before the wipe has its member deleted by it, and one
    // after it finds no owner.
    await Promise.all([accepting, wiping]);
    expect(await db.smembers(`members:${owner.email}`)).toEqual([]);
    expect(await getLogin(email)).toBeNull();
  });
  it("demoting an admin drops the invites they sent, and the join page no longer previews one", async () => {
    const owner = await withPlan(await newUser("own"), "agency");
    const admin = await newMember(owner, "admin");
    const adminU = (await resolveAs(admin.email))!;
    const sent = await createInvite(adminU, adminU.actor!, freshEmail(), "member", "ar");
    const other = await createInvite(adminU, adminU.actor!, freshEmail(), "member", "ar");
    if (!sent.ok || !other.ok) throw new Error("setup");
    await patchRow(owner, admin.email, { disabled: "seats" }); // paused behind the lock's back
    expect(await peekInvite(sent.token), "an invite accepting would refuse is not previewed").toBeNull();
    await patchRow(owner, admin.email, { disabled: undefined });
    expect(await peekInvite(sent.token)).not.toBeNull();
    const before = await seatsUsed(owner.email);
    expect(await setRole(owner, ownerActor(owner), admin.email, "member")).toEqual({ ok: true });
    expect(await listInvites(owner.email)).toEqual([]);
    expect(await seatsUsed(owner.email)).toBe(before - 2);
    expect(await peekInvite(other.token)).toBeNull();
  });
});

describe("account deletion cascades to the team", () => {
  it("deletes member logins, member active brands, invites and indexes; a re-registered address inherits nothing", async () => {
    const owner = await newUser("own");
    const m = await newMember(owner);
    await seedActiveBrand(m.email, "default");
    const tok = await signIn(m.email);
    const inv = await createInvite(owner, ownerActor(owner), freshEmail(), "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    await wipeAccount(owner.email);
    for (const k of [rowKey(owner, m.email), personKey.activeBrand(storedPersonId(m.email), storedAccountId(acct(owner))), `invite:${inv.id}`]) expect(await db.get(k), k).toBeNull();
    expect(await db.smembers(`members:${owner.email}`)).toEqual([]);
    expect(await db.smembers(`invites:${owner.email}`)).toEqual([]);
    const again = await markVerified((await createUser({ email: owner.email, name: "New owner", phone: "", password: "abc12345", lang: "ar" })).email);
    jar().set("thakeen_session", tok);
    expect(await currentUser()).toBeNull();
    expect(await listMembers(again.email)).toEqual([]);
    expect(await peekInvite(inv.token)).toBeNull();
  });
});

describe("MCP bearer", () => {
  it("rule 2761: resolves an owner token with a token actor and refuses a token naming a member login", async () => {
    const owner = await newUser("own");
    const t = await createMcpToken(owner.email);
    const u = (await userFromBearer(bearer(t)))!;
    expect(u.email).toBe(owner.email);
    expect(u.actor).toMatchObject({ kind: "token", role: "owner", email: owner.email });

    // A `p_` member (the login index names its `p_` person), as every member made from M2 is.
    const m = await helperNewMember(owner, "member", "m", { legacy: false });
    await db.set("mcptoken:nashr_memberforged1", m.email);
    expect(await userFromBearer(bearer("nashr_memberforged1"))).toBeNull();
    // Even should an owner record exist at a member's address, the token is refused: the login index names a person who
    // does not own it, or (a legacy member, whose person id is its address) the account is not on the person's
    // `orgs:` (rule 2138: no legacy member record is read). A record is stored under its id (rule 1980): the copy names
    // the member's address as its id too.
    await saveUser({ ...owner, id: m.email, email: m.email });
    expect(await userFromBearer(bearer("nashr_memberforged1"))).toBeNull();
    const lm = await helperNewMember(owner, "member", "lm", { legacy: true });
    await db.set("mcptoken:nashr_memberforged2", lm.email);
    await saveUser({ ...owner, id: lm.email, email: lm.email, ownerPid: undefined });
    expect(await userFromBearer(bearer("nashr_memberforged2"))).toBeNull();
    signOut();
  });
});
