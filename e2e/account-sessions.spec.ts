import type { APIRequest, APIRequestContext } from "@playwright/test";
import { test, expect, open } from "./fixtures/app";
import { simulatedIp, type Account } from "./fixtures/accounts";
import { BRAND, createWorkspace, freshAccount, useSession } from "./fixtures/workspace";

/**
 * Sessions and devices (rules 1150, 1170-1171, 1938-1941, 2991: src/app/api/account/sessions/route.ts, src/app/api/account/route.ts
 * PATCH, src/lib/devices.ts). The same login in several browsers (each its own cookie jar, as a second laptop or a phone would
 * be): the Security page and GET /api/account/sessions list them with this one marked, ending ONE device or all the others
 * takes the account's password and makes that browser's next authenticated call a 401, and changing the password ends every
 * other session while keeping this one.
 *
 * Every journey has its own account and its own simulated address: sign-up is five per address per hour and sign-in twenty
 * per address per 15 minutes. Sign-up journeys run on chromium-desktop only.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(({ browserName }) => browserName !== "chromium", "signs accounts up; the per-address limits are shared, so one browser engine runs it");

const SEED = "e2e-sessions";
type Device = { id: string; ua: string; ip: string; at: number; current: boolean };
type Devices = { ok: boolean; devices: Device[] };

/** A browser with a session of its own for `account`, signed in through the log-in route from address `ip`. */
async function signInAnotherBrowser(playwright: { request: APIRequest }, baseURL: string, account: Account, ip: string): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9", "x-forwarded-for": ip } });
  const res = await ctx.post("/api/auth/login", { data: { email: account.email, password: account.password } });
  expect(res.status(), `signing ${account.email} in on another browser: ${await res.text()}`).toBe(200);
  return ctx;
}

async function devicesOf(ctx: APIRequestContext): Promise<Device[]> {
  const res = await ctx.get("/api/account/sessions");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as Devices;
  expect(body.ok).toBe(true);
  return body.devices;
}

/** Does the browser still hold a session? An authenticated read answers 200; a revoked or absent session answers 401. */
const status = async (ctx: APIRequestContext) => (await ctx.get("/api/account/sessions")).status();

test("every browser the login is signed in on is listed with this one marked, and the password ends one device at a time", async ({ page, browser, playwright, baseURL }) => {
  const owner = freshAccount("sessions-owner", "E2E Sessions Owner");
  const stranger = freshAccount("sessions-stranger", "E2E Sessions Stranger");
  const ip = simulatedIp(`${SEED}-revoke`);
  await createWorkspace(page.request, owner, `${SEED}-revoke`, "E2E Sessions Co");
  const first = page.request;
  const browsers: APIRequestContext[] = [];
  try {
    const second = await signInAnotherBrowser(playwright, baseURL!, owner, ip);
    const third = await signInAnotherBrowser(playwright, baseURL!, owner, ip);
    browsers.push(second, third);
    // A second account on its own server-side login, to prove one login's list and revocations never reach another's.
    const strangerApi = await playwright.request.newContext({ baseURL: baseURL! });
    browsers.push(strangerApi);
    await createWorkspace(strangerApi, stranger, `${SEED}-stranger`, "E2E Sessions Stranger Co");

    // The Security page names this browser's session in the list.
    await open(page, "/en/app/settings/security");
    await expect(page.getByText("Devices signed in to your login")).toBeVisible();
    await expect(page.getByText("This device", { exact: true })).toHaveCount(1);

    // Each browser sees the same devices, and exactly one of them is itself. No session secret is in the list.
    const fromSecond = await devicesOf(second);
    expect(fromSecond.length, "sign-up plus two sign-ins").toBeGreaterThanOrEqual(3);
    expect(fromSecond.filter((d) => d.current)).toHaveLength(1);
    for (const d of fromSecond) {
      expect(d.id).toMatch(/^[0-9a-f]{20}$/);
      expect(typeof d.ua).toBe("string");
      expect(typeof d.ip).toBe("string");
      expect(d.at).toBeGreaterThan(0);
    }
    for (const c of (await second.storageState()).cookies) {
      if (c.value.length >= 20) expect(JSON.stringify(fromSecond), `the device list must not carry the ${c.name} cookie`).not.toContain(c.value);
    }
    const mySecond = fromSecond.find((d) => d.current)!;
    const myThird = (await devicesOf(third)).find((d) => d.current)!;
    const myFirst = (await devicesOf(first)).find((d) => d.current)!;
    expect(new Set([mySecond.id, myThird.id, myFirst.id]).size, "three browsers are three devices").toBe(3);
    const strangersDevice = (await devicesOf(strangerApi)).find((d) => d.current)!;

    // Ending a device needs the login's own password. A wrong one is a 401, and nothing happens to the other browser.
    const wrong = await second.delete("/api/account/sessions", { data: { id: myThird.id, password: "not-the-password1" }, headers: BRAND });
    expect(wrong.status()).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("wrong_password");
    expect(await status(third), "a refused request signs nobody out").toBe(200);
    // This device cannot be ended this way (that is signing out), and an unknown id, or another login's device, is a 404.
    const self = await second.delete("/api/account/sessions", { data: { id: mySecond.id, password: owner.password }, headers: BRAND });
    expect(self.status()).toBe(400);
    expect(((await self.json()) as { error: string }).error).toBe("current_device");
    const unknown = await second.delete("/api/account/sessions", { data: { id: "0".repeat(20), password: owner.password }, headers: BRAND });
    expect(unknown.status()).toBe(404);
    const foreign = await second.delete("/api/account/sessions", { data: { id: strangersDevice.id, password: owner.password }, headers: BRAND });
    expect(foreign.status(), "another login's device id is not found, however it is spelled").toBe(404);
    expect(await status(strangerApi), "the stranger is still signed in").toBe(200);

    // The right password ends the third browser: its next authenticated call is a 401; the others carry on.
    const ended = await second.delete("/api/account/sessions", { data: { id: myThird.id, password: owner.password }, headers: BRAND });
    expect(ended.status(), await ended.text()).toBe(200);
    expect(await status(third), "the revoked browser is signed out").toBe(401);
    expect(await status(second)).toBe(200);
    expect(await status(first)).toBe(200);
    expect((await devicesOf(second)).map((d) => d.id)).not.toContain(myThird.id);
    // Ending it again is a clean 404, not a 500.
    const twice = await second.delete("/api/account/sessions", { data: { id: myThird.id, password: owner.password }, headers: BRAND });
    expect(twice.status()).toBe(404);

    // Signed out means signed out of the pages too: the revoked browser's cookies no longer open the app, they land on log in.
    const revokedContext = await browser.newContext();
    try {
      await useSession(revokedContext, third);
      const revokedPage = await revokedContext.newPage();
      await open(revokedPage, "/en/app/settings/security");
      await revokedPage.waitForURL("**/app/login");
      expect(new URL(revokedPage.url()).pathname).toBe("/en/app/login");
    } finally {
      await revokedContext.close();
    }
  } finally {
    await Promise.all(browsers.map((b) => b.dispose()));
  }
});

test("signing out the other devices keeps this one and ends the rest", async ({ page, playwright, baseURL }) => {
  const owner = freshAccount("sessions-others", "E2E Sessions Others");
  const ip = simulatedIp(`${SEED}-others`);
  await createWorkspace(page.request, owner, `${SEED}-others`, "E2E Others Co");
  const first = page.request;
  const browsers: APIRequestContext[] = [];
  try {
    const second = await signInAnotherBrowser(playwright, baseURL!, owner, ip);
    const third = await signInAnotherBrowser(playwright, baseURL!, owner, ip);
    browsers.push(second, third);
    expect(await status(first)).toBe(200);

    // A wrong password signs nobody out.
    const wrong = await second.post("/api/account/sessions", { data: { password: "not-the-password1" }, headers: BRAND });
    expect(wrong.status()).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("wrong_password");
    expect(await status(first)).toBe(200);
    expect(await status(third)).toBe(200);

    // The right password: this browser stays, every other one is signed out.
    const done = await second.post("/api/account/sessions", { data: { password: owner.password }, headers: BRAND });
    expect(done.status(), await done.text()).toBe(200);
    expect(await status(first), "the browser the account was created in is signed out").toBe(401);
    expect(await status(third), "the other sign-in is signed out").toBe(401);
    expect(await status(second), "the browser that asked stays signed in").toBe(200);
    const left = await devicesOf(second);
    expect(left, "only the browser that asked is left in the list").toHaveLength(1);
    expect(left[0].current).toBe(true);

    // The account is not locked: the same password still signs a browser in.
    const again = await signInAnotherBrowser(playwright, baseURL!, owner, ip);
    browsers.push(again);
    expect(await status(again)).toBe(200);
    expect(await devicesOf(again)).toHaveLength(2);
  } finally {
    await Promise.all(browsers.map((b) => b.dispose()));
  }
});

test("changing the password signs the other browsers out, keeps this one, and the old password stops working", async ({ page, playwright, baseURL }) => {
  const owner = freshAccount("sessions-password", "E2E Sessions Password");
  const ip = simulatedIp(`${SEED}-password`);
  const newPassword = "e2eFreshPass456";
  await createWorkspace(page.request, owner, `${SEED}-password`, "E2E Password Co");
  const first = page.request;
  const browsers: APIRequestContext[] = [];
  try {
    const second = await signInAnotherBrowser(playwright, baseURL!, owner, ip);
    browsers.push(second);

    // Refusals first: a weak new password and a wrong current one change nothing and sign nobody out.
    const weak = await second.patch("/api/account", { data: { currentPassword: owner.password, newPassword: "short" }, headers: BRAND });
    expect(weak.status()).toBe(400);
    expect(((await weak.json()) as { error: string }).error).toBe("weak_password");
    const wrong = await second.patch("/api/account", { data: { currentPassword: "not-the-password1", newPassword }, headers: BRAND });
    expect(wrong.status()).toBe(401);
    expect(await status(first)).toBe(200);

    // The change: made from the second browser, so the first one is the "other" device.
    const changed = await second.patch("/api/account", { data: { currentPassword: owner.password, newPassword }, headers: BRAND });
    expect(changed.status(), await changed.text()).toBe(200);
    expect(await status(first), "the other browser is signed out by the password change").toBe(401);
    expect(await status(second), "the browser that changed it stays signed in").toBe(200);

    // The old password is refused, the new one signs in.
    const oldPassword = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { "x-forwarded-for": ip } });
    browsers.push(oldPassword);
    const refused = await oldPassword.post("/api/auth/login", { data: { email: owner.email, password: owner.password } });
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid");
    const fresh = await signInAnotherBrowser(playwright, baseURL!, { ...owner, password: newPassword }, ip);
    browsers.push(fresh);
    expect(await status(fresh)).toBe(200);
  } finally {
    await Promise.all(browsers.map((b) => b.dispose()));
  }
});
