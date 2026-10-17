import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, signIn, signOut, withHeaders } from "./helpers/session";
import { createSession, currentUser, sessionKey, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { devicesKey, deviceId } from "@/lib/devices";
import { deviceLabel, deviceName } from "@/lib/device-label";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as sessionsRoute from "@/app/api/account/sessions/route";

/** The device list with per-session sign-out (rules 1938-1941, docs/system/tests/1930-account-security.md). */
const read = (f: string) => readFileSync(f, "utf8");
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
let ipN = 0;
/** Sign in through the real login route from a browser with this user agent and address; returns the cookie token. */
async function loginFrom(email: string, ua: string, password = "abc12345"): Promise<string> {
  const addr = `203.0.113.${(++ipN % 250) + 1}`;
  const r = await withHeaders({ "user-agent": ua, "x-forwarded-for": addr }, () => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": addr })));
  expect(r.status).toBe(200);
  return jar().get("thakeen_session")!;
}
const use = (token: string) => jar().set("thakeen_session", token);
type Dev = { id: string; ua: string; ip: string; at: number; current: boolean };
const list = async (): Promise<Dev[]> => (await (await sessionsRoute.GET()).json()).devices;
const end = (id: string, password = "abc12345") => sessionsRoute.DELETE(json("/api/account/sessions", "DELETE", { id, password }));
afterEach(() => { signOut(); vi.unstubAllEnvs(); });

describe("rule 1938: each sign-in indexes its session under the login, with browser, address and time", () => {
  it("two devices are listed, newest first, this one marked", async () => {
    const u = await newUser("dev");
    const a = await loginFrom(u.email, CHROME_WIN);
    await new Promise((r) => setTimeout(r, 3));
    const b = await loginFrom(u.email, SAFARI_IPHONE);
    use(b);
    const devs = await list();
    expect(devs).toHaveLength(2);
    expect(devs[0]).toMatchObject({ ua: SAFARI_IPHONE, current: true });
    expect(devs[1]).toMatchObject({ ua: CHROME_WIN, current: false });
    expect(devs[1].ip).toMatch(/^203\.0\.113\./);
    // The index keeps the hashed session key only: the raw token is in the cookie and nowhere else.
    const raw = JSON.stringify(await db.hgetall(devicesKey(u.email)));
    expect(raw).not.toContain(a);
    expect(raw).toContain(sessionKey(a));
  });

  it("a founder's impersonation session is never listed", async () => {
    const u = await newUser("dev");
    await withHeaders({ "user-agent": CHROME_WIN }, () => createSession(u.email, 600, { imp: "founder@test.example" }));
    expect(await db.hgetall(devicesKey(u.email))).toEqual({});
  });

  it("signing out on a device removes its entry", async () => {
    const u = await newUser("dev");
    const a = await loginFrom(u.email, CHROME_WIN);
    expect(Object.keys(await db.hgetall(devicesKey(u.email)))).toEqual([deviceId(sessionKey(a))]);
    await logoutRoute.POST();
    expect(await db.hgetall(devicesKey(u.email))).toEqual({});
  });
});

describe("rule 1939: one other device can be signed out with the password; this one cannot", () => {
  it("ends the chosen session only", async () => {
    const u = await newUser("dev");
    const a = await loginFrom(u.email, CHROME_WIN);
    const b = await loginFrom(u.email, SAFARI_IPHONE);
    const c = await loginFrom(u.email, CHROME_WIN);
    use(c);
    const target = (await list()).find((d) => d.id === deviceId(sessionKey(a)))!;
    expect((await end(target.id, "wrong-pass")).status).toBe(401);
    expect((await end(target.id)).status).toBe(200);
    expect(await sessionRecord(a)).toBeNull();
    expect(await sessionRecord(b)).toBeTruthy();
    expect((await list()).map((d) => d.id)).not.toContain(target.id);
    use(a);
    expect(await currentUser()).toBeNull();
    use(b);
    expect((await currentUser())?.email).toBe(u.email);
  });

  it("the current device answers current_device", async () => {
    const u = await newUser("dev");
    const a = await loginFrom(u.email, CHROME_WIN);
    use(a);
    const r = await end(deviceId(sessionKey(a)));
    expect(r.status).toBe(400);
    expect(await sessionRecord(a)).toBeTruthy();
  });
});

describe("rule 1940: nobody can list or end another login's devices", () => {
  it("an id from another login's list is not found, and that session holds", async () => {
    const victim = await newUser("dev");
    const v = await loginFrom(victim.email, CHROME_WIN);
    const attacker = await newUser("dev");
    const x = await loginFrom(attacker.email, SAFARI_IPHONE);
    use(x);
    expect((await list()).map((d) => d.ua)).toEqual([SAFARI_IPHONE]);
    expect((await end(deviceId(sessionKey(v)))).status).toBe(404);
    expect(await sessionRecord(v)).toBeTruthy();
  });

  it("a member's list holds the member's sessions only, never the owner's", async () => {
    const owner = await newUser("dev");
    await loginFrom(owner.email, CHROME_WIN);
    const m = await newMember(owner);
    const t = await loginFrom(m.email, SAFARI_IPHONE, m.password);
    use(t);
    const devs = await list();
    expect(devs).toHaveLength(1);
    expect(devs[0]).toMatchObject({ ua: SAFARI_IPHONE, current: true });
  });

  it("the session key comes from the stored entry, never from the request; a founder may not end one", async () => {
    const src = read("src/lib/devices.ts");
    expect(src).toMatch(/db\.del\(e\.k\)/);
    expect(src).not.toMatch(/x-forwarded-for/i);
    const route = read("src/app/api/account/sessions/route.ts");
    expect(route).toMatch(/export async function DELETE[\s\S]*forbid\(u, "sessions\.revoke"\)/);
    vi.stubEnv("ADMIN_EMAILS", "founder-dev@test.example");
    const u = await newUser("dev");
    await signIn(u.email, { imp: "founder-dev@test.example" });
    expect((await end("0".repeat(20))).status).toBe(403);
  });
});

describe("rule 1941: revoked sessions leave the list, and the list names browsers in both languages", () => {
  it("sign out other devices empties the list but this device", async () => {
    const u = await newUser("dev");
    await loginFrom(u.email, CHROME_WIN);
    await loginFrom(u.email, SAFARI_IPHONE);
    await new Promise((r) => setTimeout(r, 3));
    const r = await sessionsRoute.POST(json("/api/account/sessions", "POST", { password: "abc12345" }));
    expect(r.status).toBe(200);
    const devs = await list();
    expect(devs).toHaveLength(1);
    expect(devs[0].current).toBe(true);
  });

  it("deviceLabel", () => {
    expect(deviceLabel(CHROME_WIN)).toMatchObject({ browser: "Chrome", system: "Windows", mobile: false });
    expect(deviceLabel(SAFARI_IPHONE)).toMatchObject({ browser: "Safari", system: "iPhone", mobile: true });
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36 Edg/141.0").browser).toBe("Edge");
    expect(deviceName(SAFARI_IPHONE, "ar")).toBe("Safari على iPhone");
    expect(deviceName("", "en")).toBe("Browser");
  });

  it("the settings page lists the devices instead of saying the list is not available", () => {
    const ui = read("src/components/app/settings/SecuritySettings.tsx");
    expect(ui).not.toContain("not available yet");
    expect(ui).toContain("<DeviceList ");
    expect(ui).toContain("<TwoStepSettings ");
  });
});
