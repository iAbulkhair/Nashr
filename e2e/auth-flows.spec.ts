import type { Page } from "@playwright/test";
import { test, expect, open, formAlert, fillWhenReady } from "./fixtures/app";
import { OWNER, SECOND, signUpOrLogIn, simulatedIp } from "./fixtures/accounts";

/**
 * The sign-up / log-in / log-out journeys, signed out. Each flow is covered for the happy path, for invalid input, and
 * for the server refusing.
 *
 * Signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), so exactly ONE test here creates an
 * account; the duplicate-address case reuses the owner created in setup. Against a server that has been up for several
 * runs the throttle can still bite — restart it, or let the `webServer` block boot a fresh one.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Serial, unlike every other spec file. These tests drive the endpoints the application deliberately rate-limits —
 * sign-up, log-in, forgot — and the runner defaults to one worker per core. Sixteen of them racing through those
 * routes makes the suite compete with the product's own limiter and fail on it rather than on a defect. Running this
 * one file in order costs a few seconds and makes the result mean something.
 */
test.describe.configure({ mode: "serial" });

const freshEmail = () => `e2e-signup-${Date.now().toString(36)}@test.example`;

/**
 * Plays the first-login game (src/components/app/DictionaryStart.tsx) from step 1 to step 7, where the site link and
 * the review note live. Steps 1-6 send and save nothing.
 */
async function playToLaunch(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The Thakeen Dictionary");
  await fillWhenReady(page.getByRole("textbox", { name: "What's your brand called?" }), "E2E Roastery");
  await page.getByRole("radio", { name: "Coffee" }).check();
  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.click();
  for (const w of ["Bold", "Warm", "Refined", "Down-to-earth", "Calm"]) await page.getByRole("button", { name: w, exact: true }).click();
  await next.click(); // to the plan
  await next.click(); // to the draft
  await next.click(); // to the approval
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await next.click(); // to the launch step
  await expect(page.getByRole("heading", { level: 2 })).toContainText("7/7");
}

test.describe("signup", () => {
  test.use({ extraHTTPHeaders: { "x-real-ip": simulatedIp("browser-signup") } });

  /**
   * The public start form (`UrlStart` here, `StartForm` on the new homepage: both a plain GET into signup with `?url=`)
   * end to end. The carried site used to start the crawl and the brand build straight after signup, so whoever sent the
   * link chose the new workspace's brand. It now waits on the start page until the owner presses Go (rule 97).
   */
  test("a new account with a carried site lands on the review step and builds only after the owner confirms", async ({ page, failures }) => {
    void failures;
    const onboardCalls: string[] = [];
    page.on("request", (r) => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/onboard")) onboardCalls.push(`${r.method()} ${path}`); });

    await open(page, "/en/agents");
    const startField = page.getByRole("textbox", { name: "Your website or store URL" }).first();
    await startField.fill("roastery.example");
    await startField.press("Enter");
    await page.waitForURL("**/en/app/signup?url=roastery.example");

    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), freshEmail());
    await page.getByRole("button", { name: "Continue" }).click();

    await fillWhenReady(page.getByRole("textbox", { name: "Your name" }), "E2E Signup");
    await fillWhenReady(page.getByRole("textbox", { name: "Password (8+ characters)" }), "signup12345");
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL("**/en/app/start?url=roastery.example");
    await playToLaunch(page);
    await expect(page.getByRole("note")).toContainText("Check this link before Noor starts");
    await expect(page.getByRole("textbox", { name: /Website or store URL/ })).toHaveValue("roastery.example");
    expect(onboardCalls, "signing up with a carried site reads nothing yet").toEqual([]);

    // The press is the confirmation; the build starts only after it, from that exact URL. The e2e server has no model
    // key, so the builder takes its mock path and the run is free.
    const build = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/onboard");
    await page.getByRole("button", { name: "Go, Noor" }).click();
    const req = await build;
    expect(req.postDataJSON()).toEqual({ url: "roastery.example" });
    expect((await req.response())?.status()).toBe(200);
    expect(onboardCalls.slice(0, 2)).toEqual(["POST /api/onboard/confirm", "POST /api/onboard"]);
    // Let the run finish (the thread moves to the plain chat URL on `done`), so the stream is not cut off mid-way.
    await page.waitForURL(/\/en\/app\/chat$/, { timeout: 30_000 });
  });

  test("an invalid address never leaves the first step", async ({ page }) => {
    await open(page, "/en/app/signup");
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), "not-an-address");
    await page.getByRole("button", { name: "Continue" }).click();
    // Still on step one: the name field belongs to step two and must not appear.
    await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
  });

  test("the submit button stays disabled until the password meets every rule", async ({ page }) => {
    await open(page, "/en/app/signup");
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), freshEmail());
    await page.getByRole("button", { name: "Continue" }).click();
    await fillWhenReady(page.getByRole("textbox", { name: "Your name" }), "E2E");

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

  /**
   * Rule 434: the rules are not colour-only. Each item says "met" / "not met" in its text, one live line counts them,
   * and the submit button stays focusable (aria-disabled) and says which rules are unmet when pressed early.
   */
  test("the password rules say met or not met in text, and an early press names the unmet ones", async ({ page }) => {
    await open(page, "/en/app/signup");
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), freshEmail());
    await page.getByRole("button", { name: "Continue" }).click();
    await fillWhenReady(page.getByRole("textbox", { name: "Your name" }), "E2E");
    const password = page.getByRole("textbox", { name: "Password (8+ characters)" });
    await fillWhenReady(password, "abc");

    const items = page.locator("#signup-rules li");
    await expect(items.nth(0)).toContainText("At least 8 characters (not met)");
    await expect(items.nth(1)).toContainText("At least one letter (met)");
    await expect(page.locator("form p[aria-live='polite']")).toHaveText("1 of 3 password rules met");
    const submit = page.getByRole("button", { name: "Create account" });
    await expect(submit).toHaveAttribute("aria-describedby", "signup-rules");
    // Playwright counts aria-disabled="true" as disabled and would wait for "enabled" forever; force skips that wait.
    // The button is still a real, focusable submit, which is the point of the rule.
    await expect(submit).toHaveAttribute("aria-disabled", "true");
    await submit.click({ force: true });
    await expect(formAlert(page)).toHaveText("Your password still needs: At least 8 characters, At least one number.");
    await expect(password, "focus goes back to the password").toBeFocused();

    await password.fill("abcdefg1");
    await expect(page.locator("form p[aria-live='polite']")).toHaveText("3 of 3 password rules met");
    await expect(items.nth(0)).toContainText("(met)");
  });

  test("an address that already has an account is refused with a reason", async ({ page }) => {
    await open(page, "/en/app/signup");
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), OWNER.email);
    await page.getByRole("button", { name: "Continue" }).click();
    await fillWhenReady(page.getByRole("textbox", { name: "Your name" }), "Duplicate");
    await fillWhenReady(page.getByRole("textbox", { name: "Password (8+ characters)" }), "another123");
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
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), SECOND.email);
    await fillWhenReady(page.getByRole("textbox", { name: "Password" }), SECOND.password);
    await page.getByRole("button", { name: "Log in" }).click();

    // No brand file on this account, so the inbox hands off to the first-login game. That redirect is the proof the
    // session was established.
    await page.waitForURL("**/en/app/start");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("The Thakeen Dictionary");
  });

  test("a wrong password says so and stays put", async ({ page }) => {
    await open(page, "/en/app/login");
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), OWNER.email);
    await fillWhenReady(page.getByRole("textbox", { name: "Password" }), "definitely-wrong");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(formAlert(page)).toHaveText("Wrong email or password.");
    expect(new URL(page.url()).pathname).toBe("/en/app/login");
  });

  test("an unknown address gets the same message as a wrong password", async ({ page }) => {
    await open(page, "/en/app/login");
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), "nobody-here@test.example");
    await fillWhenReady(page.getByRole("textbox", { name: "Password" }), "whatever123");
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

test.describe("a shared onboarding link", () => {
  /**
   * Its own fixed account, never given a brand: the owner and SECOND carry other specs' login budgets, and this one
   * only has to be signed in without a workspace. Fixed so a rerun logs in rather than spending a signup.
   */
  const LINKED = { email: "e2e-link@test.example", password: "e2epass123", name: "E2E Link" };

  test("pre-fills the start page for review and cannot start a build", async ({ page, failures }) => {
    void failures;
    await signUpOrLogIn(page.request, LINKED);
    const onboardCalls: string[] = [];
    page.on("request", (r) => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/onboard")) onboardCalls.push(`${r.method()} ${path}`); });

    await open(page, "/en/app/chat?onboard=attacker.example");
    await page.waitForURL("**/en/app/start?url=attacker.example");
    await playToLaunch(page);
    await expect(page.getByRole("note")).toContainText("Check this link before Noor starts");
    await expect(page.getByRole("textbox", { name: /Website or store URL/ })).toHaveValue("attacker.example");
    expect(onboardCalls, "a link reads nothing on its own").toEqual([]);

    // The server says the same without the page: nobody confirmed this URL for this workspace.
    const res = await page.request.post("/api/onboard", { data: { url: "attacker.example" } });
    expect(res.status()).toBe(403);
    expect(await res.text()).toBe("unconfirmed");
  });
});

test.describe("logout", () => {
  /**
   * Uses its own account, never the shared owner. Logging out deletes the session RECORD on the server, so doing it
   * with the owner's saved storage state invalidates the cookie every other spec is using — every app-route test
   * running in parallel is then bounced to the login page. The bug was in this spec, not in the app.
   */
  test("ends the session and the app is closed again", async ({ browser, request }) => {
    const solo = { email: `e2e-logout-${Date.now().toString(36)}@test.example`, password: "logoutpass1", name: "E2E Logout" };
    await signUpOrLogIn(request, solo);
    const state = await request.storageState();
    const signedIn = await browser.newContext();
    await signedIn.addCookies(state.cookies);
    const authed = await signedIn.newPage();
    await authed.goto("/en/app/profile", { waitUntil: "domcontentloaded" });
    // Log out lives in the sidebar's account menu, which has to be opened first — the trigger is the button showing
    // the signed-in address. The profile page has its own Log out card too (rule 750), so the click is scoped to the menu.
    await authed.getByRole("button").filter({ hasText: solo.email }).click();
    await authed.getByRole("menu").getByRole("button", { name: "Log out" }).click();
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
      await fillWhenReady(page.getByRole("textbox", { name: "Reset your password" }), email);
      await page.getByRole("button", { name: "Send the link" }).click();
      // Read the banner itself, not the page: a `main, body` locator matches two elements and dies on strict mode.
      // Either wording is accepted here; the assertion below is that BOTH addresses are answered with the same one.
      const banner = page.getByText(/link arrives within minutes|Email delivery is not enabled/);
      await expect(banner).toBeVisible();
      return (await banner.innerText()).includes("Email delivery is not enabled");
    };
    const known = await message(OWNER.email);
    const unknown = await message("nobody-here@test.example");
    expect(known, "the answer must not depend on whether the account exists").toBe(unknown);
  });
});

/**
 * Rule 433: a failed request never leaves an auth form stuck. These answers are forced with route interception (no
 * request reaches the server, so no throttle budget is used): a rate limit, a dropped connection and a gateway's HTML
 * error page each get their own message, and the button comes back.
 */
test.describe("auth forms survive a failing request", () => {
  test("a login rate limit says so, not 'wrong email or password'", async ({ page }) => {
    await open(page, "/en/app/login");
    await page.route("**/api/auth/login", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ ok: false, error: "slow_down" }) }));
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), OWNER.email);
    await fillWhenReady(page.getByRole("textbox", { name: "Password" }), "whatever123");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(formAlert(page)).toHaveText("Too many attempts. Wait 15 minutes, then try again.");
    await expect(page.getByRole("button", { name: "Log in" })).toBeEnabled();
  });

  test("a dropped connection on login re-enables the button and says it is the connection", async ({ page }) => {
    await open(page, "/en/app/login");
    await page.route("**/api/auth/login", (route) => route.abort("connectionfailed"));
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), OWNER.email);
    await fillWhenReady(page.getByRole("textbox", { name: "Password" }), "whatever123");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(formAlert(page)).toContainText("Couldn't reach the server");
    await expect(page.getByRole("button", { name: "Log in" })).toBeEnabled({ timeout: 15_000 });
  });

  test("a gateway's HTML 502 on signup re-enables the button and blames the server", async ({ page }) => {
    await open(page, "/en/app/signup");
    await page.route("**/api/auth/signup", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }));
    await fillWhenReady(page.getByRole("textbox", { name: "Email" }), freshEmail());
    await page.getByRole("button", { name: "Continue" }).click();
    await fillWhenReady(page.getByRole("textbox", { name: "Your name" }), "E2E");
    await fillWhenReady(page.getByRole("textbox", { name: "Password (8+ characters)" }), "signup12345");
    const submit = page.getByRole("button", { name: "Create account" });
    await submit.click();
    await expect(formAlert(page)).toHaveText("Something went wrong on our side. Please try again shortly.");
    await expect(submit, "the form must not stay wedged after a failure").toBeEnabled({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
  });
});

test.describe("password reset", () => {
  test("the reset rules say met or not met, and an early press names the unmet ones", async ({ page }) => {
    await open(page, `/en/app/reset#t=${"b".repeat(64)}`);
    const password = page.getByRole("textbox", { name: "New password" });
    await fillWhenReady(password, "abc");
    await expect(page.locator("#reset-rules li").nth(0)).toContainText("(not met)");
    const save = page.getByRole("button", { name: "Save and log in" });
    await expect(save).toHaveAttribute("aria-disabled", "true");
    // force: Playwright treats aria-disabled as disabled and would otherwise wait for "enabled" until the timeout.
    await save.click({ force: true });
    await expect(formAlert(page)).toHaveText("Your password still needs: At least 8 characters, At least one number.");
    await password.fill("abcdefg1");
    await expect(page.locator("form p[aria-live='polite']")).toHaveText("3 of 3 password rules met");
  });

  test("a made-up token is refused", async ({ page }) => {
    await open(page, `/en/app/reset#t=${"a".repeat(64)}`);
    await fillWhenReady(page.getByRole("textbox", { name: /password/i }), "brandnew123");
    await page.getByRole("button", { name: "Save and log in" }).click();
    await expect(formAlert(page)).toBeVisible();
  });
});
