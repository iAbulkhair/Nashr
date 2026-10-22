import { randomBytes } from "node:crypto";
import { test, expect, fillWhenReady, formAlert, open } from "./fixtures/app";
import { signUpVerified, simulatedIp } from "./fixtures/accounts";
import { E2E_RESET } from "./web-server";

/**
 * Forgetting the password, end to end (POST /api/auth/forgot, POST /api/auth/reset, the reset page).
 *
 * The e2e server has no mail (`mailReady()` is false: no RESEND_API_KEY or MAIL_FROM), so the forgot route sends no link and no
 * token is ever created for a request. The links are therefore seeded: `e2eSeed` (e2e/web-server.ts) stores the hashed record
 * the forgot route would have written for three addresses, and this spec signs two of them up first and opens the link as the
 * mail would have. The third address never signs up, so its link has nothing to reset. That is the only thing the seed fakes;
 * the reset itself, the session cut-off and the log-in afterwards are the app's own.
 *
 * Every API call here carries its own simulated client address: the reset route allows 10 attempts per address per 15 minutes
 * and the forgot route 8, and auth-flows.spec.ts spends from the same buckets when it runs from the real one.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SEED = "password-reset";
const OLD = "e2eoldpass123";
const NEW = "brandnewpass456";
const ip = (tag: string) => ({ "x-forwarded-for": simulatedIp(`${SEED}-${tag}`) });
const linkToken = () => randomBytes(32).toString("hex");

test("forgot never says whether an address has an account; a reset link works once, signs the old sessions out and changes the password", async ({ request, playwright, baseURL }) => {
  const { email } = E2E_RESET.api;
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  const oldSession = await playwright.request.newContext({ baseURL: baseURL! });
  const fresh = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    const signup = await signUpVerified(oldSession, { email, name: "E2E Reset Api", password: OLD, lang: "en" }, `${SEED}-api`);
    expect(signup.ok(), await signup.text()).toBe(true);
    expect((await oldSession.get("/api/team")).status(), "the account is signed in before the reset").toBe(200);

    // Forgot: a malformed address is a 400, everything else is the same answer, and with no mail configured it says so.
    for (const bad of ["", "not-an-address", "a@b"]) {
      const res = await anonymous.post("/api/auth/forgot", { data: { email: bad, lang: "en" }, headers: ip("forgot-bad") });
      expect(res.status(), `forgot with "${bad}"`).toBe(400);
      expect((await res.json()).error).toBe("bad_email");
    }
    const known = await anonymous.post("/api/auth/forgot", { data: { email: email.toUpperCase(), lang: "en" }, headers: ip("forgot") });
    const unknown = await anonymous.post("/api/auth/forgot", { data: { email: `nobody-${linkToken().slice(0, 8)}@test.example`, lang: "en" }, headers: ip("forgot") });
    expect(known.status()).toBe(200);
    expect(unknown.status()).toBe(200);
    expect(await known.json(), "the answer must not depend on whether the account exists").toEqual(await unknown.json());
    expect(await known.json()).toEqual({ ok: true, mail: false });

    // Reset, the refusals first. The password is checked before the token, so a weak one never tells whether the link is real.
    const reset = (data: Record<string, unknown>, tag = "reset-refused") => anonymous.post("/api/auth/reset", { data, headers: ip(tag) });
    const weak = await reset({ token: E2E_RESET.api.token, password: "short1" });
    expect(weak.status()).toBe(400);
    expect((await weak.json()).error).toBe("weak_password");
    for (const token of [undefined, "", "abc", "g".repeat(64), "A".repeat(64), "a".repeat(63)]) {
      const res = await reset({ token, password: NEW });
      expect(res.status(), `token ${JSON.stringify(token)}`).toBe(400);
      expect((await res.json()).error).toBe("bad_token");
    }
    const unknownLink = await reset({ token: linkToken(), password: NEW });
    expect(unknownLink.status()).toBe(400);
    expect((await unknownLink.json()).error).toBe("bad_token");
    // The refusals above did not use the real link up: a weak password and a wrong token leave it alone.
    expect((await anonymous.post("/api/auth/login", { data: { email, password: OLD }, headers: ip("login-old-1") })).status()).toBe(200);

    // The real link: the password changes and the same answer signs the browser in.
    const ok = await anonymous.post("/api/auth/reset", { data: { token: E2E_RESET.api.token, password: NEW }, headers: ip("reset-ok") });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect((await anonymous.get("/api/team")).status(), "the reset signs the person in").toBe(200);

    // Every session from before the reset is dead, the old password no longer logs in and the new one does.
    expect((await oldSession.get("/api/team")).status(), "a session made before the reset must stop working").toBe(401);
    const oldLogin = await fresh.post("/api/auth/login", { data: { email, password: OLD }, headers: ip("login-old-2") });
    expect(oldLogin.status()).toBe(401);
    const newLogin = await fresh.post("/api/auth/login", { data: { email, password: NEW }, headers: ip("login-new") });
    expect(newLogin.status(), await newLogin.text()).toBe(200);
    expect((await fresh.get("/api/team")).status()).toBe(200);

    // A link is single use: the same one again, even with a good password, is refused and changes nothing.
    const again = await reset({ token: E2E_RESET.api.token, password: "anotherpass789" }, "reset-again");
    expect(again.status()).toBe(400);
    expect((await again.json()).error).toBe("bad_token");
    const stillNew = await request.post("/api/auth/login", { data: { email, password: NEW }, headers: ip("login-new-2") });
    expect(stillNew.status()).toBe(200);
  } finally {
    await anonymous.dispose();
    await oldSession.dispose();
    await fresh.dispose();
  }
});

test("the reset page takes the link's token out of the address bar, signs the person in and refuses a link with no login behind it", async ({ page, playwright, baseURL }) => {
  const { email } = E2E_RESET.ui;
  const setup = await playwright.request.newContext({ baseURL: baseURL! });
  const check = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    const signup = await signUpVerified(setup, { email, name: "E2E Reset Ui", password: OLD, lang: "en" }, `${SEED}-ui`);
    expect(signup.ok(), await signup.text()).toBe(true);

    // A link whose address never signed up: the page says it is invalid and points to a new request.
    await open(page, `/en/app/reset#t=${E2E_RESET.ghost.token}`);
    const password = page.getByRole("textbox", { name: "New password" });
    await fillWhenReady(password, NEW);
    await page.getByRole("button", { name: "Save and log in" }).click();
    await expect(formAlert(page)).toContainText("This link is invalid or expired. Request a new one.");
    await expect(formAlert(page).getByRole("link", { name: "Reset your password" })).toHaveAttribute("href", "/en/app/forgot");

    // The real link. The token rides in the fragment and is removed from the address bar once the page has read it (rule 546).
    // The page is already on /en/app/reset: a change of fragment alone is not a page load, so leave it first.
    await page.goto("about:blank");
    await open(page, `/en/app/reset#t=${E2E_RESET.ui.token}`);
    await expect.poll(() => new URL(page.url()).hash, { message: "the token must not stay in the address bar" }).toBe("");
    expect(page.url()).not.toContain(E2E_RESET.ui.token);
    await fillWhenReady(page.getByRole("textbox", { name: "New password" }), NEW);
    const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/reset" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save and log in" }).click();
    const res = await posted;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ token: E2E_RESET.ui.token, password: NEW });
    await page.waitForURL((u) => u.pathname.startsWith("/en/app") && !u.pathname.endsWith("/reset"));
    expect((await page.request.get("/api/team")).status(), "the page is signed in with the new password").toBe(200);

    // The old password is gone, the new one works.
    expect((await check.post("/api/auth/login", { data: { email, password: OLD }, headers: ip("ui-login-old") })).status()).toBe(401);
    expect((await check.post("/api/auth/login", { data: { email, password: NEW }, headers: ip("ui-login-new") })).status()).toBe(200);

    // The link has been used: opening it again shows the same refusal.
    const second = await page.context().browser()!.newContext({ baseURL: baseURL! });
    try {
      const other = await second.newPage();
      await other.goto(`/en/app/reset#t=${E2E_RESET.ui.token}`, { waitUntil: "domcontentloaded" });
      await fillWhenReady(other.getByRole("textbox", { name: "New password" }), "anotherpass789");
      await other.getByRole("button", { name: "Save and log in" }).click();
      await expect(formAlert(other)).toContainText("This link is invalid or expired.");
    } finally {
      await second.close();
    }
  } finally {
    await setup.dispose();
    await check.dispose();
  }
});
