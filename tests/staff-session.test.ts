import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { idleInTime, idleTtl } from "@/lib/idle-session";
import { getStaff, saveStaff } from "@/lib/staff";
import {
  STAFF_COOKIE, STAFF_COOKIE_DEV, STAFF_PRE_COOKIE, STAFF_PRE_COOKIE_DEV, STAFF_SESSION_IDLE, STAFF_SESSION_MAX, destroyStaffSession, endStaffSessions,
  openStaffSession, readStaffSession, staffCookieNames, staffCookieOptions, staffSessionKey,
} from "@/lib/staff-session";
import { jar, withHeaders } from "./helpers/session";
import { enrolledStaff } from "./helpers/staff";

/** The staff session: rules 1633-1636, 1648 and 1652 (docs/system/tests/1630-staff-identity.md). */
const T0 = Date.UTC(2026, 9, 13, 9, 0, 0);
const at = (ms: number) => vi.setSystemTime(new Date(ms));

beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "staff-session-connect-secret"); vi.stubEnv("WAITLIST_ADMIN_KEY", "staff-session-key-0123456789"); });
beforeEach(() => { jar().clear(); vi.useFakeTimers({ toFake: ["Date"] }); at(T0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the staff cookie (rule 1633)", () => {
  it("__Host- names, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain", async () => {
    expect(await staffCookieNames()).toEqual({ session: STAFF_COOKIE, pre: STAFF_PRE_COOKIE });
    expect([STAFF_COOKIE, STAFF_PRE_COOKIE].every((n) => n.startsWith("__Host-"))).toBe(true);
    const o = await staffCookieOptions(STAFF_SESSION_MAX);
    expect(o).toEqual({ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: STAFF_SESSION_MAX });
    expect(o).not.toHaveProperty("domain");
    // A real host over https, or plain http to a real host: always the prefixed, Secure cookie.
    for (const h of [{ host: "thakeen.com", "x-forwarded-proto": "https" }, { host: "thakeen.com", "x-forwarded-proto": "http" }, { host: "localhost:3000", "x-forwarded-proto": "https" }]) {
      await withHeaders(h, async () => {
        expect((await staffCookieNames()).session).toBe(STAFF_COOKIE);
        expect((await staffCookieOptions(1)).secure).toBe(true);
      });
    }
  });
  it("the dev names only on plain http to the loopback host", async () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      await withHeaders({ host, "x-forwarded-proto": "http" }, async () => {
        expect(await staffCookieNames()).toEqual({ session: STAFF_COOKIE_DEV, pre: STAFF_PRE_COOKIE_DEV });
        expect((await staffCookieOptions(1)).secure).toBe(false);
      });
    }
  });
  it("the value is a random 32-byte id and the record lives under its hash", async () => {
    const { staff } = await enrolledStaff();
    const { id, hash } = await openStaffSession(staff.email);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(jar().get(STAFF_COOKIE)).toBe(id);
    expect(await db.get(staffSessionKey(hash))).toMatchObject({ email: staff.email, at: T0, seen: T0 });
    expect(await db.get(staffSessionKey(id))).toBeNull();
    // A planted dev-name cookie is never read on a real host.
    jar().clear();
    jar().set(STAFF_COOKIE_DEV, id);
    expect(await readStaffSession()).toBeNull();
  });
  it("a staff session is never a customer session (rule 1630)", async () => {
    const { staff } = await enrolledStaff();
    await openStaffSession(staff.email);
    expect(await currentUser()).toBeNull();
    expect(jar().has("nashr_session")).toBe(false);
  });
});

describe("the staff session's limits (rule 1634)", () => {
  it("renewed at most once a minute with SET XX; idle 15 minutes; absolute 12 hours", async () => {
    const { staff } = await enrolledStaff();
    const { hash } = await openStaffSession(staff.email);
    const setXx = vi.spyOn(db, "setXx");
    at(T0 + 30_000);
    expect(await readStaffSession()).toMatchObject({ email: staff.email });
    expect(setXx).not.toHaveBeenCalled();
    at(T0 + 61_000);
    expect(await readStaffSession()).not.toBeNull();
    expect(setXx).toHaveBeenCalledTimes(1);
    expect(setXx.mock.calls[0][0]).toBe(staffSessionKey(hash));
    expect(setXx.mock.calls[0][2]).toBe(STAFF_SESSION_IDLE);
    // Idle: 15 minutes after the last renewal it is over, whatever the record's TTL says.
    at(T0 + 61_000 + STAFF_SESSION_IDLE * 1000);
    expect(await readStaffSession()).toBeNull();
  });
  it("busy all day still ends at 12 hours", async () => {
    const { staff } = await enrolledStaff();
    await openStaffSession(staff.email);
    for (let t = 10 * 60_000; t < STAFF_SESSION_MAX * 1000; t += 10 * 60_000) {
      at(T0 + t);
      expect(await readStaffSession(), String(t)).not.toBeNull();
    }
    at(T0 + STAFF_SESSION_MAX * 1000);
    expect(await readStaffSession()).toBeNull();
    expect(idleTtl({ at: T0, seen: T0 }, T0 + STAFF_SESSION_MAX * 1000 - 5_000, { idle: 900, max: STAFF_SESSION_MAX, renew: 60 })).toBe(5);
    expect(idleInTime({ at: T0 }, T0 + 899_000, { idle: 900, max: STAFF_SESSION_MAX, renew: 60 })).toBe(true);
  });
  it("sign-out deletes the record, and a renewal racing it never revives it", async () => {
    const { staff } = await enrolledStaff();
    const { hash } = await openStaffSession(staff.email);
    const id = jar().get(STAFF_COOKIE)!;
    expect(await destroyStaffSession()).toBe(staff.email);
    expect(await db.get(staffSessionKey(hash))).toBeNull();
    expect(jar().get(STAFF_COOKIE)).toBe("");
    // The same cookie copied back: still nothing, and the renewal path writes nothing (SET XX on a missing key).
    jar().set(STAFF_COOKIE, id);
    at(T0 + 120_000);
    expect(await readStaffSession()).toBeNull();
    expect(await db.get(staffSessionKey(hash))).toBeNull();
  });
  it("the shared logic is the key session's too (not a copy)", () => {
    const src = readFileSync("src/lib/auth.ts", "utf8");
    expect(src).toMatch(/from "\.\/idle-session"/);
    expect(src).not.toMatch(/const adminSessionTtl/);
    expect(readFileSync("src/lib/staff-session.ts", "utf8")).toMatch(/from "\.\/idle-session"/);
  });
});

describe("sessionsAfter ends every session (rule 1635)", () => {
  it("password or authenticator reset, disable and role change end the session at once", async () => {
    for (const change of ["reset", "disable", "role", "no-authenticator"] as const) {
      const { staff } = await enrolledStaff();
      await openStaffSession(staff.email);
      expect(await readStaffSession(), change).not.toBeNull();
      at(Date.now() + 1);
      const s = (await getStaff(staff.email))!;
      if (change === "disable") s.disabled = true;
      else if (change === "no-authenticator") delete s.totp;
      else { endStaffSessions(s); if (change === "role") s.role = "support"; }
      await saveStaff(s);
      expect(await readStaffSession(), change).toBeNull();
      at(T0);
    }
  });
});
