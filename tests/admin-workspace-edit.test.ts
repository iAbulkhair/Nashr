import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";

/** The mail provider, played here: a send succeeds unless `mail.works` is off; every sent message is kept. */
const { sent, mail } = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], mail: { works: true } }));
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => {
    const m = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as { to: string; subject: string; text: string };
    if (!mail.works) return false;
    sent.push({ to: m.to, subject: m.subject, text: m.text });
    return true;
  },
}));

import { json, newMember, newUser, params, signOut } from "./helpers/session";
import { codeAt, enrolledStaff } from "./helpers/staff";
import { db } from "@/lib/db";
import { getAccount, saveUser, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { accountKey } from "@/lib/keys";
import { aidOf } from "@/lib/membership";
import { allow, WINDOW } from "@/lib/rate";
import { ENROLMENT_KEY, sealSecret, type Enrolment } from "@/lib/admin-2fa";
import { newRecoveryCode, newTotpSecret, recoveryHash } from "@/lib/totp";
import { staffMay, STAFF_MAY } from "@/lib/roles";
import { listInvites, listMembers } from "@/lib/team";
import { readTeamLog } from "@/lib/teamlog";
import { listNotifs } from "@/lib/notifications";
import { cleanWorkspaceName, consoleActor, parseEdit } from "@/lib/admin-workspace-edit";
import * as edit from "@/app/api/admin/users/[email]/workspace/edit/route";
import * as view from "@/app/api/admin/users/[email]/workspace/route";

/**
 * Rules 3550-3569: the founder console edits a customer workspace (docs/system/flows.md section 126,
 * docs/system/tests/3550-admin-workspace-edit.md). POST /api/admin/users/{email}/workspace/edit renames it, invites a
 * member, removes a member or cancels a pending invite, through the customer's own team functions, as the account owner,
 * with an audit row, a team log row "by Thakeen support" and a notice to the owner.
 */

const KEY = "workspace-edit-admin-key-0123456789";
const asKey = { "x-admin-key": KEY };
const REASON = "Customer asked by phone";
const read = (f: string) => readFileSync(f, "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = { section?: string; action?: string; target?: string; actor?: string; via?: string; reason?: string; before?: unknown; after?: unknown; what?: string };
const auditRows = async (target: string): Promise<Row[]> =>
  (await db.lrange("admin:log", 0, 500)).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as Row).filter((r) => r.target === target && r.action?.startsWith("workspace.") && r.action !== "workspace.view");

const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = asKey) =>
  edit.POST(json(`/api/admin/users/${encodeURIComponent(path)}/workspace/edit`, "POST", { reason: REASON, ...body }, headers), params({ email: encodeURIComponent(path) }));
const answer = async (r: Response) => ({ status: r.status, body: await r.json() });
const openWs = (email: string, headers: Record<string, string> = asKey) =>
  view.GET(json(`/api/admin/users/${encodeURIComponent(email)}/workspace`, "GET", undefined, headers), params({ email: encodeURIComponent(email) }));

async function account(prefix: string, seats = 5): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...(await getAccount(acct(u)))!, seats });
  return (await getAccount(acct(u)))!;
}
const invitee = (p = "inv") => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.example`;

async function enrolConsoleSecondFactor(): Promise<string> {
  const secret = newTotpSecret();
  await db.set(ENROLMENT_KEY, { enc: sealSecret(secret), rc: recoveryHash(newRecoveryCode()), at: new Date().toISOString(), by: "key" } satisfies Enrolment);
  return secret;
}

beforeEach(() => {
  sent.length = 0;
  mail.works = true;
  signOut();
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  vi.stubEnv("CONNECT_SECRET", "workspace-edit-connect-secret");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>");
});
afterEach(async () => {
  signOut();
  await db.del(ENROLMENT_KEY);
});

describe("rule 3550: only the console owner may change a workspace", () => {
  it("STAFF_MAY: workspace.edit is owner only and fails closed; support may still view", () => {
    expect(STAFF_MAY["workspace.edit"]).toEqual(["owner"]);
    expect(staffMay("owner", "workspace.edit")).toBe(true);
    for (const r of ["support", null, undefined, "", "Owner", "ghost", 1]) expect(staffMay(r, "workspace.edit"), String(r)).toBe(false);
    expect(staffMay("support", "workspace.view")).toBe(true);
  });

  it("no console actor: 401 and nothing changes", async () => {
    const o = await account("wse-none");
    expect((await post(o.email, { action: "rename", owner: o.email, name: "Nope" }, {})).status).toBe(401);
    expect((await getAccount(acct(o)))!.workspaceName).toBeUndefined();
  });

  it("a support staff session gets 403 forbidden, nothing changes, no audit row; its view says may: false", async () => {
    const o = await account("wse-sup");
    const m = await newMember(o, "member", "wsesup");
    const { staff } = await enrolledStaff({ role: "support" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    expect(await answer(await post(o.email, { action: "remove", owner: o.email, email: m.email }, {}))).toEqual({ status: 403, body: { ok: false, error: "forbidden" } });
    expect((await listMembers(acct(o))).map((x) => x.email)).toContain(m.email);
    expect(await auditRows(o.email)).toEqual([]);
    expect((await (await openWs(o.email, {})).json()).may).toBe(false);
  });

  it("the key's view says may: true", async () => {
    const o = await account("wse-may");
    expect((await (await openWs(o.email)).json()).may).toBe(true);
  });
});

describe("rule 3550: a second factor and a reason, like every sensitive console write", () => {
  it("an owner staff session without a code gets second_factor; with its own code the change goes through", async () => {
    const o = await account("wse-staff");
    const { staff, secret } = await enrolledStaff({ role: "owner" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    const no = await answer(await post(o.email, { action: "rename", owner: o.email, name: "Staff rename" }, {}));
    expect(no.status).toBe(403);
    expect(no.body.error).toBe("second_factor");
    expect((await getAccount(acct(o)))!.workspaceName).toBeUndefined();
    const ok = await answer(await post(o.email, { action: "rename", owner: o.email, name: "Staff rename" }, { "x-admin-otp": codeAt(secret) }));
    expect(ok).toEqual({ status: 200, body: { ok: true, action: "rename", subject: "Staff rename" } });
    const [row] = await auditRows(o.email);
    expect(row).toMatchObject({ actor: staff.email, via: "staff", action: "workspace.rename", reason: REASON });
    // The customer's team log never names the staff member (rule 2129).
    expect(JSON.stringify(await readTeamLog(aidOf(o)))).not.toContain(staff.email);
  });

  it("once the console second factor is enrolled, the key needs a code too", async () => {
    const o = await account("wse-2fa");
    const secret = await enrolConsoleSecondFactor();
    const no = await answer(await post(o.email, { action: "rename", owner: o.email, name: "Coded" }));
    expect(no.status).toBe(403);
    expect(no.body.error).toBe("second_factor");
    expect((await post(o.email, { action: "rename", owner: o.email, name: "Coded" }, { ...asKey, "x-admin-otp": codeAt(secret) })).status).toBe(200);
  });

  it("a reason of 3 to 200 characters is required (400) and a malformed body is refused (400)", async () => {
    const o = await account("wse-reason");
    expect((await answer(await post(o.email, { action: "rename", owner: o.email, name: "X", reason: "" }))).body.error).toBe("reason_short");
    expect((await answer(await post(o.email, { action: "promote", owner: o.email }))).body.error).toBe("bad_request");
    expect((await answer(await post(o.email, { action: "rename", name: "X" }))).body.error).toBe("bad_request");
    expect(await auditRows(o.email)).toEqual([]);
  });
});

describe("rules 3551-3552: tenant scope: the account comes from the stored login, never the body; the owner acts", () => {
  it("an owner address that is not the resolved account's owner is 409 workspace_changed and nothing changes", async () => {
    const a = await account("wse-ta");
    const b = await account("wse-tb");
    const mb = await newMember(b, "member", "wsetb");
    expect((await answer(await post(a.email, { action: "remove", owner: b.email, email: mb.email }))).body.error).toBe("workspace_changed");
    expect((await listMembers(acct(b))).map((x) => x.email)).toContain(mb.email);
  });

  it("removing another account's member or cancelling another account's invite through A is 404 and B is untouched", async () => {
    const a = await account("wse-xa");
    const b = await account("wse-xb");
    const mb = await newMember(b, "member", "wsexb");
    const to = invitee("xb");
    expect((await post(b.email, { action: "invite", owner: b.email, email: to, role: "member" })).status).toBe(200);
    expect(await answer(await post(a.email, { action: "remove", owner: a.email, email: mb.email }))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect(await answer(await post(a.email, { action: "cancel_invite", owner: a.email, email: to }))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect((await listMembers(acct(b))).map((x) => x.email)).toContain(mb.email);
    expect((await listInvites(acct(b))).map((x) => x.email)).toContain(to);
    expect(await readTeamLog(aidOf(a))).toEqual([]);
  });

  it("a member's address opens the owner's account, and the change lands there", async () => {
    const o = await account("wse-via");
    const m = await newMember(o, "member", "wsevia");
    expect((await post(m.email, { action: "rename", owner: o.email, name: "Via member" })).status).toBe(200);
    expect((await getAccount(acct(o)))!.workspaceName).toBe("Via member");
  });

  it("an unknown address is 404", async () => {
    const nobody = invitee("nobody");
    expect((await post(nobody, { action: "rename", owner: nobody, name: "X" })).status).toBe(404);
  });

  it("the acting person is the owner, never a staff identity", () => {
    const o = { email: "o@test.example", id: "o@test.example", name: "O", lang: "ar" } as User;
    expect(consoleActor(o)).toMatchObject({ kind: "owner", email: "o@test.example", role: "owner", home: true });
  });
});

describe("rules 3553-3555, 3557, 3561: the changes, through the customer's team functions", () => {
  it("rename: workspaceName, one team log row via console, one audit row with before and after, the owner told", async () => {
    const o = await account("wse-ren");
    const res = await answer(await post(o.email, { action: "rename", owner: o.email, name: "  Al  Noor‮ Shop " }));
    expect(res.status).toBe(200);
    expect((await getAccount(acct(o)))!.workspaceName).toBe("Al Noor Shop");
    const log = await readTeamLog(aidOf(o));
    expect(log[0]).toMatchObject({ kind: "workspace_renamed", via: "console", actor: { email: o.email } });
    const [row] = await auditRows(o.email);
    expect(row).toMatchObject({ section: "users", action: "workspace.rename", actor: "key", reason: REASON });
    expect(JSON.stringify(row)).toContain("Al Noor Shop");
    const bell = await listNotifs(acct(o));
    expect(bell[0].title).toMatch(/فريق ذكين|Thakeen support/);
    expect((await (await openWs(o.email)).json()).workspaceName).toBe("Al Noor Shop");
    expect((await answer(await post(o.email, { action: "rename", owner: o.email, name: "Al Noor Shop" }))).body.error).toBe("unchanged");
    expect((await answer(await post(o.email, { action: "rename", owner: o.email, name: "x".repeat(81) }))).body.error).toBe("bad_name");
  });

  it("invite: emailed to the invitee only, from the owner's address; no link in the answer; team log via console; audit; notice", async () => {
    const o = await account("wse-inv");
    const to = invitee();
    const res = await answer(await post(o.email, { action: "invite", owner: o.email, email: to, role: "admin", lang: "en" }));
    expect(res).toEqual({ status: 200, body: { ok: true, action: "invite", subject: to } });
    expect(JSON.stringify(res.body)).not.toMatch(/#t=|token|link/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(to);
    expect(sent[0].text).toContain(o.email);
    const [inv] = await listInvites(acct(o));
    expect(inv).toMatchObject({ email: to, role: "admin", invitedBy: o.email });
    expect((await readTeamLog(aidOf(o)))[0]).toMatchObject({ kind: "invited", via: "console", actor: { email: o.email }, target: { email: to }, role: "admin" });
    expect((await auditRows(o.email))[0]).toMatchObject({ action: "workspace.invite", reason: REASON });
    const bell = await listNotifs(acct(o));
    expect(bell).toHaveLength(1);
    // The bell is shared by every login of the account: it names neither the address nor the role.
    expect(JSON.stringify(bell[0])).not.toContain(to);
  });

  it("invite: refused while mail is off (no link for staff), on a suspended account, and withdrawn when the send fails", async () => {
    const o = await account("wse-inv2");
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await answer(await post(o.email, { action: "invite", owner: o.email, email: invitee(), role: "member" }))).body.error).toBe("mail_unavailable");
    vi.stubEnv("RESEND_API_KEY", "test-key");
    mail.works = false;
    const r = await answer(await post(o.email, { action: "invite", owner: o.email, email: invitee(), role: "member" }));
    expect(r).toEqual({ status: 502, body: { ok: false, error: "send_failed" } });
    expect(await listInvites(acct(o))).toEqual([]);
    mail.works = true;
    await saveUser({ ...(await getAccount(acct(o)))!, suspended: true });
    expect((await answer(await post(o.email, { action: "invite", owner: o.email, email: invitee(), role: "member" }))).body.error).toBe("suspended");
    expect(await auditRows(o.email)).toEqual([]);
  });

  it("rule 3553 (seats): the seat limit holds exactly as for the owner", async () => {
    const o = await account("wse-seat", 2);
    await newMember(o, "member", "wseseat");
    const r = await answer(await post(o.email, { action: "invite", owner: o.email, email: invitee(), role: "member" }));
    expect(r).toEqual({ status: 409, body: { error: "seats", used: 2, limit: 2 } });
    expect(sent).toHaveLength(0);
    expect(await listInvites(acct(o))).toEqual([]);
  });

  it("rule 3555: the owner can never be removed, opened from the owner's or a member's address", async () => {
    const o = await account("wse-own");
    const m = await newMember(o, "member", "wseown");
    expect(await answer(await post(o.email, { action: "remove", owner: o.email, email: o.email }))).toEqual({ status: 400, body: { ok: false, error: "owner_protected" } });
    expect((await answer(await post(m.email, { action: "remove", owner: o.email, email: o.email.toUpperCase() }))).body.error).toBe("owner_protected");
    expect(await getAccount(acct(o))).not.toBeNull();
    // No role change is offered at all.
    expect(parseEdit({ action: "role", owner: o.email, email: m.email, role: "admin" })).toBeNull();
    expect(parseEdit({ action: "transfer", owner: o.email, email: m.email })).toBeNull();
  });

  it("remove: the member leaves the roster, a removed row via console, audit with the role before, owner told", async () => {
    const o = await account("wse-rm");
    const m = await newMember(o, "admin", "wserm");
    expect((await post(o.email, { action: "remove", owner: o.email, email: m.email })).status).toBe(200);
    expect((await listMembers(acct(o))).map((x) => x.email)).not.toContain(m.email);
    expect((await readTeamLog(aidOf(o)))[0]).toMatchObject({ kind: "removed", via: "console", actor: { email: o.email }, target: { email: m.email } });
    expect((await auditRows(o.email))[0]).toMatchObject({ action: "workspace.remove", before: { email: m.email, role: "admin" } });
    expect(await listNotifs(acct(o))).toHaveLength(1);
  });

  it("cancel_invite: found by address in the account's own index, cancelled, a row via console", async () => {
    const o = await account("wse-cx");
    const to = invitee("cx");
    expect((await post(o.email, { action: "invite", owner: o.email, email: to, role: "member" })).status).toBe(200);
    expect((await post(o.email, { action: "cancel_invite", owner: o.email, email: to })).status).toBe(200);
    expect(await listInvites(acct(o))).toEqual([]);
    expect((await readTeamLog(aidOf(o)))[0]).toMatchObject({ kind: "invite_cancelled", via: "console", target: { email: to } });
    expect((await auditRows(o.email)).map((r) => r.action).sort()).toEqual(["workspace.cancel_invite", "workspace.invite"]);
  });
});

describe("rule 3556: rate limits", () => {
  it("the per-address invite bucket is the customer route's own: 5 a day across both", async () => {
    const o = await account("wse-rate");
    const to = invitee("rate");
    for (let i = 0; i < 5; i++) await allow(accountKey.inviteToBucket(sha(to)), 5, WINDOW.day);
    const r = await post(o.email, { action: "invite", owner: o.email, email: to, role: "member" });
    expect(r.status).toBe(429);
    expect(await listInvites(acct(o))).toEqual([]);
  });

  it("the per-account bucket stops a 31st change in a day", async () => {
    const o = await account("wse-rate2");
    for (let i = 0; i < 30; i++) await allow(accountKey.consoleTeamBucket(aidOf(o)), 30, WINDOW.day);
    expect((await post(o.email, { action: "rename", owner: o.email, name: "Late" })).status).toBe(429);
  });
});

describe("rules 3559-3561: names, the order of the gates and source pins", () => {
  it("cleanWorkspaceName strips control and bidi characters and bounds the length", () => {
    expect(cleanWorkspaceName(" A\u0000B⁧C ")).toBe("A B C");
    expect(cleanWorkspaceName("")).toBeNull();
    expect(cleanWorkspaceName("‮")).toBeNull();
    expect(cleanWorkspaceName("ب".repeat(80))).toBe("ب".repeat(80));
    expect(cleanWorkspaceName("ب".repeat(81))).toBeNull();
    expect(cleanWorkspaceName(5)).toBeNull();
  });

  it("route: actor, owner-only, second factor, body, reason, limits, account from the stored login, change, audit, notice, answer", () => {
    const src = read("src/app/api/admin/users/[email]/workspace/edit/route.ts");
    const at = (s: string) => { const i = src.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const order = [
      "await adminActor(req)",
      'staffMay(consoleRole(req), "workspace.edit")',
      "await secondFactorRefusal(req, who)",
      "parseEdit(raw)",
      "reasonRefused(raw?.reason)",
      "accountKey.consoleActorBucket(",
      "await accountForChosen(chosen)",
      "input.owner !== owner.email",
      "accountKey.consoleTeamBucket(",
      "await applyEdit(owner, input)",
      "await adminAudit(",
      "await tellOwnerOfEdit(owner, done)",
      "NextResponse.json({ ok: true, action: done.action",
    ];
    for (let i = 1; i < order.length; i++) expect(at(order[i - 1]), `${order[i - 1]} before ${order[i]}`).toBeLessThan(at(order[i]));
    // No key is built from the request in the route or the lib, and nothing is awaited inside a loop.
    const lib = read("src/lib/admin-workspace-edit.ts");
    for (const f of [src, lib]) {
      expect(f).not.toMatch(/`[a-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*:\$\{/);
      expect(f).not.toMatch(/\bdb\./);
      expect(f).not.toMatch(/for \([^)]*\)\s*\{?[^}]*await /);
    }
    // The lib changes teams only through the customer's own functions, with via "console".
    for (const s of ['createInvite(owner, a, email, input.role ?? "", lang, { via: "console" })', 'removeMember(owner, a, email, { via: "console" })', 'cancelInvite(owner, a, inv.id, { via: "console" })']) expect(lib).toContain(s);
  });

  it("the panel's edit requests live in WorkspaceEdit.tsx; the owner row has no button", () => {
    const panel = read("src/components/admin/WorkspacePanel.tsx");
    const editUi = read("src/components/admin/WorkspaceEdit.tsx");
    expect(panel).toContain("useWorkspaceEdit(");
    expect(editUi).toContain("/workspace/edit`");
    expect(editUi).toContain("mustMatch: member");
    expect(editUi).toContain("mustMatch: invited");
    expect(editUi).not.toMatch(/dangerouslySetInnerHTML/);
    const ownerSection = panel.slice(panel.indexOf('id="ws-owner"'), panel.indexOf('id="ws-plan"'));
    expect(ownerSection).not.toContain("<button");
  });
});
