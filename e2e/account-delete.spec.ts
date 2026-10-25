import { test, expect, fillWhenReady, open } from "./fixtures/app";
import { signUpVerified, simulatedIp } from "./fixtures/accounts";
import { apiTasks, createWorkspace, freshAccount, generateBatch, hydrated, inviteMember, joinAs } from "./fixtures/workspace";

/**
 * Deleting the account (DELETE /api/account, the Danger zone page and its dialog, rule 964): owner only, the password and
 * the typed address are both asked, and the wipe takes the brands, tasks, members and pending invites with it. The sessions
 * of everyone in the account stop at their next request, and the address can sign up again as a brand new, empty account.
 *
 * The dialog's wording is copied from src/components/app/DeleteAccountDialog.tsx (English); a change there changes it here.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const DELETE = { open: "Delete my account", typeEmail: /type your email address/i, password: "Password", confirm: "Delete my account for good", wrong: "Wrong password" };

test("the owner deletes the account from the Danger zone; members, invites and data go with it and the address is free again", async ({ page, request, playwright, baseURL }) => {
  const seed = "account-delete";
  const owner = freshAccount("del-owner", "E2E Delete Owner");
  const member = freshAccount("del-member", "E2E Delete Member");
  const invitee = freshAccount("del-invitee", "E2E Delete Invitee");
  await createWorkspace(page.request, owner, seed, "E2E Delete Co");
  await generateBatch(page.request);
  expect(await apiTasks(page.request)).toHaveLength(10);

  // A member who has joined, and an invite nobody has used yet: both belong to the account that is about to go.
  const memberToken = await inviteMember(page.request, member.email, "member", seed);
  const pendingToken = await inviteMember(page.request, invitee.email, "member", seed);
  const memberApi = await joinAs(playwright, baseURL!, memberToken, member, seed);
  // A second copy of the owner's session, so the test can show it is refused after the wipe and not only cleared in the browser.
  const ownerCopy = await playwright.request.newContext({ baseURL: baseURL!, storageState: await page.request.storageState() });
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    // Who may delete: no one signed out, and not a member, whatever the password.
    expect((await anonymous.delete("/api/account", { data: { password: owner.password } })).status()).toBe(401);
    const asMember = await memberApi.delete("/api/account", { data: { password: member.password } });
    expect(asMember.status(), "a member cannot delete the owner's account").toBe(403);
    // A wrong password is refused with nothing deleted.
    const wrong = await page.request.delete("/api/account", { data: { password: "not-the-password1" } });
    expect(wrong.status()).toBe(401);
    expect((await wrong.json()).error).toBe("wrong_password");
    expect((await apiTasks(page.request)).length).toBe(10);
    expect((await memberApi.get("/api/team")).status()).toBe(200);

    // The page: the owner's Danger zone offers the delete button; the dialog asks for the address and the password.
    await open(page, "/en/app/settings/danger");
    const start = page.getByRole("button", { name: DELETE.open, exact: true });
    await hydrated(start);
    await start.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: DELETE.confirm, exact: true });
    await expect(confirm, "nothing can be sent before the address and the password are typed").toBeDisabled();

    // The address typed is compared with the account's: a different one keeps the button off.
    const typed = dialog.getByRole("textbox", { name: DELETE.typeEmail });
    const pw = dialog.getByLabel(DELETE.password, { exact: true });
    await fillWhenReady(typed, "someone-else@test.example");
    await fillWhenReady(pw, owner.password);
    await expect(confirm).toBeDisabled();
    // Case does not matter (an email field drops the spaces itself, so only the case is tried).
    await fillWhenReady(typed, owner.email.toUpperCase());
    await expect(confirm).toBeEnabled();

    // A wrong password is answered inside the dialog, and the account is untouched.
    await fillWhenReady(pw, "not-the-password1");
    const refused = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/account" && r.request().method() === "DELETE");
    await confirm.click();
    expect((await refused).status()).toBe(401);
    await expect(dialog.getByRole("alert")).toContainText(DELETE.wrong);
    await expect(dialog).toBeVisible();
    expect((await apiTasks(page.request)).length).toBe(10);

    // The right password deletes it and sends the browser to the public home page.
    await fillWhenReady(pw, owner.password);
    const deleted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/account" && r.request().method() === "DELETE");
    await confirm.click();
    expect((await deleted).status()).toBe(200);
    await page.waitForURL((u) => u.pathname === "/en" || u.pathname === "/en/");

    // Everything is gone. The owner's session, even a copy of it, is refused; so is the member's, and the owner cannot log in again.
    expect((await page.request.get("/api/tasks")).status()).toBe(401);
    expect((await ownerCopy.get("/api/tasks")).status()).toBe(401);
    expect((await memberApi.get("/api/team")).status()).toBe(401);
    const ownerLogin = await request.post("/api/auth/login", { data: { email: owner.email, password: owner.password }, headers: { "x-forwarded-for": simulatedIp(`${seed}-${owner.email}`) } });
    expect(ownerLogin.status(), `${owner.email} can still log in`).toBe(401);
    // The member is a person of their own, kept with no workspace (rules 2124, 2126; spec decision 10): the login works
    // and opens nothing of the deleted account.
    const memberAgain = await playwright.request.newContext({ baseURL: baseURL! });
    try {
      const login = await memberAgain.post("/api/auth/login", { data: { email: member.email, password: member.password }, headers: { "x-forwarded-for": simulatedIp(`${seed}-${member.email}`) } });
      expect(login.status(), await login.text()).toBe(200);
      expect(((await (await memberAgain.get("/api/workspaces")).json()) as { workspaces: unknown[] }).workspaces).toEqual([]);
      expect((await memberAgain.get("/api/team")).status()).toBe(401);
    } finally {
      await memberAgain.dispose();
    }
    // The pending invite died with the account: it previews as invalid and cannot be accepted.
    const peek = await request.post("/api/team/accept", { data: { token: pendingToken }, headers: { "x-forwarded-for": simulatedIp(seed) } });
    expect(peek.status()).toBe(400);
    expect((await peek.json()).error).toBe("invalid");
    const accept = await request.post("/api/team/accept", { data: { token: pendingToken, name: invitee.name, password: invitee.password }, headers: { "x-forwarded-for": simulatedIp(seed) } });
    expect(accept.status()).toBe(400);

    // The address signs up again as a new account: no tasks, no team, nothing from before.
    const again = await signUpVerified(request, { email: owner.email, name: owner.name, password: owner.password, lang: "en" }, seed);
    expect(again.status(), await again.text()).toBe(200);
    expect(await apiTasks(request)).toEqual([]);
    const team = (await (await request.get("/api/team")).json()) as { members: Array<{ email: string }>; invites: unknown[] };
    expect(team.members.map((m) => m.email)).toEqual([owner.email]);
    expect(team.invites).toEqual([]);
  } finally {
    await memberApi.dispose();
    await ownerCopy.dispose();
    await anonymous.dispose();
  }
});
