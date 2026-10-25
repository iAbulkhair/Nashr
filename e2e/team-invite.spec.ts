import type { Page } from "@playwright/test";
import { test, expect, fillWhenReady, open } from "./fixtures/app";
import { appDict } from "../src/lib/app-i18n";
import { BRAND, apiTasks, createWorkspace, freshAccount, generateBatch, hydrated, inviteMember, inviteToken, joinAs, mockItem, useSession, versionOf } from "./fixtures/workspace";
import { simulatedIp } from "./fixtures/accounts";

/**
 * Teams: invite, accept, roles, seats, removal and leaving (src/app/api/team/*, src/lib/team.ts, the Members page and the
 * join page). The e2e server has no mail, so the invite answer carries the one-time link (spec 2026-09-29 section 6), and
 * the token sits after `#t=` where it never reaches a log.
 *
 * Each test signs its own owner up: seats, invites and members are per account, and the trial plan allows five invites a day
 * and three seats, so one owner cannot serve two tests. A new member picks a name and a password on the join page; a
 * member never signs up on their own.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const T = appDict.en.team;
const J = appDict.en.join;
const membersPath = "/en/app/settings/members";

type View = { you: { email: string; role: string }; seats: { used: number; limit: number }; members: Array<{ email: string; name: string; role: string }>; invites: Array<{ id: string; email: string; role: string }> };
const section = (page: Page, heading: string) => page.locator("section.card", { has: page.getByRole("heading", { name: heading, exact: true }) });

test("the owner invites a member from the Members page, who joins with a name and password and is removed again", async ({ page, browser, request, failures }) => {
  void failures;
  const owner = freshAccount("team-owner", "E2E Team Owner");
  const member = freshAccount("team-member", "E2E Team Member");
  await createWorkspace(page.request, owner, "team-invite-ui", "E2E Team Co");

  // The Members page of a new account: only the owner, no pending invites, one seat used.
  await open(page, membersPath);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(T.title);
  await expect(section(page, T.people)).toContainText(owner.email);
  await expect(section(page, T.people)).toContainText(`(${T.you})`);
  await expect(section(page, T.pending)).toContainText(T.noPending);

  // Invite: with no mail the page shows the link once, and the invite is listed as pending and holds a seat.
  await fillWhenReady(page.getByLabel(T.email, { exact: true }), member.email);
  const create = page.getByRole("button", { name: T.createLink });
  await hydrated(create);
  const sent = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/team/invite" && r.request().method() === "POST");
  await create.click();
  const res = await sent;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ email: member.email, role: "member" });
  await expect(page.getByText(T.linkTitle)).toBeVisible();
  const token = inviteToken(await page.locator("code", { hasText: "/join#t=" }).innerText());
  await expect(section(page, T.pending)).toContainText(member.email);
  await expect(section(page, T.pending).locator(".badge", { hasText: T.roles.member })).toHaveCount(1);
  const afterInvite = (await (await page.request.get("/api/team")).json()) as View;
  expect(afterInvite.invites.map((i) => i.email)).toEqual([member.email]);
  await expect(page.getByRole("progressbar", { name: T.seats })).toHaveAttribute("aria-valuenow", String(afterInvite.seats.used));
  await expect(page.getByText(`${afterInvite.seats.used} / ${afterInvite.seats.limit}`)).toBeVisible();
  expect(afterInvite.seats.used).toBe(2);
  // The server keeps the token's hash only: neither the roster nor the invite list ever carries the token.
  expect(JSON.stringify(afterInvite)).not.toContain(token);

  // The invitee, in a browser with no session, opens the link: the page previews the invite without using it up.
  const guestCtx = await browser.newContext();
  try {
    const guest = await guestCtx.newPage();
    await guest.goto(`/en/app/join#t=${token}`, { waitUntil: "domcontentloaded" });
    await expect(guest.getByRole("heading", { level: 1 })).toContainText(J.title);
    await expect(guest.getByText(/invited you to join/)).toBeVisible();
    await expect(guest.getByLabel(J.email, { exact: true })).toHaveValue(member.email);
    // The token leaves the address bar as soon as the page has read it.
    await expect.poll(() => new URL(guest.url()).hash).toBe("");

    // A weak password is refused on the page, with the rule that failed, and the invite is still usable afterwards.
    await fillWhenReady(guest.getByLabel(J.name, { exact: true }), member.name);
    await fillWhenReady(guest.getByLabel(J.password, { exact: true }), "short");
    // The button is aria-disabled until the rules are met (Playwright will not click it); Enter submits the form all the same.
    await guest.getByLabel(J.password, { exact: true }).press("Enter");
    await expect(guest.locator("form").getByRole("alert")).toBeVisible();

    await fillWhenReady(guest.getByLabel(J.password, { exact: true }), member.password);
    const accepted = guest.waitForResponse((r) => new URL(r.url()).pathname === "/api/team/accept" && r.request().method() === "POST" && !!r.request().postDataJSON()?.password);
    await guest.getByRole("button", { name: J.submit, exact: true }).click();
    expect((await accepted).status()).toBe(200);
    await guest.waitForURL((u) => !u.pathname.includes("/join"));

    // Signed in as a member of the owner's account, not as an owner of a new one.
    const view = (await (await guest.request.get("/api/team")).json()) as View;
    expect(view.you).toMatchObject({ email: member.email, role: "member" });
    expect(view.members.map((m) => m.email)).toEqual([owner.email, member.email]);
    expect(view.invites, "a member does not see pending invites").toEqual([]);

    // Their Members page: the roster and the leave button, but no invite form and no remove buttons.
    await open(guest, membersPath);
    await expect(section(guest, T.people)).toContainText(owner.email);
    await expect(guest.getByText(T.readOnly)).toBeVisible();
    await expect(guest.getByRole("heading", { name: T.invite, exact: true })).toHaveCount(0);
    await expect(guest.getByRole("button", { name: T.remove, exact: true })).toHaveCount(0);
    await expect(guest.getByRole("button", { name: T.leave, exact: true })).toBeVisible();

  } finally {
    await guestCtx.close();
  }
  // The link works once: the same token is now refused, both as a preview and as an accept.
  const reuse = await request.post("/api/team/accept", { data: { token } });
  expect(reuse.status()).toBe(400);
  expect((await reuse.json()).error).toBe("invalid");
  const reuseAccept = await request.post("/api/team/accept", { data: { token, name: "Someone Else", password: "e2epass123" }, headers: { "x-forwarded-for": simulatedIp("team-invite-reuse") } });
  expect(reuseAccept.status()).toBe(400);
  expect((await reuseAccept.json()).error).toBe("invalid");

  // Back on the owner's page the member is on the roster and no longer pending; the owner removes them from the dialog.
  await page.reload({ waitUntil: "domcontentloaded" });
  const row = section(page, T.people).locator("li", { hasText: member.email });
  await expect(row).toBeVisible();
  await expect(row.locator(".badge", { hasText: T.roles.member })).toHaveCount(1);
  await expect(section(page, T.pending)).toContainText(T.noPending);
  const remove = row.getByRole("button", { name: T.remove, exact: true });
  await hydrated(remove);
  await remove.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const removed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/team/member" && r.request().method() === "DELETE");
  await dialog.getByRole("button", { name: T.remove, exact: true }).click();
  expect((await removed).status()).toBe(200);
  await expect(section(page, T.people).locator("li", { hasText: member.email })).toHaveCount(0);
  const final = (await (await page.request.get("/api/team")).json()) as View;
  expect(final.members.map((m) => m.email)).toEqual([owner.email]);
  expect(final.seats.used).toBe(1);
});

test("invite rules: bad input, the owner's own address, duplicates, the daily limit and cancelling", async ({ request: owner }) => {
  const account = freshAccount("team-rules", "E2E Team Rules");
  const seed = "team-invite-rules";
  const ip = simulatedIp(seed);
  await createWorkspace(owner, account, seed, "E2E Rules Co");
  const post = (data: Record<string, unknown>) => owner.post("/api/team/invite", { data, headers: { "x-forwarded-for": ip } });
  const guest = freshAccount("team-guest", "E2E Guest");

  // The free trial allows five invite attempts a day, and every attempt counts, valid or not (src/app/api/team/invite).
  const badEmail = await post({ email: "not-an-email", role: "member" });
  expect(badEmail.status()).toBe(400);
  expect((await badEmail.json()).error).toBe("invalid_email");

  const badRole = await post({ email: guest.email, role: "owner" });
  expect(badRole.status(), "the owner role is never assignable").toBe(400);
  expect((await badRole.json()).error).toBe("invalid_role");

  const self = await post({ email: account.email, role: "member" });
  expect(self.status()).toBe(409);
  expect(["unavailable", "already_member"]).toContain((await self.json()).error);

  // A valid invite: the address is stored lower-cased and trimmed, the link comes back once, and no mail went out.
  const messy = `  ${guest.email.toUpperCase()}  `;
  const ok = await post({ email: messy, role: "member", lang: "en" });
  expect(ok.status(), await ok.text()).toBe(200);
  const body = (await ok.json()) as { ok: boolean; emailed: boolean; link: string; invite: { id: string; email: string; role: string; expiresAt: string } };
  expect(body).toMatchObject({ ok: true, emailed: false, invite: { email: guest.email, role: "member" } });
  expect(body.link).toMatch(/\/en\/app\/join#t=[a-f0-9]{64}$/);
  expect(new Date(body.invite.expiresAt).getTime(), "an invite lives seven days").toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  const token = inviteToken(body.link);

  // Pending: listed for the owner, by hash id, and the same address cannot be invited twice.
  const view = (await (await owner.get("/api/team")).json()) as View;
  expect(view.invites).toHaveLength(1);
  expect(view.invites[0]).toMatchObject({ email: guest.email, role: "member" });
  expect(view.invites[0].id).toBe(body.invite.id);
  expect(JSON.stringify(view)).not.toContain(token);
  const dup = await post({ email: guest.email, role: "member" });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toBe("unavailable");

  // The sixth attempt of the day is throttled, with the wait in Retry-After.
  const sixth = await post({ email: freshAccount("team-sixth", "E2E Sixth").email, role: "member" });
  expect(sixth.status()).toBe(429);
  expect((await sixth.json()).error).toBe("rate_limited");
  expect(Number(sixth.headers()["retry-after"])).toBeGreaterThan(0);

  // A malformed or unknown token previews as invalid (400), and a real one previews without being used up.
  for (const bad of ["abc", "0".repeat(64), ""]) {
    const res = await owner.post("/api/team/accept", { data: { token: bad }, headers: { "x-forwarded-for": ip } });
    expect(res.status(), `token "${bad}"`).toBe(400);
    expect((await res.json()).error).toBe("invalid");
  }
  for (let i = 0; i < 2; i++) {
    const peek = await owner.post("/api/team/accept", { data: { token }, headers: { "x-forwarded-for": ip } });
    expect(peek.status()).toBe(200);
    expect(((await peek.json()) as { preview: Record<string, unknown> }).preview).toMatchObject({ email: guest.email, role: "member" });
  }

  // Cancelling frees the seat and kills the link.
  const cancelled = await owner.delete("/api/team/invite", { data: { id: body.invite.id } });
  expect(cancelled.status()).toBe(200);
  const after = (await (await owner.get("/api/team")).json()) as View;
  expect(after.invites).toEqual([]);
  expect(after.seats.used).toBe(1);
  const dead = await owner.post("/api/team/accept", { data: { token }, headers: { "x-forwarded-for": ip } });
  expect(dead.status()).toBe(400);
  expect((await dead.json()).error).toBe("invalid");
});

test("roles and seats: an admin invites members only, a member can do none of it, the seat limit holds, removal ends the session", async ({ request: owner, playwright, baseURL }) => {
  const seed = "team-invite-roles";
  const base = baseURL!;
  const account = freshAccount("team-roles", "E2E Team Roles");
  const admin = freshAccount("team-admin", "E2E Team Admin");
  const member = freshAccount("team-plain", "E2E Team Plain");
  const brand = "E2E Roles Co";
  await createWorkspace(owner, account, seed, brand);
  await generateBatch(owner);
  const tasks = await apiTasks(owner);
  const item = mockItem(tasks, "social", 1, brand);

  // Owner invites an admin. Weak passwords and empty names are refused without using the invite up.
  const adminToken = await inviteMember(owner, admin.email, "admin", seed);
  const noName = await owner.post("/api/team/accept", { data: { token: adminToken, name: "", password: admin.password }, headers: { "x-forwarded-for": simulatedIp(seed) } });
  expect(noName.status()).toBe(400);
  expect((await noName.json()).error).toBe("invalid_name");
  const weak = await owner.post("/api/team/accept", { data: { token: adminToken, name: admin.name, password: "short" }, headers: { "x-forwarded-for": simulatedIp(seed) } });
  expect(weak.status()).toBe(400);
  expect((await weak.json()).error).toBe("weak_password");
  const adminApi = await joinAs(playwright, base, adminToken, admin, seed);
  let memberApi: Awaited<ReturnType<typeof joinAs>> | undefined;
  try {
    const adminView = (await (await adminApi.get("/api/team")).json()) as View;
    expect(adminView.you).toMatchObject({ email: admin.email, role: "admin" });
    expect(adminView.members.map((m) => m.email)).toEqual([account.email, admin.email]);

    // The admin sees what the owner sees in the shared inbox, and invites a member (an admin invites members only).
    const adminTasks = await apiTasks(adminApi);
    expect(adminTasks.map((t) => t.id).sort()).toEqual(tasks.map((t) => t.id).sort());
    const memberToken = await inviteMember(adminApi, member.email, "member", seed);
    const asAdmin = await adminApi.post("/api/team/invite", { data: { email: freshAccount("team-z", "Z").email, role: "admin" }, headers: { "x-forwarded-for": simulatedIp(seed) } });
    expect(asAdmin.status(), "only the owner invites admins").toBe(403);
    expect((await asAdmin.json()).error).toBe("forbidden");
    const patchRole = await adminApi.patch("/api/team/member", { data: { email: admin.email, role: "member" } });
    expect(patchRole.status(), "only the owner changes roles").toBe(403);

    // The pending invite holds a seat: the trial plan's seats are now all taken, and the next invite is refused with the count.
    const full = (await (await owner.get("/api/team")).json()) as View;
    expect(full.seats.used, "owner + admin + pending member fill the trial plan; update this spec if the plan's seats change").toBe(full.seats.limit);
    const noSeat = await adminApi.post("/api/team/invite", { data: { email: freshAccount("team-w", "W").email, role: "member" }, headers: { "x-forwarded-for": simulatedIp(seed) } });
    expect(noSeat.status()).toBe(409);
    expect(await noSeat.json()).toMatchObject({ error: "seats", used: full.seats.used, limit: full.seats.limit });

    // The member joins from the admin's invite; their role is the invite's.
    memberApi = await joinAs(playwright, base, memberToken, member, seed);
    const memberView = (await (await memberApi.get("/api/team")).json()) as View;
    expect(memberView.you).toMatchObject({ email: member.email, role: "member" });
    expect(memberView.invites, "a member does not see invites").toEqual([]);

    // A member can read the shared inbox but cannot invite, change roles, remove anyone, approve or publish.
    expect((await apiTasks(memberApi)).map((t) => t.id).sort()).toEqual(tasks.map((t) => t.id).sort());
    const forbidden = [
      await memberApi.post("/api/team/invite", { data: { email: freshAccount("team-v", "V").email, role: "member" }, headers: { "x-forwarded-for": simulatedIp(seed) } }),
      await memberApi.patch("/api/team/member", { data: { email: admin.email, role: "member" } }),
      await memberApi.delete("/api/team/member", { data: { email: admin.email } }),
      await memberApi.patch(`/api/tasks/${item.id}`, { data: { status: "approved", version: versionOf(item) }, headers: BRAND }),
      await memberApi.post(`/api/publish/${item.id}`, { data: { provider: "instagram", version: versionOf(item) }, headers: BRAND }),
    ];
    for (const res of forbidden) {
      expect(res.status(), res.url()).toBe(403);
    }
    // None of those changed anything.
    expect((await apiTasks(owner)).find((t) => t.id === item.id)?.status).toBe("pending");
    // The owner cannot leave their own account.
    expect((await owner.post("/api/team/leave")).status()).toBe(403);

    // The owner promotes the member; the member's next request already shows the new role (it is read on every request).
    const promote = await owner.patch("/api/team/member", { data: { email: member.email, role: "admin" } });
    expect(promote.status()).toBe(200);
    expect(((await (await memberApi.get("/api/team")).json()) as View).you.role).toBe("admin");

    // Removal ends the session at the next request, frees the seat, and the address can be invited again.
    const remove = await owner.delete("/api/team/member", { data: { email: member.email } });
    expect(remove.status()).toBe(200);
    expect((await memberApi.get("/api/team")).status()).toBe(401);
    expect((await memberApi.get("/api/tasks")).status()).toBe(401);
    const afterRemoval = (await (await owner.get("/api/team")).json()) as View;
    expect(afterRemoval.members.map((m) => m.email)).toEqual([account.email, admin.email]);
    expect(afterRemoval.seats.used).toBe(afterRemoval.seats.limit - 1);
  } finally {
    await adminApi.dispose();
    await memberApi?.dispose();
  }
});

test("a member leaves the account from the Members page and is signed out", async ({ page, request: owner, playwright, baseURL }) => {
  const seed = "team-invite-leave";
  const account = freshAccount("team-leave-o", "E2E Leave Owner");
  const member = freshAccount("team-leave-m", "E2E Leave Member");
  await createWorkspace(owner, account, seed, "E2E Leave Co");
  const token = await inviteMember(owner, member.email, "member", seed);
  const memberApi = await joinAs(playwright, baseURL!, token, member, seed);
  try {
    await useSession(page.context(), memberApi);
    await open(page, membersPath);
    await expect(section(page, T.people)).toContainText(member.email);
    const leave = page.getByRole("button", { name: T.leave, exact: true });
    await hydrated(leave);
    await leave.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(T.confirmLeave);
    const left = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/team/leave" && r.request().method() === "POST");
    await dialog.getByRole("button", { name: T.leave, exact: true }).click();
    expect((await left).status()).toBe(200);
    await page.waitForURL((u) => u.pathname === "/en/app/login");

    // The login is gone: the old session is refused, and the owner's roster and seats are back to the owner alone.
    expect((await memberApi.get("/api/team")).status()).toBe(401);
    const view = (await (await owner.get("/api/team")).json()) as View;
    expect(view.members.map((m) => m.email)).toEqual([account.email]);
    expect(view.seats.used).toBe(1);
    // The person is kept with no workspace (rules 2124, 2126; spec decision 10): the login works and opens nothing of
    // the account they left.
    const again = await playwright.request.newContext({ baseURL: baseURL! });
    try {
      const login = await again.post("/api/auth/login", { data: { email: member.email, password: member.password }, headers: { "x-forwarded-for": simulatedIp(seed) } });
      expect(login.status(), await login.text()).toBe(200);
      expect(((await (await again.get("/api/workspaces")).json()) as { workspaces: unknown[] }).workspaces).toEqual([]);
      expect((await again.get("/api/team")).status()).toBe(401);
    } finally {
      await again.dispose();
    }
  } finally {
    await memberApi.dispose();
  }
});
