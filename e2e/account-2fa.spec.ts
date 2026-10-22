import type { APIRequest, APIRequestContext } from "@playwright/test";
import { test, expect, fillWhenReady, open } from "./fixtures/app";
import { simulatedIp } from "./fixtures/accounts";
import { BRAND, createWorkspace, freshAccount } from "./fixtures/workspace";
import { fromBase32, hotp, totpStep } from "../src/lib/totp";

/**
 * Two-step sign-in for a customer (rules 1930-1937: src/app/api/account/2fa, src/app/api/auth/login, src/app/api/auth/login/mfa,
 * src/lib/mfa.ts). The owner turns it on with an authenticator secret (the codes are computed here with src/lib/totp.ts, as a
 * phone would), after which the password alone gets a challenge and no session; a wrong code is refused, a right one signs in,
 * a recovery code signs in once, and turning it off puts password-only sign-in back.
 *
 * Why the code bookkeeping: a code is good for one use (the server burns its 30-second step for the login) and the window is a
 * step either side of now, so a test may rely on two distinct fresh steps (this one and the next) and no more. `Authenticator`
 * hands out those two and refuses a third, so a test that needs more would fail loudly instead of flaking.
 *
 * Limits respected: sign-in is 8 per login per 15 minutes (the code step counts as one; the first journey uses six), so the two journeys use two accounts;
 * each has its own simulated address so neither shares the wrong-code budget (5 per address per 15 minutes).
 * Sign-up journeys run on chromium-desktop only (playwright.config.ts `testIgnore` for mobile-safari lists the spec files that sign up).
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(({ browserName }) => browserName !== "chromium", "signs accounts up; the per-address limits are shared, so one browser engine runs it");

const SEED = "e2e-2fa";

/** The authenticator app on the owner's phone: the shared secret in, six-digit codes out. */
class Authenticator {
  private readonly key: Buffer;
  private readonly used = new Set<number>();
  constructor(secret: string) {
    const key = fromBase32(secret);
    if (!key || key.length === 0) throw new Error(`the server's secret is not base32: ${secret}`);
    this.key = key;
  }
  /** A right code from a step no earlier call used: this step, else the next (always inside the server's window). */
  code(): string {
    const now = totpStep(Date.now());
    for (const step of [now, now + 1]) {
      if (this.used.has(step)) continue;
      this.used.add(step);
      return hotp(this.key, step);
    }
    throw new Error("both fresh steps are spent; a journey may use two right codes");
  }
  /** Six digits from a step far outside the window, so it is wrong whatever the clock does. */
  wrong(): string {
    return hotp(this.key, totpStep(Date.now()) + 50);
  }
}

/** A browser with nothing signed in, as seen from `ip`. */
async function visitor(playwright: { request: APIRequest }, baseURL: string, ip: string): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL, extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9", "x-forwarded-for": ip } });
}

/** Turn two-step sign-in on for the account `api` is signed in to. Returns the authenticator and the eight recovery codes. */
async function enrol(api: APIRequestContext, password: string, ip: string) {
  const headers = { ...BRAND, "x-forwarded-for": ip };
  const start = await api.post("/api/account/2fa", { data: { action: "start", password }, headers });
  expect(start.status(), await start.text()).toBe(200);
  const { secret, uri } = (await start.json()) as { ok: boolean; secret: string; uri: string };
  expect(uri).toContain(`secret=${secret}`);
  const phone = new Authenticator(secret);
  const confirm = await api.post("/api/account/2fa", { data: { action: "confirm", code: phone.code() }, headers });
  expect(confirm.status(), await confirm.text()).toBe(200);
  const { codes } = (await confirm.json()) as { ok: boolean; codes: string[] };
  expect(codes).toHaveLength(8);
  return { phone, codes };
}

test("turning two-step sign-in on makes the password alone a challenge; a wrong code is refused, a right one and a recovery code sign in, turning it off restores the password", async ({ page, playwright, baseURL }) => {
  const owner = freshAccount("2fa-api", "E2E Two Step");
  const ip = simulatedIp(`${SEED}-api`);
  await createWorkspace(page.request, owner, `${SEED}-api`, "E2E Two Step Co");
  const api = page.request;
  const headers = { ...BRAND, "x-forwarded-for": ip };
  const login = (ctx: APIRequestContext, password = owner.password) => ctx.post("/api/auth/login", { data: { email: owner.email, password }, headers: { "x-forwarded-for": ip } });
  const withCode = (ctx: APIRequestContext, code: string) => ctx.post("/api/auth/login/mfa", { data: { code }, headers: { "x-forwarded-for": ip } });
  const created: APIRequestContext[] = [];
  const browserWith = async () => {
    const ctx = await visitor(playwright, baseURL!, ip);
    created.push(ctx);
    return ctx;
  };

  try {
    // Off to begin with, and the owner is told it is recommended.
    const off = await api.get("/api/account/2fa");
    expect(off.status()).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, enabled: false, recoveryLeft: 0, recommended: true });

    // Setup needs the account's own password; a stolen cookie alone cannot enrol a phone.
    const noPassword = await api.post("/api/account/2fa", { data: { action: "start", password: "not-the-password1" }, headers });
    expect(noPassword.status()).toBe(401);
    expect(((await noPassword.json()) as { error: string }).error).toBe("wrong_password");
    // Confirming before a secret exists is refused, and an unknown action is a 400.
    const early = await api.post("/api/account/2fa", { data: { action: "confirm", code: "123456" }, headers });
    expect(early.status()).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe("no_setup");
    expect((await api.post("/api/account/2fa", { data: { action: "explode" }, headers })).status()).toBe(400);

    // Enrol. A wrong code does not turn it on; the right one does and shows the eight recovery codes, once.
    const start = await api.post("/api/account/2fa", { data: { action: "start", password: owner.password }, headers });
    expect(start.status(), await start.text()).toBe(200);
    const phone = new Authenticator(((await start.json()) as { secret: string }).secret);
    const bad = await api.post("/api/account/2fa", { data: { action: "confirm", code: phone.wrong() }, headers });
    expect(bad.status()).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("bad_code");
    const confirm = await api.post("/api/account/2fa", { data: { action: "confirm", code: phone.code() }, headers });
    expect(confirm.status(), await confirm.text()).toBe(200);
    const { codes } = (await confirm.json()) as { codes: string[] };
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size, "the recovery codes are all different").toBe(8);
    const on = await api.get("/api/account/2fa");
    expect(await on.json()).toMatchObject({ ok: true, enabled: true, recoveryLeft: 8 });
    // Starting again while it is on is refused: the secret in use is never replaced by a request.
    const again = await api.post("/api/account/2fa", { data: { action: "start", password: owner.password }, headers });
    expect(again.status()).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("already_on");

    // The code step with no password step before it has no challenge to finish.
    const stray = await browserWith();
    const orphan = await withCode(stray, phone.wrong());
    expect(orphan.status()).toBe(401);
    expect(((await orphan.json()) as { error: string }).error).toBe("mfa_expired");

    // Signed out and back in: the right password gets a challenge and no session.
    const second = await browserWith();
    const pw = await login(second);
    expect(pw.status()).toBe(401);
    expect(await pw.json()).toMatchObject({ ok: false, error: "mfa_required", mfa: true });
    expect((await second.get("/api/account/2fa")).status(), "a password alone is not a session").toBe(401);
    // A wrong code is refused and the challenge stays; the right code signs in.
    const refused = await withCode(second, phone.wrong());
    expect(refused.status()).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("bad_code");
    expect((await second.get("/api/account/2fa")).status(), "a wrong code opens nothing").toBe(401);
    const signedIn = await withCode(second, phone.code());
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    expect(((await signedIn.json()) as { ok: boolean }).ok).toBe(true);
    const mine = await second.get("/api/account/2fa");
    expect(mine.status()).toBe(200);
    expect(await mine.json()).toMatchObject({ ok: true, enabled: true });
    // The challenge was spent by that sign-in: the same request again finds nothing to finish.
    const replay = await withCode(second, phone.wrong());
    expect(replay.status()).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe("mfa_expired");

    // A recovery code stands in for the phone once, and says how many are left.
    const lost = await browserWith();
    expect((await login(lost)).status()).toBe(401);
    const viaRecovery = await withCode(lost, codes[0]);
    expect(viaRecovery.status(), await viaRecovery.text()).toBe(200);
    expect(await viaRecovery.json()).toMatchObject({ ok: true, recoveryLeft: 7 });

    // Turning it off needs the password and a code. A recovery code already spent is a wrong code, and a wrong password stops first.
    const spent = await second.post("/api/account/2fa", { data: { action: "disable", password: owner.password, code: codes[0] }, headers });
    expect(spent.status(), "a recovery code works once").toBe(400);
    expect(await (await second.get("/api/account/2fa")).json()).toMatchObject({ enabled: true });
    const wrongPassword = await second.post("/api/account/2fa", { data: { action: "disable", password: "not-the-password1", code: codes[1] }, headers });
    expect(wrongPassword.status()).toBe(401);
    const off2 = await second.post("/api/account/2fa", { data: { action: "disable", password: owner.password, code: codes[1] }, headers });
    expect(off2.status(), await off2.text()).toBe(200);
    expect(await (await second.get("/api/account/2fa")).json()).toMatchObject({ ok: true, enabled: false, recoveryLeft: 0 });

    // Password-only sign-in is back: a session straight from the password.
    const plain = await browserWith();
    const back = await login(plain);
    expect(back.status(), await back.text()).toBe(200);
    expect(((await back.json()) as { ok: boolean }).ok).toBe(true);
    expect((await plain.get("/api/account/2fa")).status()).toBe(200);
    // Disabling when it is already off is a clean 409, not a 500.
    const nothing = await plain.post("/api/account/2fa", { data: { action: "disable", password: owner.password, code: "123456" }, headers });
    expect(nothing.status()).toBe(409);
    expect(((await nothing.json()) as { error: string }).error).toBe("not_on");
  } finally {
    await Promise.all(created.map((c) => c.dispose()));
  }
});

test("on the log-in page the password step leads to the code step: a wrong code shows its message, the right one opens the app", async ({ browser, playwright, baseURL }) => {
  const owner = freshAccount("2fa-ui", "E2E Two Step UI");
  const ip = simulatedIp(`${SEED}-ui`);
  const setup = await visitor(playwright, baseURL!, ip);
  try {
    // The owner has already turned two-step sign-in on from Settings (covered above); here only the page is under test.
    await createWorkspace(setup, owner, `${SEED}-ui`, "E2E Two Step UI Co");
    const { phone } = await enrol(setup, owner.password, ip);

    // A browser with no session, on the log-in page. (Strings of the code step are local to AuthForm.tsx, not the dictionary.)
    const context = await browser.newContext({ extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9", "x-forwarded-for": ip } });
    const tab = await context.newPage();
    try {
      await open(tab, "/en/app/login");
      await fillWhenReady(tab.getByRole("textbox", { name: "Email" }), owner.email);
      await fillWhenReady(tab.getByRole("textbox", { name: "Password" }), owner.password);
      await tab.getByRole("button", { name: "Log in", exact: true }).click();

      // The code step replaces the form.
      await expect(tab.getByRole("heading", { level: 1 })).toContainText("Sign-in code");
      const code = tab.getByRole("textbox", { name: "Code" });
      await fillWhenReady(code, phone.wrong());
      await tab.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(tab.getByText("That code is wrong or expired. Try the next one.")).toBeVisible();
      await expect(tab.getByRole("heading", { level: 1 }), "a wrong code leaves the code step open").toContainText("Sign-in code");

      // The right code opens the app: the page leaves the log-in route and an authenticated call answers.
      await fillWhenReady(code, phone.code());
      await tab.getByRole("button", { name: "Sign in", exact: true }).click();
      await tab.waitForURL((u) => u.pathname.startsWith("/en/app") && !u.pathname.endsWith("/login"));
      const me = await context.request.get("/api/account/2fa");
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ ok: true, enabled: true });
    } finally {
      await context.close();
    }
  } finally {
    await setup.dispose();
  }
});
