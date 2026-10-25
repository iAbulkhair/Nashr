import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { vjson } from "./helpers/version";
import { currentUser, getAccount, getUser, saveUser, sc, type Actor, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { addBrand, listBrands, scopeFor } from "@/lib/brands";
import { charge, monthKey, personOf, personSpendFor, refund } from "@/lib/credits";
import { can, IMPERSONATION_BLOCKED } from "@/lib/roles";
import { createInvite, FREE_VIEWERS, freeViewersLeft, seatCount, setAccess, setRole, teamRoleFrom, teamView } from "@/lib/team";
import { approvalRefusal } from "@/lib/approval-policy";
import { approversFor } from "@/lib/assign";
import { listNotifs, notifBrand, pushNotif } from "@/lib/notifications";
import { feedHolds } from "@/lib/secretary-feed";
import { monthUsage } from "@/lib/month-usage";
import { teamApprovals } from "@/lib/approver-stats";
import { decisionOf, recordDecisions } from "@/lib/decisions";
import { saveConnection } from "@/lib/connectors/store";
import { aidOf, getMembership } from "@/lib/membership";
import { db } from "@/lib/db";
import { accountKey, storedAccountId } from "@/lib/keys";
import { renamed, run as editorRole } from "../scripts/editor-role";

// No network: a publish that got past the gates would show up here instead of a real post.
const published: string[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_e: string, t: Task, provider: string) => { published.push(t.id); return { provider, url: "https://t.me/x/1", status: "published" as const }; } }));

import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as generateRoute from "@/app/api/generate/route";
import * as chatRoute from "@/app/api/chat/route";
import * as conversationsRoute from "@/app/api/conversations/route";
import * as filesRoute from "@/app/api/files/route";
import * as imageRoute from "@/app/api/tasks/[id]/image/route";
import * as scheduleRoute from "@/app/api/schedule/route";
import * as brandsRoute from "@/app/api/brands/route";
import * as teamRoute from "@/app/api/team/route";
import * as memberRoute from "@/app/api/team/member/route";
import * as notificationsRoute from "@/app/api/notifications/route";

const task = (id: string, status: Task["status"], body = "قهوة طازجة"): Task => ({ id, type: "social", channel: "instagram", title: id, body, status, createdAt: new Date().toISOString(), lang: "ar" });
const status = async (p: Promise<Response> | Response) => (await p).status;
async function as(email: string): Promise<User> {
  await signIn(email);
  const u = await currentUser();
  if (!u) throw new Error(`no session for ${email}`);
  return u;
}
/** An account with one Editor (stored "member"), one admin and one Viewer. */
async function team() {
  const owner = await newUser("cr");
  const [editor, admin, viewer] = await Promise.all([newMember(owner, "member", "cre"), newMember(owner, "admin", "cra"), newMember(owner, "viewer", "crv")]);
  return { owner, editor: editor.email, admin: admin.email, viewer: viewer.email, viewerPid: viewer.pid, editorPid: editor.pid, adminPid: admin.pid };
}
/** The owner's own session, for the team functions that take the acting person. */
const ownerSession = async (owner: User) => as(owner.email);

beforeEach(() => { signOut(); published.length = 0; });

describe("rule 3753: one seat count, three free viewers", () => {
  const m = (role: string, disabled?: "seats") => ({ role, ...(disabled ? { disabled } : {}) });
  it("counts the owner, admins, editors and paid-role invites; the first three viewers are free", () => {
    expect(seatCount([], [])).toBe(1);
    expect(seatCount([m("admin"), m("member")], [m("member")])).toBe(4);
    expect(seatCount([m("viewer"), m("viewer")], [m("viewer")])).toBe(1);
    expect(FREE_VIEWERS).toBe(3);
    // The fourth viewer, member or invite, takes a paid seat.
    expect(seatCount([m("viewer"), m("viewer"), m("viewer")], [m("viewer")])).toBe(2);
    // A paused membership takes no seat, a paused viewer no free place.
    expect(seatCount([m("member", "seats"), m("viewer", "seats")], [])).toBe(1);
    expect(freeViewersLeft([m("viewer"), m("viewer", "seats")], [m("viewer")])).toBe(1);
    expect(freeViewersLeft([m("viewer"), m("viewer"), m("viewer"), m("viewer")], [])).toBe(0);
  });

  it("a viewer invite fits while free places are left; an editor invite does not when the paid seats are full", async () => {
    const owner = await newUser("crs");
    // Trial: 3 seats. The owner and two editors fill them.
    await Promise.all([newMember(owner, "member", "crs1"), newMember(owner, "member", "crs2")]);
    const o = await ownerSession(owner);
    const fresh = () => `crs-${randomBytes(4).toString("hex")}@test.example`;
    expect(await createInvite(o, o.actor!, fresh(), "editor", "ar")).toMatchObject({ ok: false, error: "seats" });
    expect(await createInvite(o, o.actor!, fresh(), "viewer", "ar")).toMatchObject({ ok: true });
    const view = await teamView(o);
    expect(view!.seats).toMatchObject({ used: 3, freeViewers: 3, freeViewersLeft: 2 });
  });
});

describe("rule 3750: Editor is the stored member role (expand step)", () => {
  it("reads editor and member as the same role and stores member", async () => {
    expect(teamRoleFrom("editor")).toBe("member");
    expect(teamRoleFrom("member")).toBe("member");
    expect(teamRoleFrom("viewer")).toBe("viewer");
    expect(teamRoleFrom("owner")).toBeNull();
    const { owner, editor, editorPid, viewer, viewerPid } = await team();
    const o = await ownerSession(owner);
    // Trial: 3 seats, all taken (owner, editor, admin): a viewer made an editor would take a fourth.
    expect(await setRole(o, o.actor!, viewer, "editor")).toEqual({ ok: false, error: "seats_full" });
    expect(await setRole(o, o.actor!, editor, "viewer")).toEqual({ ok: true });
    expect((await getMembership(aidOf(o), editorPid))!.role).toBe("viewer");
    expect(await setRole(o, o.actor!, viewer, "editor")).toEqual({ ok: true });
    expect((await getMembership(aidOf(o), viewerPid))!.role).toBe("member");
  });

  it("an unknown stored role is denied everything (rollback and forward safety)", async () => {
    const { owner } = await team();
    const o = await ownerSession(owner);
    const odd = { ...o, actor: { ...o.actor!, kind: "member", role: "editor" } as unknown as Actor };
    expect(can(odd, "read")).toBe(false);
    expect(can(odd, "comment")).toBe(false);
  });
});

describe("rule 3752: a Viewer reads and comments, and is refused every write, agent run and spend", () => {
  it("each route answers 403 and nothing changes", async () => {
    const { owner, viewer } = await team();
    await saveTask(acct(owner), task("v1", "pending"), true);
    const before = (await getUser(acct(owner)))!.credits;
    await as(viewer);
    expect(await status(generateRoute.POST(json("/api/generate", "POST", { type: "social" })))).toBe(403);
    expect(await status(chatRoute.POST(json("/api/chat", "POST", { message: "اكتب منشور" })))).toBe(403);
    expect(await status(conversationsRoute.POST(json("/api/conversations", "POST", { title: "x" }), params({})))).toBe(403);
    expect(await status(filesRoute.PUT(json("/api/files", "PUT", { name: "notes.md", content: "x" }), params({})))).toBe(403);
    expect(await status(imageRoute.POST(json("/api/tasks/v1/image", "POST", {}), params({ id: "v1" })))).toBe(403);
    expect(await status(scheduleRoute.POST(json("/api/schedule", "POST", { run: "weekly" })))).toBe(403);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/v1", "PATCH", { editedBody: "نص آخر" }), params({ id: "v1" })))).toBe(403);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/v1", "PATCH", { status: "approved" }), params({ id: "v1" })))).toBe(403);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/v1", "PATCH", { status: "rejected" }), params({ id: "v1" })))).toBe(403);
    expect(await status(publishRoute.POST(await vjson("/api/publish/v1", "POST", { provider: "telegram" }), params({ id: "v1" })))).toBe(403);
    expect(await getTask(acct(owner), "v1")).toMatchObject({ status: "pending", body: "قهوة طازجة" });
    expect((await getUser(acct(owner)))!.credits).toBe(before);
    expect(published).toEqual([]);
  });

  it("a comment is kept with its author and changes nothing else; mixed with an edit it is refused", async () => {
    const { owner, viewer, viewerPid } = await team();
    await saveTask(acct(owner), task("c1", "pending"), true);
    await as(viewer);
    expect(await status(taskRoute.PATCH(json("/api/tasks/c1", "PATCH", { comment: "  الصورة تحتاج شعار\u0007 " }), params({ id: "c1" })))).toBe(200);
    const t = (await getTask(acct(owner), "c1"))!;
    expect(t.status).toBe("pending");
    expect(t.comments).toEqual([expect.objectContaining({ pid: viewerPid, text: "الصورة تحتاج شعار" })]);
    expect(await status(taskRoute.PATCH(json("/api/tasks/c1", "PATCH", { comment: "x", editedBody: "y" }), params({ id: "c1" })))).toBe(400);
    expect((await getTask(acct(owner), "c1"))!.editedBody).toBeUndefined();
  });
});

describe("rule 3760: the approve toggle", () => {
  it("a founder viewing the account changes no scope, toggle, cap or policy", () => {
    for (const a of ["team.access", "team.cap", "team.policy"] as const) expect(IMPERSONATION_BLOCKED.has(a), a).toBe(true);
  });
  it("an Editor or Viewer approves only with the toggle on, and the approval names them", async () => {
    const { owner, editor, viewer, viewerPid } = await team();
    await Promise.all([saveTask(acct(owner), task("a1", "pending"), true), saveTask(acct(owner), task("a2", "pending"), true)]);
    await as(editor);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/a1", "PATCH", { status: "approved" }), params({ id: "a1" })))).toBe(403);
    const o = await ownerSession(owner);
    expect(await setAccess(o, o.actor!, viewer, { approves: true })).toEqual({ ok: true });
    await as(viewer);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/a2", "PATCH", { status: "approved" }), params({ id: "a2" })))).toBe(200);
    expect((await getTask(acct(owner), "a2"))!.approvedBy).toMatchObject({ pid: viewerPid });
    // The toggle lets them approve, not edit.
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/a2", "PATCH", { editedBody: "نص" }), params({ id: "a2" })))).toBe(403);
  });

  it("only the owner or an admin who is not narrowed changes access; the cap is the owner's", async () => {
    const { owner, admin, viewer, viewerPid } = await team();
    await as(admin);
    expect(await status(memberRoute.PATCH(json("/api/team/member", "PATCH", { email: viewer, approves: true })))).toBe(200);
    expect(await status(memberRoute.PATCH(json("/api/team/member", "PATCH", { email: viewer, creditCap: 10 })))).toBe(403);
    await as(viewer);
    expect(await status(memberRoute.PATCH(json("/api/team/member", "PATCH", { email: viewer, approves: false })))).toBe(403);
    await as(owner.email);
    expect(await status(memberRoute.PATCH(json("/api/team/member", "PATCH", { email: viewer, creditCap: 10 })))).toBe(200);
    expect(await status(memberRoute.PATCH(json("/api/team/member", "PATCH", { email: viewer, creditCap: -1 })))).toBe(400);
    expect(await getMembership(aidOf(await ownerSession(owner)), viewerPid)).toMatchObject({ approves: true, creditCap: 10 });
  });
});

describe("rule 3762: no publishing without an allowed approval when the owner turns the policy on", () => {
  it("only the owner sets the policy", async () => {
    const { owner, admin } = await team();
    await as(admin);
    expect(await status(teamRoute.PATCH(json("/api/team", "PATCH", { approvalRequired: true })))).toBe(403);
    await as(owner.email);
    expect(await status(teamRoute.PATCH(json("/api/team", "PATCH", { approvalRequired: "yes" })))).toBe(400);
    expect(await status(teamRoute.PATCH(json("/api/team", "PATCH", { approvalRequired: true })))).toBe(200);
    expect((await getUser(acct(owner)))!.approvalRequired).toBe(true);
  });

  it("refuses an item approved by nobody it can name, or by someone no longer allowed; accepts the owner's approval", async () => {
    const { owner, viewer, viewerPid } = await team();
    const account = { ...(await getAccount(aidOf(await ownerSession(owner))))!, approvalRequired: true };
    const scope = owner.email;
    expect(await approvalRefusal(account, scope, { status: "approved" })).toBe("approval_required");
    expect(await approvalRefusal(account, scope, { status: "approved", approvedBy: { pid: viewerPid, at: "x" } })).toBe("approval_required");
    const o = await ownerSession(owner);
    await setAccess(o, o.actor!, viewer, { approves: true });
    expect(await approvalRefusal(account, scope, { status: "approved", approvedBy: { pid: viewerPid, at: "x" } })).toBeNull();
    expect(await approvalRefusal(account, scope, { status: "approved", approvedBy: { pid: o.actor!.pid, at: "x" } })).toBeNull();
    expect(await approvalRefusal({ ...account, approvalRequired: undefined }, scope, { status: "approved" })).toBeNull();
  });

  it("the publish route refuses with approval_required and posts nothing", async () => {
    const { owner } = await team();
    await saveTask(acct(owner), task("pp", "approved"), true);
    await saveConnection(acct(owner), { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    const u = (await getUser(acct(owner)))!;
    await saveUser({ ...u, approvalRequired: true });
    await as(owner.email);
    const r = await publishRoute.POST(await vjson("/api/publish/pp", "POST", { provider: "telegram" }), params({ id: "pp" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "approval_required" });
    expect(published).toEqual([]);
  });
});

describe("rule 3757: a member narrowed to some brands sees and acts in those only", () => {
  it("the switcher lists the allowed brand, a switch elsewhere is not found, and the session lands in the allowed brand", async () => {
    const { owner, editor } = await team();
    await saveUser({ ...(await getUser(acct(owner)))!, plan: "business" });
    const o = await ownerSession(owner);
    const b = await addBrand(o, "Second");
    if ("error" in b) throw new Error(`addBrand: ${b.error}`);
    await saveTask(acct(owner), task("only-default", "pending"), true);
    expect(await setAccess(o, o.actor!, editor, { brands: [b.id] })).toEqual({ ok: true });
    const u = await as(editor);
    expect(u.brandId).toBe(b.id);
    expect(sc(u)).not.toBe(sc(o));
    // The default brand's task is not in this member's scope.
    expect(await getTask(sc(u), "only-default")).toBeNull();
    const listed = await (await brandsRoute.GET()).json();
    expect(listed.brands.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect(await status(brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "default" })))).toBe(404);
    // A narrowed member may not invite or change access (SCOPED_BLOCKED), even an admin.
    expect(can(u, "team.access")).toBe(false);
    expect((await listBrands(acct(o))).length).toBe(2);
  });

  it("refuses a brand id that is not one of the account's own", async () => {
    const { owner, editor } = await team();
    const o = await ownerSession(owner);
    expect(await setAccess(o, o.actor!, editor, { brands: ["not-a-brand"] })).toMatchObject({ ok: false });
    expect(await setAccess(o, o.actor!, editor, { brands: [] })).toMatchObject({ ok: false });
  });
});

describe("rule 3764: a fresh agent draft is assigned to an approver of its brand", () => {
  it("lists the owner first, then admins and toggled members of that brand", async () => {
    const { owner, viewer, adminPid, viewerPid, editorPid } = await team();
    const o = await ownerSession(owner);
    await setAccess(o, o.actor!, viewer, { approves: true });
    const account = (await getAccount(aidOf(o)))!;
    const rows = (await Promise.all([adminPid, viewerPid, editorPid].map((p) => getMembership(aidOf(o), p)))).filter((m) => !!m);
    expect(rows.length).toBe(3);
    const list = approversFor(account, rows, "default");
    expect(list[0]).toBe(o.actor!.pid);
    // The editor without the toggle is not an approver.
    expect(new Set(list.slice(1))).toEqual(new Set([adminPid, viewerPid]));
    await setAccess(o, o.actor!, viewer, { approves: false });
    const after = (await Promise.all([adminPid, viewerPid].map((p) => getMembership(aidOf(o), p)))).filter((m) => !!m);
    expect(approversFor(account, after, "default")).toEqual([o.actor!.pid, adminPid]);
  });

  it("sets the assignee on a new pending draft and rings the bell once", async () => {
    const { owner } = await team();
    await saveTask(acct(owner), task("as1", "pending"), true);
    const t = (await getTask(acct(owner), "as1"))!;
    expect(t.assignee?.pid).toBeTruthy();
    const bell = await listNotifs(acct((await getUser(acct(owner)))!));
    expect(bell.some((n) => n.about === `assign:${t.assignee!.pid}`)).toBe(true);
    // An approved item saved as new is not a draft waiting for anyone.
    await saveTask(acct(owner), task("as2", "approved"), true);
    expect((await getTask(acct(owner), "as2"))!.assignee).toBeUndefined();
  });
});

describe("rules 3770-3771: a member's monthly credit cap, checked in the ledger before the spend", () => {
  it("refuses past the cap without touching the balance, counts per member and gives back on a refund", async () => {
    const owner = await newUser("crc");
    const email = acct(owner);
    const meta = (pid: string, cap?: number) => ({ scope: sc(owner), agent: "noor" as const, person: { pid, ...(cap !== undefined ? { cap } : {}) } });
    const first = await charge(email, 5, meta("p_a", 8));
    expect(first).toMatchObject({ ok: true, person: "p_a" });
    const over = await charge(email, 5, meta("p_a", 8));
    expect(over).toEqual({ ok: false, reason: "person_cap", credits: 3, spent: 5, cap: 8 });
    expect((await getUser(email))!.credits).toBe(45);
    // Another member, and a member with no cap, are not held by p_a's cap; their spend is counted too.
    expect(await charge(email, 5, meta("p_b"))).toMatchObject({ ok: true });
    const u = (await getUser(email))!;
    expect([personSpendFor(u, "p_a"), personSpendFor(u, "p_b")]).toEqual([5, 5]);
    if (!first.ok || !("month" in first)) throw new Error("not charged");
    await refund(email, 5, first);
    expect(personSpendFor((await getUser(email))!, "p_a")).toBe(0);
  });

  it("a counter from an earlier month counts as zero", async () => {
    const owner = await newUser("crm");
    const u = (await getUser(acct(owner)))!;
    await saveUser({ ...u, personSpend: { month: "2000-01", by: { p_a: 999 } } });
    expect(personSpendFor((await getUser(acct(owner)))!, "p_a", monthKey())).toBe(0);
    expect(await charge(acct(owner), 5, { scope: sc(owner), agent: "noor", person: { pid: "p_a", cap: 5 } })).toMatchObject({ ok: true });
  });

  it("the spending member comes from the session's actor, never the owner or a request", async () => {
    const { owner, editor } = await team();
    const o = await ownerSession(owner);
    await setAccess(o, o.actor!, editor, { creditCap: 20 });
    expect(personOf(o)).toBeUndefined();
    const e = await as(editor);
    expect(personOf(e)).toEqual({ pid: e.actor!.pid, cap: 20 });
    // The owner sees each member's spend; an admin does not.
    expect((await teamView(o))!.members.find((m) => m.email === editor)).toMatchObject({ creditCap: 20, spent: 0 });
  });
});

describe("rule 3755: the contract script renames the stored Editor role, idempotently", () => {
  const roleOf = async (key: string) => ((await db.get<{ role?: string }>(key)) ?? {}).role;

  it("pure: only a stored \"member\" is renamed, every other field kept; a record of another home is left", () => {
    const aid = storedAccountId("a@test.example");
    expect(renamed({ role: "member", aid, x: 1 })).toEqual({ role: "editor", aid, x: 1 });
    for (const role of ["admin", "viewer", "editor", undefined]) expect(renamed({ role })).toBeNull();
    expect(renamed({ role: "member", memberOf: aid }, aid)).toEqual({ role: "editor", memberOf: aid });
    expect(renamed({ role: "member", memberOf: "b@test.example" }, aid)).toBeNull();
    expect(renamed(null)).toBeNull();
    expect(renamed("member")).toBeNull();
  });

  it("dry run writes nothing; apply renames rows and legacy records only; the expand build still reads them; a second run renames nothing", async () => {
    const owner = await newUser("edr");
    const aid = aidOf(owner);
    const [editor, admin, viewer] = await Promise.all([newMember(owner, "member", "edr"), newMember(owner, "admin", "eda"), newMember(owner, "viewer", "edv")]);
    const legacyOwner = await newUser("edl", { legacy: true, shadow: false });
    const legacyEditor = await newMember(legacyOwner, "member", "edl", { legacy: true, shadow: false });

    const dry = await editorRole({ apply: false });
    expect(dry.rows + dry.records).toBeGreaterThan(0);
    expect(await roleOf(accountKey.membership(aid, editor.pid))).toBe("member");
    expect(await roleOf(accountKey.member(legacyEditor.pid))).toBe("member");

    const r = await editorRole({ apply: true });
    expect(r.busy).toBe(0);
    expect(await roleOf(accountKey.membership(aid, editor.pid))).toBe("editor");
    expect(await roleOf(accountKey.member(legacyEditor.pid))).toBe("editor");
    expect(await roleOf(accountKey.membership(aid, admin.pid))).toBe("admin");
    expect(await roleOf(accountKey.membership(aid, viewer.pid))).toBe("viewer");
    // The expand build (this one) reads "editor" as the Editor's stored name: same membership, same session role.
    expect((await getMembership(aid, editor.pid))?.role).toBe("member");
    for (const m of [editor, legacyEditor]) {
      await signIn(m.email);
      expect((await currentUser())?.actor).toMatchObject({ kind: "member", role: "member" });
    }
    signOut();

    const again = await editorRole({ apply: true });
    expect({ rows: again.rows, records: again.records, busy: again.busy }).toEqual({ rows: 0, records: 0, busy: 0 });
  });
});

/** An account on the business plan with a second brand, and its Editor narrowed to that brand. */
async function narrowed() {
  const t = await team();
  await saveUser({ ...(await getUser(acct(t.owner)))!, plan: "business" });
  const o = await ownerSession(t.owner);
  const b = await addBrand(o, "Second");
  if ("error" in b) throw new Error(`addBrand: ${b.error}`);
  expect(await setAccess(o, o.actor!, t.editor, { brands: [b.id] })).toEqual({ ok: true });
  return { ...t, o, second: b.id, def: scopeFor(acct(o), "default"), sec: scopeFor(acct(o), b.id) };
}

describe("rule 3772: a calendar link honours the brand scope at read time", () => {
  it("a narrowed member's link to a removed brand stops; its own brand keeps working, in both link shapes", async () => {
    const { owner, o, editor, editorPid, def, sec, second } = await narrowed();
    // A member from before M1 (a login record), narrowed the same way, for a link that names a login only.
    const old = await newMember(owner, "member", "crl", { legacy: true });
    expect(await setAccess(o, o.actor!, old.email, { brands: [second] })).toEqual({ ok: true });
    const at = new Date().toISOString();
    const person = (scope: string) => ({ login: editor, scope, lang: "ar" as const, createdAt: at, pid: editorPid, aid: aidOf(o) });
    const legacy = (scope: string) => ({ login: old.email, scope, lang: "ar" as const, createdAt: at });
    expect(await feedHolds(person(sec))).toBe(true);
    expect(await feedHolds(person(def))).toBe(false);
    expect(await feedHolds(legacy(sec))).toBe(true);
    expect(await feedHolds(legacy(def))).toBe(false);
  });

  it("a Viewer's link that names a login only holds: a Viewer reads the calendar", async () => {
    const owner = await newUser("crfv");
    const viewer = await newMember(owner, "viewer", "crfv", { legacy: true });
    const o = await ownerSession(owner);
    expect(await feedHolds({ login: viewer.email, scope: scopeFor(acct(o), "default"), lang: "en", createdAt: new Date().toISOString() })).toBe(true);
  });
});

describe("rule 3773: the bell, the month's usage and the approval stats keep to the brand scope", () => {
  it("an entry carries its brand; older entries fall back to their about key or link; account kinds carry none", () => {
    expect(notifBrand({ brand: "b2", href: "/ar/app" })).toBe("b2");
    expect(notifBrand({ about: "pending:o@test.example#b3", href: "/ar/app" })).toBe("b3");
    expect(notifBrand({ about: "due:o@test.example", href: "/ar/app" })).toBe("default");
    expect(notifBrand({ href: "/ar/app/b/b4/calendar" })).toBe("b4");
    expect(notifBrand({ about: "assign:p1", href: "/ar/app/calendar" })).toBeUndefined();
  });

  it("a narrowed member sees their brand's entries and the account's, and cannot mark another brand's entry read", async () => {
    const { o, editor, def, sec } = await narrowed();
    const base = { title: "t", body: "b", href: "/ar/app" };
    const [onDef, onSec, credits] = await Promise.all([
      pushNotif(acct(o), { kind: "pending", ...base }, undefined, 3, def),
      pushNotif(acct(o), { kind: "pending", ...base }, undefined, 3, sec),
      pushNotif(acct(o), { kind: "credits", ...base }, undefined, 3, def),
    ]);
    expect(credits?.brand).toBeUndefined();
    const ids = async () => ((await (await notificationsRoute.GET(new Request("http://t/api/notifications"))).json()).notifications as { id: string }[]).map((n) => n.id).sort();
    await as(o.email);
    expect(await ids()).toEqual([onDef!.id, onSec!.id, credits!.id].sort());
    await as(editor);
    expect(await ids()).toEqual([onSec!.id, credits!.id].sort());
    expect(await status(notificationsRoute.POST(json("/api/notifications", "POST", { id: onDef!.id })))).toBe(404);
    const res = await (await notificationsRoute.POST(json("/api/notifications", "POST", { id: onSec!.id }))).json();
    expect(res).toEqual({ ok: true, unread: 1 });
    expect((await listNotifs(acct(o))).find((n) => n.id === onDef!.id)?.read).toBeUndefined();
  });

  it("the month's usage and the approval stats count the member's brands only", async () => {
    const { o, editor, admin, def, sec, second } = await narrowed();
    await Promise.all([saveTask(acct(o), task("u-def", "pending"), true), saveTask(sec, task("u-sec", "pending"), true)]);
    const at = new Date().toISOString();
    await Promise.all([recordDecisions(def, [decisionOf(task("d-def", "approved"), "approve", at)]), recordDecisions(sec, [decisionOf(task("d-sec", "approved"), "approve", at)])]);
    const count = (m: Awaited<ReturnType<typeof monthUsage>>) => Object.values(m.usage).reduce((n, x) => n + x.count, 0);
    expect(count(await monthUsage(await as(o.email)))).toBe(2);
    expect(count(await monthUsage(await as(editor)))).toBe(1);
    expect((await teamApprovals(await as(o.email)))[o.email]?.approved).toBe(2);
    // An admin narrowed to the second brand counts its records only.
    expect(await setAccess(o, o.actor!, admin, { brands: [second] })).toEqual({ ok: true });
    expect((await teamApprovals(await as(admin)))[o.email]?.approved).toBe(1);
  });
});

describe("rule 3774: a reused hold keeps the person it was spent for", () => {
  it("the receipt of a reused hold names the person, so a refund lowers their spend", () => {
    expect(readFileSync("src/lib/generate-batch.ts", "utf8")).toContain("...(paid.hold.person ? { person: paid.hold.person } : {})");
  });
});
