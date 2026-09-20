import { test, expect, open, formAlert } from "./fixtures/app";
import { OWNER, SECOND, signUpOrLogIn } from "./fixtures/accounts";

/**
 * The sign-up / log-in / log-out journeys, signed out. Each flow is covered for the happy path, for invalid input, and
 * for the server refusing.
 *
 * Signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), so exactly ONE test here creates an
 * account; the duplicate-address case reuses the owner created in setup. Against a server that has been up for several
 * runs the throttle can still bite — restart it, or let the `webServer` block boot a fresh one.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const freshEmail = () => `e2e-signup-${Date.now().toString(36)}@test.example`;

test.describe("signup", () => {
  test("a new account reaches the start wizard", async ({ page, failures }) => {
    void failures;
    await open(page, "/en/app/signup");

    await page.getByRole("textbox", { name: "Email" }).fill(freshEmail());
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("textbox", { name: "Your name" }).fill("E2E Signup");
    await page.getByRole("textbox", { name: "Password (8+ characters)" }).fill("signup12345");
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL("**/en/app/start");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Give Noor your website");
  });

  test("an invalid address never leaves the first step", async ({ page }) => {
    await open(page, "/en/app/signup");
    await page.getByRole("textbox", { name: "Email" }).fill("not-an-address");
    await page.getByRole("button", { name: "Continue" }).click();
    // Still on step one: the name field belongs to step two and must not appear.
    await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
  });

  test("the submit button stays disabled until the password meets every rule", async ({ page }) => {
    await open(page, "/en/app/signup");
    await page.getByRole("textbox", { name: "Email" }).fill(freshEmail());
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Your name" }).fill("E2E");

    const submit = page.getByRole("button", { name: "Create account" });
    const password = page.getByRole("textbox", { name: "Password (8+ characters)" });

    await password.fill("short1");
    await expect(submit, "too short").toBeDisabled();
    await password.fill("nodigitshere");
    await expect(submit, "no digit").toBeDisabled();
    await password.fill("12345678");
    await expect(submit, "no letter").toBeDisabled();
    await password.fill("goodpass1");
    await expect(submit, "meets every rule").toBeEnabled();
  });

  test("an address that already has an account is refused with a reason", async ({ page }) => {
    await open(page, "/en/app/signup");
    await page.getByRole("textbox", { name: "Email" }).fill(OWNER.email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Your name" }).fill("Duplicate");
    await page.getByRole("textbox", { name: "Password (8+ characters)" }).fill("another123");
    await page.getByRole("button", { name: "Create account" }).click();

    // 409 already registered, or 429 when the throttle answers first — both must surface a message, not a blank screen.
    await expect(formAlert(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
  });
});

test.describe("login", () => {
  /**
   * Logging in is throttled per account (eight per fifteen minutes, `src/app/api/auth/login/route.ts`). The happy path
   * therefore uses the second account rather than the owner, so one rerun of the suite cannot exhaust either budget.
   */
  test("correct credentials reach the app", async ({ page, request, failures }) => {
    void failures;
    await signUpOrLogIn(request, SECOND);
    await open(page, "/en/app/login");
    await page.getByRole("textbox", { name: "Email" }).fill(SECOND.email);
    await page.getByRole("textbox", { name: "Password" }).fill(SECOND.password);
    await page.getByRole("button", { name: "Log in" }).click();

    // No brand file on this account, so the inbox hands off to the start wizard. That redirect is the proof the
    // session was established.
    await page.waitForURL("**/en/app/start");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Give Noor your website");
  });

  test("a wrong password says so and stays put", async ({ page }) => {
    await open(page, "/en/app/login");
    await page.getByRole("textbox", { name: "Email" }).fill(OWNER.email);
    await page.getByRole("textbox", { name: "Password" }).fill("definitely-wrong");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(formAlert(page)).toHaveText("Wrong email or password.");
    expect(new URL(page.url()).pathname).toBe("/en/app/login");
  });

  test("an unknown address gets the same message as a wrong password", async ({ page }) => {
    await open(page, "/en/app/login");
    await page.getByRole("textbox", { name: "Email" }).fill("nobody-here@test.example");
    await page.getByRole("textbox", { name: "Password" }).fill("whatever123");
    await page.getByRole("button", { name: "Log in" }).click();
    // Identical wording for both cases: the form must not reveal which addresses have accounts.
    await expect(formAlert(page)).toHaveText("Wrong email or password.");
  });

  test("an empty form does not reach the server", async ({ page }) => {
    await open(page, "/en/app/login");
    let posted = false;
    page.on("request", (r) => { if (r.url().includes("/api/auth/login")) posted = true; });
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("textbox", { name: "Email" })).toBeFocused();
    expect(posted, "required fields must stop the submit in the browser").toBe(false);
  });

  test("the signed-in owner is sent away from the login page", async ({ page, browser }) => {
    const signedIn = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
    const authed = await signedIn.newPage();
    await authed.goto("/en/app/login", { waitUntil: "domcontentloaded" });
    expect(new URL(authed.url()).pathname).toBe("/en/app");
    await signedIn.close();
    void page;
  });
});

test.describe("logout", () => {
  test("ends the session and the app is closed again", async ({ browser }) => {
    const signedIn = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
    const authed = await signedIn.newPage();
    await authed.goto("/en/app/profile", { waitUntil: "domcontentloaded" });
    // Log out lives in the sidebar's account menu, which has to be opened first — the trigger is the button showing
    // the signed-in address.
    await authed.getByRole("button").filter({ hasText: OWNER.email }).click();
    await authed.getByRole("button", { name: "Log out" }).click();
    await authed.waitForURL("**/app/login");

    await authed.goto("/en/app", { waitUntil: "domcontentloaded" });
    expect(new URL(authed.url()).pathname, "the session must be dead after logging out").toBe("/en/app/login");
    await signedIn.close();
  });
});

test.describe("forgot password", () => {
  test("answers the same way whether or not the address has an account", async ({ page }) => {
    const message = async (email: string) => {
      await open(page, "/en/app/forgot");
      // The field's accessible name is the page title rather than "Email" (see D15); select it by what it actually
      // announces so the test states the real, defective contract instead of the one we wish existed.
      await page.getByRole("textbox", { name: "Reset your password" }).fill(email);
      await page.getByRole("button", { name: "Send the link" }).click();
      await expect(page.getByText(/link arrives within minutes|Email delivery is not enabled/)).toBeVisible();
      return (await page.locator("main, body").innerText()).includes("Email delivery is not enabled");
    };
    const known = await message(OWNER.email);
    const unknown = await message("nobody-here@test.example");
    expect(known, "the answer must not depend on whether the account exists").toBe(unknown);
  });
});

test.describe("password reset", () => {
  test("a made-up token is refused", async ({ page }) => {
    await open(page, `/en/app/reset?token=${"a".repeat(64)}`);
    await page.getByRole("textbox", { name: /password/i }).fill("brandnew123");
    await page.getByRole("button", { name: "Save and log in" }).click();
    await expect(formAlert(page)).toBeVisible();
  });
});
