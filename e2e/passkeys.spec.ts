import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import { test, expect, fillWhenReady } from "./fixtures/app";
import { simulatedIp } from "./fixtures/accounts";
import { E2E_ADMIN_KEY } from "./web-server";

/**
 * Customer passkeys in a real browser (rules 2408 and 2429, browser half; rule 2426, the switch's browser half): a
 * Chromium virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`: ctap2, internal transport, resident key, user
 * verification on and passing) adds a passkey in Settings > Security, the account signs out, and signs in again with the
 * "Sign in with a passkey" button and with the address field's autofill (conditional UI). With the console off switch
 * set, the log-in page draws neither, and the Settings card says adding is off.
 *
 * The origin. The server takes the WebAuthn RP ID and the one accepted origin from `appOrigin()` alone (rule 2406), and the
 * e2e server runs without `APP_ORIGIN`, so they are `https://thakeen.com` (the fallback). A browser only runs a ceremony
 * for an RP ID its own origin belongs to, so this spec serves the local build AT `https://thakeen.com`: every request the
 * page makes there is answered by this run's server (`serveAs`), and nothing reaches the real site. The page is then a
 * secure context on the very origin the server expects, its `Secure` cookies are kept, and the cookie `thakeen_pk`
 * travels to `/api/auth/passkey/*` as it does in production. `APP_ORIGIN` is not set for the whole suite instead: the
 * share-card spec needs the canonical https origin in `og:image`.
 *
 * Chromium only (the virtual authenticator is a CDP domain), and only against this run's own server: a deployed preview
 * (`E2E_BASE_URL`) has its own origin and does not hold this run's console key. Serial: the tests build on each other
 * (one account, one authenticator), and the off switch is global, so it is set for as short a time as possible and always
 * put back.
 */

const ORIGIN = "https://thakeen.com";
const IP = simulatedIp("browser-passkeys");
const PASSWORD = "passkey12345";
const NAME = "E2E laptop";

test.skip(({ browserName }) => browserName !== "chromium", "the virtual authenticator is a Chromium DevTools domain");
test.skip(!!process.env.E2E_BASE_URL, "needs this run's own server: its console key and its fallback origin");
test.describe.configure({ mode: "serial" });

/**
 * Answers every request to `ORIGIN` from this run's server. Redirects are not followed here: the browser follows them, so
 * a `Location` the server built from its own host is moved back onto `ORIGIN` first. Every request carries the spec's
 * own client address, so the sign-up and log-in limits count it apart from the other specs.
 *
 * A page load's redirect (the sign-in's full load into `/en/app`, whose 307 adds the workspace, rule 3828) is answered
 * as a page that moves on by itself: Chromium does not route the request a fulfilled redirect starts, so the next hop
 * would reach the real site; a fresh navigation is routed like any other. Its cookies are kept on that page.
 */
async function serveAs(context: BrowserContext, baseURL: string) {
  const local = new URL(baseURL).origin;
  await context.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const headers: Record<string, string> = { ...(await req.allHeaders()), "x-forwarded-for": IP };
    delete headers.host;
    const res = await route.fetch({ url: `${local}${u.pathname}${u.search}`, headers, maxRedirects: 0 });
    const out = res.headers();
    if (out.location) {
      const to = new URL(out.location, local);
      out.location = `${ORIGIN}${to.pathname}${to.search}${to.hash}`;
      if (req.isNavigationRequest() && res.status() >= 300 && res.status() < 400) {
        const { location, ...rest } = out;
        delete rest["content-length"];
        // `Refresh`, not an inline script: the app's CSP (kept with the other headers) refuses an inline script.
        return route.fulfill({ status: 200, headers: { ...rest, "content-type": "text/html; charset=utf-8", refresh: `0;url=${location}` }, body: "<!doctype html>" });
      }
    }
    await route.fulfill({ response: res, headers: out });
  });
}

type Authenticator = { cdp: CDPSession; id: string };

/** A virtual platform authenticator that passes user verification, as Touch ID or Windows Hello would. */
async function addAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}
/**
 * Whether the authenticator answers by itself (`automaticPresenceSimulation`). With it on, the conditional request the log-in
 * form arms on load is answered at once, as if the person had picked the suggestion; off, that request waits.
 */
const presence = (a: Authenticator, enabled: boolean) => a.cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: a.id, enabled });
const credentials = async (a: Authenticator) => (await a.cdp.send("WebAuthn.getCredentials", { authenticatorId: a.id })).credentials;

/** A JSON POST from the page itself, so it is same-origin and carries the page's cookies. */
async function post(page: Page, path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ([p, b]) => {
    const r = await fetch(p as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }, [path, body] as const);
}

/** The console off switch, through the console route with this run's key (owner; no console second factor is enrolled). */
async function setSwitch(page: Page, baseURL: string, on: boolean) {
  const res = await page.request.post(`${new URL(baseURL).origin}/api/admin/passkeys`, {
    headers: { "x-admin-key": E2E_ADMIN_KEY, "x-forwarded-for": IP },
    data: { on, reason: "e2e: passkey browser half" },
  });
  expect(res.status(), await res.text()).toBe(200);
}

const loginPage = (page: Page) => page.goto(`${ORIGIN}/en/app/login`, { waitUntil: "domcontentloaded" });
const passkeyButton = (page: Page) => page.getByRole("button", { name: "Sign in with a passkey" });
/**
 * Signed in: a page of the session's workspace (`MULTI_ORG` on), not merely a hop through `/en/app` on the way to login,
 * and drawn (a hop `serveAs` replays has no `main`), so the next test does not start while the page still moves on.
 */
const signedIn = async (page: Page) => {
  await page.waitForURL((u) => u.origin === ORIGIN && /^\/en\/app\/w\/w_[a-z2-7]{16}\//.test(u.pathname));
  await expect(page.locator("main#main")).toBeVisible();
};
/** The Passkeys card (Settings > Security has other cards with a "Password to confirm" field of their own). */
const card = (page: Page) => page.getByRole("region", { name: "Passkeys" });
const hasSession = async (page: Page) => (await page.context().cookies(ORIGIN)).some((c) => c.name === "thakeen_session");

test.describe("customer passkeys in the browser (rules 2408, 2426, 2429)", () => {
  let page: Page;
  let auth: Authenticator;

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ serviceWorkers: "block", locale: "en-US" });
    await serveAs(context, baseURL!);
    page = await context.newPage();
    auth = await addAuthenticator(page);

    // A fresh, verified account (the test server hands back the emailed code, rule 766).
    await loginPage(page);
    const email = `e2e-passkey-${Date.now().toString(36)}@test.example`;
    const signup = await post(page, "/api/auth/signup", { email, name: "E2E Passkey", password: PASSWORD, lang: "en" });
    expect(signup.status, JSON.stringify(signup.body)).toBe(200);
    const check = await post(page, "/api/auth/verify/check", { code: signup.body.devCode });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
  });
  test.afterAll(async () => {
    await page?.context().unrouteAll({ behavior: "ignoreErrors" });
    await page?.context().close();
  });

  test("Settings > Security: the name is asked before the browser's ceremony, then the passkey is saved", async () => {
    await page.goto(`${ORIGIN}/en/app/settings/security`, { waitUntil: "domcontentloaded" });
    await card(page).getByRole("button", { name: "Add a passkey" }).click();

    // The name comes first, prefilled with the device family, and nothing is on the authenticator yet (rule 2407).
    const name = card(page).getByRole("textbox", { name: "Passkey name" });
    await expect(name).not.toHaveValue("");
    expect(await credentials(auth)).toHaveLength(0);
    await name.fill(NAME);
    await fillWhenReady(card(page).getByLabel("Password to confirm"), PASSWORD);
    await card(page).getByRole("button", { name: "Continue" }).click();

    // A finished save is said as a toast (rule 2001); the row is what stays.
    await expect(card(page).getByRole("list", { name: "Your passkeys" }).getByText(NAME)).toBeVisible();
    await expect(card(page).getByRole("alert")).toHaveCount(0);
    const creds = await credentials(auth);
    expect(creds).toHaveLength(1);
    expect(creds[0].isResidentCredential, "a discoverable credential, so sign-in needs no address").toBe(true);
  });

  test("signed out, the address field's autofill offers the passkey and signing in through it works", async () => {
    expect((await post(page, "/api/auth/logout")).status).toBe(200);
    expect(await hasSession(page)).toBe(false);
    const conditional = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/auth/passkey/options");
    const verify = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/auth/passkey/verify");
    await loginPage(page);
    // `webauthn` in the address field's autocomplete is what lets the browser list passkeys among its suggestions.
    await expect(page.getByRole("textbox", { name: "Email" })).toHaveAttribute("autocomplete", "username webauthn");
    expect(await page.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable?.() ?? false)).toBe(true);
    // The form arms a conditional request on load, with no click; the virtual authenticator, present and verifying,
    // answers it with the one discoverable credential, as picking the suggestion would.
    await conditional;
    // The sign-in cookie `thakeen_pk` (path /api/auth/passkey) rides on the verify request (rule 2408).
    expect((await (await verify).allHeaders()).cookie ?? "").toMatch(/(^|; )thakeen_pk=/);
    await signedIn(page);
    expect(await hasSession(page)).toBe(true);
    expect((await page.context().cookies(`${ORIGIN}/api/auth/passkey/verify`)).some((c) => c.name === "thakeen_pk"), "verify clears the nonce cookie").toBe(false);
  });

  test("signed out, the button signs in with the passkey; the nonce cookie travels and is cleared", async () => {
    expect((await post(page, "/api/auth/logout")).status).toBe(200);
    expect(await hasSession(page)).toBe(false);
    // Presence off while the page loads, so the autofill's conditional request waits instead of signing in first.
    await presence(auth, false);
    try {
      const armed = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/auth/passkey/options");
      await loginPage(page);
      await armed;
      await expect(passkeyButton(page)).toBeVisible();
      // The button's own ceremony asks for fresh options (the waiting autofill is cancelled), then verifies. Presence
      // comes back only after that, so the cancelled autofill cannot answer first and sign in on its own.
      const options = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/auth/passkey/options");
      const verify = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/auth/passkey/verify");
      await passkeyButton(page).click();
      await options;
      await presence(auth, true);
      expect((await (await verify).allHeaders()).cookie ?? "").toMatch(/(^|; )thakeen_pk=/);
    } finally {
      await presence(auth, true);
    }
    await signedIn(page);
    expect(await hasSession(page)).toBe(true);
    expect((await page.context().cookies(`${ORIGIN}/api/auth/passkey/verify`)).some((c) => c.name === "thakeen_pk"), "verify clears the nonce cookie").toBe(false);
  });

  test("in a browser without WebAuthn the card still lists the passkey, says it cannot add one, and has no add button", async () => {
    // A second tab of the same signed-in context, where `PublicKeyCredential` is gone before any page script runs.
    const bare = await page.context().newPage();
    try {
      await bare.addInitScript(() => Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }));
      await bare.goto(`${ORIGIN}/en/app/settings/security`, { waitUntil: "domcontentloaded" });
      await expect(card(bare).getByRole("list", { name: "Your passkeys" }).getByText(NAME)).toBeVisible();
      await expect(card(bare).getByText("This browser cannot add a passkey.", { exact: false })).toBeVisible();
      await expect(card(bare).getByRole("button", { name: "Add a passkey" })).toHaveCount(0);
      await expect(card(bare).getByRole("button", { name: `Rename ${NAME}`, exact: false })).toBeVisible();
    } finally {
      await bare.close();
    }
  });

  test("with the console off switch set, the log-in page draws no button and arms no autofill", async ({ baseURL }) => {
    await setSwitch(page, baseURL!, false);
    try {
      await page.goto(`${ORIGIN}/en/app/settings/security`, { waitUntil: "domcontentloaded" });
      await expect(card(page).getByText("Adding passkeys is turned off for now.", { exact: false })).toBeVisible();
      await expect(card(page).getByRole("list", { name: "Your passkeys" }).getByText(NAME)).toBeVisible();
      await expect(card(page).getByRole("button", { name: "Add a passkey" })).toHaveCount(0);

      expect((await post(page, "/api/auth/logout")).status).toBe(200);
      const calls: string[] = [];
      page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/auth/passkey/")) calls.push(r.url()); });
      await loginPage(page);
      const email = page.getByRole("textbox", { name: "Email" });
      await expect(email).toHaveAttribute("autocomplete", "username");
      await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
      await expect(passkeyButton(page)).toHaveCount(0);
      await email.focus();
      // Long enough for the form to have armed its autofill had passkeys been on (it asks for options straight away).
      await page.waitForTimeout(1500);
      expect(calls, "no passkey request with the switch off").toEqual([]);
      expect(page.url()).toBe(`${ORIGIN}/en/app/login`);
    } finally {
      await setSwitch(page, baseURL!, true);
    }
    // Back on: the button is drawn again. Presence off, so the autofill armed on load waits instead of signing in and
    // leaving the page first.
    await presence(auth, false);
    try {
      await loginPage(page);
      await expect(passkeyButton(page)).toBeVisible();
    } finally {
      await presence(auth, true);
    }
  });
});
