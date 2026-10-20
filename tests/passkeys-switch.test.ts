import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { codeAt, enrolledStaff } from "./helpers/staff";
import { enrolPasskeys, passkeyResidue, passkeySignIn, PASSKEY_ORIGIN } from "./helpers/passkeys";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { ENROLMENT_KEY, sealSecret, type Enrolment } from "@/lib/admin-2fa";
import { newRecoveryCode, newTotpSecret, recoveryHash } from "@/lib/totp";
import { passkeysOn, setPasskeysOn } from "@/lib/passkey-switch";
import { staffMay, STAFF_MAY } from "@/lib/roles";
import { PasskeysSwitch, PASSKEYS_SWITCH_COPY } from "@/components/admin/IntegrationsPanel";
import * as route from "@/app/api/admin/passkeys/route";
import * as optionsRoute from "@/app/api/auth/passkey/options/route";
import * as verifyRoute from "@/app/api/auth/passkey/verify/route";
import * as manageRoute from "@/app/api/account/passkeys/route";

/**
 * Customer passkeys, task 7: the console off switch (spec docs/specs/2026-10-20-passkeys.md flow E, rule 2426 console
 * half). GET and POST /api/admin/passkeys: a console actor (401), the `passkeys.switch` permission (owner only, 403), the
 * second factor, a reason, then `passkeys:off` written or deleted and one audit row in section `system`. Stored
 * passkeys are never touched: with the switch off sign-in and adding answer 404 `unavailable`, list, rename and remove
 * keep working, and once it is on again the same passkey signs in.
 */

const KEY = "passkeys-switch-admin-key-0123456789";
const asKey = { "x-admin-key": KEY };
const REASON = "WebAuthn library defect";
const PASSWORD = "abc12345";
const UNAVAILABLE = { status: 404, body: { ok: false, error: "unavailable" } };

type Row = { section?: string; action?: string; target?: string; actor?: string; via?: string; what?: string; before?: unknown; after?: unknown; reason?: string };
const logRows = async (): Promise<Row[]> => (await db.lrange("admin:log", 0, 200)).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as Row);
const switchRows = async () => (await logRows()).filter((r) => r.target === "passkeys");

const answer = async (r: Response) => ({ status: r.status, body: await r.json() });
const read = (headers: Record<string, string> = asKey) => route.GET(json("/api/admin/passkeys", "GET", undefined, headers));
const flip = (body: unknown, headers: Record<string, string> = asKey) => route.POST(json("/api/admin/passkeys", "POST", body, headers));
const stored = () => db.get(globalKey.passkeysOff());
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });

/** Every passkey key of `pid` with its stored value, to prove a flip leaves them byte for byte. */
async function snapshot(pid: Parameters<typeof passkeyResidue>[0]): Promise<Record<string, string>> {
  const keys = passkeyResidue(pid);
  const values = await Promise.all(keys.map((k) => db.get(k)));
  return Object.fromEntries(keys.map((k, i) => [k, JSON.stringify(values[i])]));
}

/** The founder's console second factor, enrolled as POST /api/admin/2fa `confirm` stores it (pre-flight ruling 18). */
async function enrolConsoleSecondFactor(): Promise<string> {
  const secret = newTotpSecret();
  await db.set(ENROLMENT_KEY, { enc: sealSecret(secret), rc: recoveryHash(newRecoveryCode()), at: new Date().toISOString(), by: "key" } satisfies Enrolment);
  return secret;
}

beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "passkeys-switch-connect-secret"); });
beforeEach(async () => {
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  vi.stubEnv("APP_ORIGIN", PASSKEY_ORIGIN);
  // Each test reads only its own audit rows.
  await db.del("admin:log");
});
afterEach(async () => {
  signOut();
  await Promise.all([db.del(ENROLMENT_KEY), setPasskeysOn(true)]);
});

describe("rule 2426 (console half): only the console owner flips the switch", () => {
  it("STAFF_MAY: passkeys.switch is owner only, and fails closed", () => {
    expect(STAFF_MAY["passkeys.switch"]).toEqual(["owner"]);
    expect(staffMay("owner", "passkeys.switch")).toBe(true);
    for (const r of ["support", null, undefined, "", "Owner", "ghost", 1]) expect(staffMay(r, "passkeys.switch"), String(r)).toBe(false);
  });

  it("signed out: GET and POST answer 401 and nothing is written", async () => {
    expect((await read({})).status).toBe(401);
    expect((await flip({ on: false, reason: REASON }, {})).status).toBe(401);
    expect(await stored()).toBeNull();
    expect(await switchRows()).toEqual([]);
  });

  it("a support staff session gets 403 forbidden; nothing is written", async () => {
    const { staff } = await enrolledStaff({ role: "support" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    expect(await answer(await flip({ on: false, reason: REASON }, {}))).toEqual({ status: 403, body: { ok: false, error: "forbidden" } });
    expect(await stored()).toBeNull();
    expect(await switchRows()).toEqual([]);
  });

  it("an owner staff session without its step-up gets the second-factor answer", async () => {
    const { staff } = await enrolledStaff({ role: "owner" });
    const { openStaffSession } = await import("@/lib/staff-session");
    await openStaffSession(staff.email);
    expect(await answer(await flip({ on: false, reason: REASON }, {}))).toEqual({ status: 403, body: { ok: false, error: "second_factor" } });
    expect(await stored()).toBeNull();
  });

  it("with a founder second factor enrolled, no step-up is 403 second_factor; a right code goes through", async () => {
    const secret = await enrolConsoleSecondFactor();
    expect(await answer(await flip({ on: false, reason: REASON }, { ...asKey, ...ip() }))).toEqual({ status: 403, body: { ok: false, error: "second_factor" } });
    expect(await stored()).toBeNull();
    expect(await switchRows()).toEqual([]);
    const ok = await flip({ on: false, reason: REASON }, { ...asKey, ...ip(), "x-admin-otp": codeAt(secret) });
    expect(await answer(ok)).toEqual({ status: 200, body: { ok: true, on: false } });
    expect(String(await stored())).toBe("1");
  });

  it("an empty, short or missing reason is 400 and nothing is written", async () => {
    expect(await answer(await flip({ on: false, reason: "" }))).toEqual({ status: 400, body: { ok: false, error: "reason_short" } });
    expect(await answer(await flip({ on: false }))).toEqual({ status: 400, body: { ok: false, error: "reason_short" } });
    expect(await answer(await flip({ on: false, reason: "x".repeat(201) }))).toEqual({ status: 400, body: { ok: false, error: "reason_long" } });
    expect(await stored()).toBeNull();
    expect(await switchRows()).toEqual([]);
  });

  it("`on` must be a boolean: 400 bad_request, nothing written", async () => {
    for (const on of [undefined, "false", 0, null, "1"]) {
      expect(await answer(await flip({ on, reason: REASON })), String(on)).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    }
    expect(await stored()).toBeNull();
    expect(await switchRows()).toEqual([]);
  });

  it("GET reads the switch, default on (fail-open by design), and writes no audit row", async () => {
    expect(await answer(await read())).toEqual({ status: 200, body: { ok: true, on: true } });
    await setPasskeysOn(false);
    expect(await answer(await read())).toEqual({ status: 200, body: { ok: true, on: false } });
    expect((await read()).headers.get("cache-control")).toBe("no-store");
    expect(await switchRows()).toEqual([]);
  });

  it("off writes passkeys:off = \"1\" and one admin:log row in section system; on deletes the key and logs again", async () => {
    expect(await answer(await flip({ on: false, reason: REASON }))).toEqual({ status: 200, body: { ok: true, on: false } });
    expect(String(await stored())).toBe("1");
    expect(await passkeysOn()).toBe(false);
    let rows = await switchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ section: "system", action: "passkeys.off", target: "passkeys", actor: "key", via: "header", before: { on: true }, after: { on: false }, reason: REASON });
    expect(typeof rows[0].what).toBe("string");

    expect(await answer(await flip({ on: true, reason: REASON }))).toEqual({ status: 200, body: { ok: true, on: true } });
    expect(await stored()).toBeNull();
    expect(await passkeysOn()).toBe(true);
    rows = await switchRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ section: "system", action: "passkeys.on", target: "passkeys", before: { on: false }, after: { on: true }, reason: REASON });
  });
});

describe("rule 2426: the switch never touches stored passkeys", () => {
  it("off: sign-in and adding answer 404, the set still lists, renames and removes; on: the same passkey signs in", async () => {
    const u = await newUser("pksw");
    const e = await enrolPasskeys(u.email, { count: 2, reg: false });
    expect((await passkeySignIn(e.softs[0], e.uid, 1)).status).toBe(200);
    signOut();
    const before = await snapshot(e.pid);
    expect(Object.keys(before).length).toBe(3);

    expect((await flip({ on: false, reason: REASON })).status).toBe(200);
    expect(await snapshot(e.pid)).toEqual(before);

    // Task 5's sign-in routes.
    expect(await answer(await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, ip())))).toEqual(UNAVAILABLE);
    expect(await answer(await verifyRoute.POST(json("/api/auth/passkey/verify", "POST", { response: {} }, ip())))).toEqual(UNAVAILABLE);
    // Task 4's register steps; GET, rename and remove keep working.
    await signIn(u.email);
    const manage = (body: unknown) => manageRoute.POST(json("/api/account/passkeys", "POST", body, ip()));
    expect(await answer(await manage({ action: "register-options", password: PASSWORD }))).toEqual(UNAVAILABLE);
    expect(await answer(await manage({ action: "register-verify", response: {}, name: "New" }))).toEqual(UNAVAILABLE);
    const listed = await answer(await manageRoute.GET());
    expect(listed.body).toMatchObject({ ok: true, enabled: false });
    expect(listed.body.items).toHaveLength(2);
    const [first, second] = listed.body.items as { ref: string; name: string }[];
    expect((await manage({ action: "rename", ref: first.ref, name: "Renamed while off" })).status).toBe(200);
    expect((await manage({ action: "remove", ref: second.ref, password: PASSWORD })).status).toBe(200);
    const after = await answer(await manageRoute.GET());
    expect(after.body.items.map((i: { name: string }) => i.name)).toEqual(["Renamed while off"]);
    signOut();

    const kept = await snapshot(e.pid);
    expect((await flip({ on: true, reason: REASON })).status).toBe(200);
    expect(await snapshot(e.pid)).toEqual(kept);
    // The passkey that stayed (renamed, its counter at 1) signs in again with the next counter.
    expect(await passkeySignIn(e.softs[0], e.uid, 2)).toEqual({ status: 200, body: { ok: true, verify: false } });
  });
});

describe("rule 2426: the route's gate order and the panel's toggle", () => {
  it("source pins: actor, owner permission, second factor, reason, then the write, then the audit row", () => {
    const src = readFileSync("src/app/api/admin/passkeys/route.ts", "utf8");
    const at = (s: string) => { const i = src.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const post = src.slice(src.indexOf("export async function POST"));
    const p = (s: string) => { const i = post.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(p("await adminActor(req)")).toBeLessThan(p('staffMay(consoleRole(req), "passkeys.switch")'));
    expect(p('staffMay(consoleRole(req), "passkeys.switch")')).toBeLessThan(p("await secondFactorRefusal(req, who)"));
    expect(p("await secondFactorRefusal(req, who)")).toBeLessThan(p("reasonRefused("));
    expect(p("reasonRefused(")).toBeLessThan(p("await setPasskeysOn("));
    expect(p("await setPasskeysOn(")).toBeLessThan(p("await adminAudit("));
    expect(p("await adminAudit(")).toBeLessThan(p("NextResponse.json({ ok: true, on }"));
    expect(post).toContain("via: viaOf(req)");
    expect(post).toContain('section: "system"');
    // The GET reads after the console gate and writes nothing.
    const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
    expect(get.indexOf("await adminActor(req)")).toBeLessThan(get.indexOf("await passkeysOn()"));
    expect(get).not.toMatch(/setPasskeysOn|adminAudit|db\./);
    // No key is built here: the switch module owns `passkeys:off`.
    expect(at('from "@/lib/passkey-switch"')).toBeGreaterThan(-1);
    expect(src).not.toMatch(/["']passkeys:off["']|from "@\/lib\/db"/);
  });

  it("the Passkeys row: both languages, the state, the toggle asks a reason and posts through adminFetch", () => {
    const shape = (o: unknown): unknown => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o);
    expect(shape(PASSKEYS_SWITCH_COPY.ar)).toEqual(shape(PASSKEYS_SWITCH_COPY.en));
    for (const lang of ["ar", "en"] as const) {
      const C = PASSKEYS_SWITCH_COPY[lang];
      const on = renderToStaticMarkup(createElement(PasskeysSwitch, { lang, initial: true }));
      expect(on).toContain('data-testid="integration-passkeys"');
      expect(on).toContain(C.onNow);
      expect(on).toContain(C.turnOff);
      const off = renderToStaticMarkup(createElement(PasskeysSwitch, { lang, initial: false }));
      expect(off).toContain(C.offNow);
      expect(off).toContain(C.turnOn);
    }
    const src = readFileSync("src/components/admin/IntegrationsPanel.tsx", "utf8");
    expect(src).toContain('adminFetch("/api/admin/passkeys"');
    expect(src).toContain("useAdminForm(lang)");
    expect(src).toMatch(/JSON\.stringify\(\{ on: next, reason: v\.reason \}\)/);
    expect(src).toContain("<PasskeysSwitch lang={lang} />");
    expect(src).not.toMatch(/@\/lib\/passkey-switch"/);
  });
});
