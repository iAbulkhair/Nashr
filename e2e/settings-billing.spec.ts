import { test, expect, open } from "./fixtures/app";
import { appDict } from "../src/lib/app-i18n";
import { BRAND, createWorkspace, freshAccount, inviteMember, joinAs, useSession } from "./fixtures/workspace";

/**
 * Settings and billing (src/app/api/profile/route.ts, src/app/api/billing/{checkout,status}/route.ts, the Account settings
 * cards and the Subscription page).
 *
 * Profile: the owner's mobile number is required by the account, so a name-only save is refused until a valid number is on
 * the record, and every refusal leaves the record as it was. Billing: only the owner pays and reads billing state; a member
 * gets a 403 on both routes and a read-only note on the page. The e2e server has no payment provider keys, so payments are
 * off: checkout is a clean 404 `not_enabled` (never a 500) and the status route says `enabled: false`.
 *
 * Every journey has its own account and its own simulated address (five sign-ups per address per hour). Sign-up journeys run
 * on chromium-desktop only.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(({ browserName }) => browserName !== "chromium", "signs accounts up; the per-address limits are shared, so one browser engine runs it");

const SEED = "e2e-settings";
const T = appDict.en.billing;
type Refusal = { ok?: boolean; error?: string; field?: string };

test("the profile API refuses a bad save without changing anything, and a valid phone then a name persist", async ({ page }) => {
  const owner = freshAccount("settings-api", "E2E Settings Api");
  const api = page.request;
  await createWorkspace(api, owner, `${SEED}-api`, "E2E Settings Co");
  const put = (data: Record<string, unknown>) => api.put("/api/profile", { data, headers: BRAND });
  const read = async () => (await (await api.get("/api/profile", { headers: BRAND })).json()) as { ok: boolean; me: { name: string; email: string }; user?: { phone?: string } };

  // Signed out: a 401 for the read and the write alike.
  const anon = await page.context().browser()!.newContext();
  try {
    expect((await anon.request.get("/api/profile")).status()).toBe(401);
    expect((await anon.request.put("/api/profile", { data: { name: "Nobody" } })).status()).toBe(401);
  } finally {
    await anon.close();
  }

  const before = await read();
  expect(before.ok).toBe(true);
  expect(before.me.name).toBe(owner.name);
  expect(before.user?.phone ?? "").toBe("");

  // The account's phone is required: a name-only save is refused while none is on the record.
  const nameOnly = await put({ name: "E2E Settings Renamed" });
  expect(nameOnly.status()).toBe(400);
  expect(((await nameOnly.json()) as Refusal)).toMatchObject({ error: "required", field: "phone" });
  // An empty phone, a short one, an empty name and a request that carries the login address are each refused by name.
  const empty = await put({ phone: "" });
  expect(empty.status()).toBe(400);
  expect(((await empty.json()) as Refusal)).toMatchObject({ error: "required", field: "phone" });
  const short = await put({ phone: "12345" });
  expect(short.status()).toBe(400);
  expect(((await short.json()) as Refusal)).toMatchObject({ error: "bad_phone", field: "phone" });
  const noName = await put({ name: "   ", phone: "0501234567" });
  expect(noName.status()).toBe(400);
  expect(((await noName.json()) as Refusal)).toMatchObject({ error: "required", field: "name" });
  const email = await put({ email: "someone-else@test.example", phone: "0501234567" });
  expect(email.status()).toBe(400);
  expect(((await email.json()) as Refusal)).toMatchObject({ error: "read_only", field: "email" });
  // Every refusal left the record as it was: same name, same address, still no phone.
  const unchanged = await read();
  expect(unchanged.me).toEqual(before.me);
  expect(unchanged.user?.phone ?? "").toBe("");

  // A valid phone is saved; then the name can be, and both are what the next read returns.
  const phone = await put({ phone: "0501234567" });
  expect(phone.status(), await phone.text()).toBe(200);
  const renamed = await put({ name: "E2E Settings Renamed" });
  expect(renamed.status(), await renamed.text()).toBe(200);
  const after = await read();
  expect(after.me.name).toBe("E2E Settings Renamed");
  expect(after.me.email).toBe(owner.email);
  expect(after.user?.phone).toBe("0501234567");
});

test("the Account settings page checks the number as typed, saves it and then the name, and both are there after a reload", async ({ page }) => {
  const owner = freshAccount("settings-ui", "E2E Settings Ui");
  await createWorkspace(page.request, owner, `${SEED}-ui`, "E2E Settings Ui Co");
  await open(page, "/en/app/settings/account");

  // A new account has no phone yet: the page says so, and names the card that needs it.
  await expect(page.getByText("Add your mobile number: saving any other card here needs it.")).toBeVisible();
  const phoneCard = page.getByRole("form", { name: "Mobile number" });
  const phoneInput = phoneCard.getByRole("textbox", { name: "Mobile number" });
  const phoneSave = phoneCard.getByRole("button", { name: "Save" });
  await expect(phoneSave).toHaveAttribute("aria-disabled", "true");

  // Too short: the card says why, and Save stays unavailable.
  await phoneInput.fill("12345");
  await expect(phoneCard.getByText("Use at least 9 digits.")).toBeVisible();
  await expect(phoneSave).toHaveAttribute("aria-disabled", "true");

  // A valid number: Save is available, the save answers once, and the callout goes away.
  await phoneInput.fill("0501234567");
  await expect(phoneSave).not.toHaveAttribute("aria-disabled", "true");
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/profile" && r.request().method() === "PUT");
  await phoneSave.click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await expect(page.getByText("Add your mobile number: saving any other card here needs it.")).toHaveCount(0);

  // The name is saved the same way, now that the account has a number.
  const nameCard = page.getByRole("form", { name: "Full name" });
  const nameInput = nameCard.getByRole("textbox", { name: "Full name" });
  await expect(nameInput).toHaveValue(owner.name);
  await nameInput.fill("E2E Settings Renamed");
  const renamed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/profile" && r.request().method() === "PUT");
  await nameCard.getByRole("button", { name: "Save" }).click();
  expect((await renamed).status()).toBe(200);

  // After a reload both come from the server, not from the form's memory.
  await open(page, "/en/app/settings/account");
  await expect(page.getByRole("form", { name: "Full name" }).getByRole("textbox", { name: "Full name" })).toHaveValue("E2E Settings Renamed");
  await expect(page.getByRole("form", { name: "Mobile number" }).getByRole("textbox", { name: "Mobile number" })).toHaveValue("0501234567");
  await expect(page.getByText("Add your mobile number: saving any other card here needs it.")).toHaveCount(0);
});

test("only the owner reaches billing: payments are off here, so checkout is a clean refusal, and a member is turned away", async ({ page, browser, playwright, baseURL }) => {
  const owner = freshAccount("settings-billing", "E2E Billing Owner");
  const member = freshAccount("settings-billing-member", "E2E Billing Member");
  const api = page.request;
  await createWorkspace(api, owner, `${SEED}-billing`, "E2E Billing Co");
  const token = await inviteMember(api, member.email, "member", `${SEED}-billing-invite`);
  const memberApi = await joinAs(playwright, baseURL!, token, member, `${SEED}-billing-member`);
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  const memberContext = await browser.newContext();
  try {
    const checkout = (r: typeof api) => r.post("/api/billing/checkout", { data: { kind: "plan", plan: "starter" }, headers: BRAND });

    // Signed out: both routes answer 401 and nothing more.
    expect((await checkout(anon)).status()).toBe(401);
    expect((await anon.get("/api/billing/status")).status()).toBe(401);

    // A member is refused on both, by role, before payments are even considered.
    const memberCheckout = await checkout(memberApi);
    expect(memberCheckout.status(), await memberCheckout.text()).toBe(403);
    const memberStatus = await memberApi.get("/api/billing/status", { headers: BRAND });
    expect(memberStatus.status(), await memberStatus.text()).toBe(403);
    // Nor can a member set the account's phone through the profile route.
    const memberPhone = await memberApi.put("/api/profile", { data: { phone: "0509999999" }, headers: BRAND });
    expect(memberPhone.status()).toBe(403);

    // The owner: with payments off the status says so and checkout is a 404 `not_enabled`, never a 500 and never a link.
    const status = await api.get("/api/billing/status", { headers: BRAND });
    expect(status.status(), await status.text()).toBe(200);
    expect(await status.json()).toMatchObject({ ok: true, enabled: false });
    const ownerCheckout = await checkout(api);
    expect(ownerCheckout.status(), await ownerCheckout.text()).toBe(404);
    expect(((await ownerCheckout.json()) as { error: string }).error).toBe("not_enabled");

    // The Subscription page for the owner: the summary of a trial account, and no read-only note.
    await open(page, "/en/app/settings/billing");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(T.title);
    const summary = page.locator("dl[data-billing-summary]");
    await expect(summary.getByText(T.current, { exact: true })).toBeVisible();
    await expect(summary.getByText(T.plans.trial, { exact: true })).toBeVisible();
    await expect(summary.getByText(T.credits, { exact: true })).toBeVisible();
    await expect(summary.getByText(T.seats, { exact: true })).toBeVisible();
    await expect(summary.getByText(/^\d+ \/ \d+$/)).toBeVisible();
    await expect(page.getByText(T.ownerOnly)).toHaveCount(0);

    // The same page for the member: the same summary, with the note that the owner manages the subscription.
    await useSession(memberContext, memberApi);
    const memberPage = await memberContext.newPage();
    await open(memberPage, "/en/app/settings/billing");
    await expect(memberPage.getByRole("heading", { level: 1 })).toContainText(T.title);
    await expect(memberPage.getByText(T.ownerOnly)).toBeVisible();
  } finally {
    await memberContext.close();
    await Promise.all([memberApi.dispose(), anon.dispose()]);
  }
});
