import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as acceptRoute from "@/app/api/team/accept/route";
import * as inviteRoute from "@/app/api/team/invite/route";
import * as leaveRoute from "@/app/api/team/leave/route";
import * as listRoute from "@/app/api/workspaces/route";
import * as loginRoute from "@/app/api/auth/login/route";
import { appDict } from "@/lib/app-i18n";
import { acct, currentPerson, currentUser, getLogin, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, storedAccountId, type PersonId } from "@/lib/keys";
import { getMembership, ownerOf, pausedAccounts } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { listWorkspaces, pausedWorkspaces } from "@/lib/workspaces";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";

/**
 * Follow-ups of the M2 + R2 enable release (founder answers 2026-10-24 to its open questions, rules 3823-3825;
 * docs/system/tests/3823-multi-org-followups.md).
 */

const sent: { to: string; text: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (...a: unknown[]) => { const m = (typeof a[0] === "string" ? { to: a[0], text: a[2] } : a[0]) as { to: string; text: string }; sent.push({ to: m.to, text: m.text }); return true; } }));
let ipN = 0;
const ip = () => { ipN++; return { "x-forwarded-for": `198.19.${Math.floor(ipN / 250)}.${ipN % 250}` }; };
const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
const login = (email: string, password: string) => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": `10.38.${Math.floor(Math.random() * 250)}.3` }));
const create = (name: string) => listRoute.POST(json("/api/workspaces", "POST", { name, lang: "ar" }));
const listed = async () => ((await (await listRoute.GET()).json()) as { workspaces: unknown[] }).workspaces;
const setPaused = async (owner: User, pid: PersonId, on: boolean) => {
  const aid = storedAccountId(acct(owner));
  const ms = (await getMembership(aid, pid))!;
  await db.set(accountKey.membership(aid, pid), { aid, pid, role: ms.role, acceptedAt: ms.acceptedAt, invitedBy: ms.invitedBy, ...(on ? { disabled: "seats" } : {}) });
};

describe("rule 3823: billing rows in the founder's log name the sign-in address", () => {
  it("hand_plan_ended, refund_plan_ended and the Paymob rows target the address, as the console rows do", () => {
    const end = readFileSync("src/lib/hand-plan-end.ts", "utf8");
    expect(end).toContain('action: "hand_plan_ended", target: change.address,');
    expect(end).toContain("address: u.email };");
    const billing = readFileSync("src/lib/billing.ts", "utf8");
    expect(billing).toContain('action: "refund_plan_ended", target: change.address,');
    expect(billing).toContain('adminAudit({ actor: "paymob", section: "billing", target: (await getUser(account))?.email ?? account, what });');
    expect(billing).not.toMatch(/action: "refund_plan_ended", target: email,/);
  });
});

describe("rule 3824: a member who left or was removed can make their own workspace", () => {
  it("joins by the mailed link, leaves, signs in to no workspace, creates one and holds it as its owner", async () => {
    const owner = await pro(await newUser("fu", { shadow: false }));
    const addr = `fuj-${Date.now().toString(36)}@test.example`;
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>");
    await signIn(owner.email);
    expect((await inviteRoute.POST(json("/api/team/invite", "POST", { email: addr, role: "member" }, ip()))).status).toBe(200);
    const token = sent.find((x) => x.to === addr)!.text.match(/#t=([a-f0-9]{64})/)![1];
    signOut();
    expect((await acceptRoute.POST(json("/api/team/accept", "POST", { token, name: "Huda", password: "huda12345" }, ip()))).status).toBe(200);
    // The accepted invite proved the address: the person is verified from the join.
    const joined = (await getLogin(addr))!;
    expect(joined.person.emailVerifiedAt).toBeTruthy();
    expect((await leaveRoute.POST()).status).toBe(200);
    signOut();
    expect((await login(addr, "huda12345")).status).toBe(200);
    expect(await currentUser()).toBeNull();
    const me = (await currentPerson())!;
    expect(me.person.pid).toBe(joined.pid);
    // The page shows the create form to a verified person (`canCreate`), and the route agrees.
    expect(me.person.emailVerifiedAt).toBeTruthy();
    expect(await listed()).toEqual([]);
    expect((await create("مساحتي")).status).toBe(200);
    const rows = await listWorkspaces((await getPerson(joined.pid))!, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "owner" });
  });

  it("only an accepted invite stamps the address: insertMember's proof comes from acceptInvite", () => {
    const team = readFileSync("src/lib/team.ts", "utf8");
    expect(team).toContain("...(input.proved ? { emailVerifiedAt: now } : {})");
    expect(team).toContain("invitedByPid: inv.invitedByPid, proved: true }");
    expect(team.match(/proved: true \}/g)).toHaveLength(1);
  });

  it("the workspaces page passes canCreate from the person's verified address", () => {
    const page = readFileSync("src/app/[lang]/app/workspaces/page.tsx", "utf8");
    expect(page).toContain("canCreate={!!me.person.emailVerifiedAt}");
  });
});

describe("rule 3825: a paused seat is named on the workspaces page, never opened", () => {
  it("a paused membership is in pausedWorkspaces by name and out of the workspaces list; turned back on, it moves back", async () => {
    const owner = await pro(await newUser("fp", { shadow: false }));
    const m = await newMember(owner, "member", "fpm", { shadow: false });
    const aid = storedAccountId(acct(owner));
    await setPaused(owner, m.pid, true);
    const p = (await getPerson(m.pid))!;
    expect(await pausedAccounts(p)).toEqual([aid]);
    expect(await listWorkspaces(p, null)).toEqual([]);
    const names = await pausedWorkspaces(p);
    expect(names).toHaveLength(1);
    expect(typeof names[0]).toBe("string");
    await setPaused(owner, m.pid, false);
    expect(await pausedAccounts(p)).toEqual([]);
    expect(await listWorkspaces(p, null)).toHaveLength(1);
  });

  it("the owner and a person with no membership have no paused seat", async () => {
    const owner = await pro(await newUser("fo", { shadow: false }));
    expect(await pausedAccounts((await getPerson(ownerOf(owner)))!)).toEqual([]);
    const m = await newMember(owner, "member", "fon", { shadow: false });
    await db.del(accountKey.membership(storedAccountId(acct(owner)), m.pid));
    expect(await pausedAccounts((await getPerson(m.pid))!)).toEqual([]);
  });

  it("the page passes names only and the panel renders the notice, with no link or handle", () => {
    const page = readFileSync("src/app/[lang]/app/workspaces/page.tsx", "utf8");
    expect(page).toContain("pausedWorkspaces(me.person)");
    expect(page).toContain("paused={paused}");
    const panel = readFileSync("src/components/app/WorkspacesPanel.tsx", "utf8");
    expect(panel).toContain("paused?: string[]");
    expect(panel).toMatch(/paused\.map\(\(name, k\) => \(\s*<Callout key=\{k\} tone="warning"><span dir="auto">\{t\.paused\.replace\("\{workspace\}", name\)\}<\/span><\/Callout>/);
    for (const lang of ["ar", "en"] as const) expect(appDict[lang].workspaces.paused, lang).toContain("{workspace}");
  });
});
