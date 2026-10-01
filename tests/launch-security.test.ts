import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminSignIn, jar, json, signIn, signOut } from "./helpers/session";
import { adminEmails, ADMIN_SESSION_TTL, createUser, isAdmin, isAdminCookie, isFounder } from "@/lib/auth";
import { db } from "@/lib/db";

import * as adminLogin from "@/app/api/admin/login/route";
import * as overview from "@/app/api/admin/overview/route";
import * as log from "@/app/api/admin/log/route";

/**
 * Launch security (rules 310-329, docs/system/tests.md): the founder console's key session, the admin email list that
 * fails closed, Cloudflare Turnstile on signup and forgot-password, the auth forms' error states, and production never
 * running on the memory store or the model mock.
 */

const KEY = "launch-admin-key-0123456789";
let ipN = 0;
/** A fresh client address per test, so the per-IP throttles of one test never refuse another's calls. */
const ip = () => ({ "x-real-ip": `198.51.100.${++ipN}` });

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("the founder console's key session (rules 310-314)", () => {
  beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); signOut(); });

  it("310: a right key sets an opaque session id, never the key, and opens the console", async () => {
    const res = await adminLogin.POST(json("/api/admin/login", "POST", { key: KEY }, ip()));
    expect(res.status).toBe(200);
    const cookie = jar().get("nashr_admin")!;
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toBe(KEY);
    expect(cookie.includes(KEY)).toBe(false);
    expect(await isAdminCookie()).toBe(true);
    expect((await overview.GET(json("/api/admin/overview", "GET"))).status).toBe(200);
    // The server record is keyed by a hash of the id, so the database never holds a live cookie value either.
    expect(await db.get(`adminsession:${cookie}`)).toBeNull();
  });

  it("310: a wrong key, a prefix of it and a non-string key are refused and set no cookie", async () => {
    const h = ip();
    for (const key of [KEY.slice(0, -1), `${KEY}x`, "", 12345, null]) {
      expect((await adminLogin.POST(json("/api/admin/login", "POST", { key }, h))).status).toBe(401);
    }
    expect(jar().has("nashr_admin")).toBe(false);
  });

  it("311: logging out deletes the server record, so putting the same cookie back opens nothing", async () => {
    const id = await adminSignIn();
    expect(await isAdminCookie()).toBe(true);
    expect((await adminLogin.DELETE()).status).toBe(200);
    expect(jar().has("nashr_admin")).toBe(false);
    jar().set("nashr_admin", id);
    expect(await isAdminCookie()).toBe(false);
    expect(await isAdmin(json("/api/admin/log", "GET"))).toBe(false);
    expect((await log.GET(json("/api/admin/log", "GET"))).status).toBe(401);
  });

  it("312: a key session ends after 12 hours", async () => {
    expect(ADMIN_SESSION_TTL).toBe(12 * 3600);
    await adminSignIn();
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (ADMIN_SESSION_TTL - 60) * 1000);
    expect(await isAdminCookie(), "still open a minute before the end").toBe(true);
    vi.setSystemTime(Date.now() + 120 * 1000);
    expect(await isAdminCookie()).toBe(false);
  });

  it("313: rotating WAITLIST_ADMIN_KEY ends every key session; removing it disables the path", async () => {
    await adminSignIn();
    expect(await isAdminCookie()).toBe(true);
    vi.stubEnv("WAITLIST_ADMIN_KEY", "a-brand-new-admin-key-987654");
    expect(await isAdminCookie()).toBe(false);
    // Putting the old key back revives sessions opened with it, which is the expected meaning of "the same key".
    vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
    expect(await isAdminCookie()).toBe(true);
    vi.stubEnv("WAITLIST_ADMIN_KEY", "");
    expect(await isAdminCookie()).toBe(false);
  });

  it("314: the raw key in the cookie (what a browser kept from before) opens nothing; the header still works", async () => {
    jar().set("nashr_admin", KEY);
    expect(await isAdminCookie()).toBe(false);
    expect((await overview.GET(json("/api/admin/overview", "GET"))).status).toBe(401);
    signOut();
    expect((await overview.GET(json("/api/admin/overview", "GET", undefined, { "x-admin-key": KEY, ...ip() }))).status).toBe(200);
  });

  it("314: the login route compares with sameSecret and stores no key", () => {
    const src = readFileSync("src/app/api/admin/login/route.ts", "utf8");
    expect(src).toContain("sameSecret(");
    expect(src).not.toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/jar\.set\(/);
  });
});

describe("founder emails fail closed (rule 315)", () => {
  it("with ADMIN_EMAILS unset or empty no email is a founder, and the old default address gets 401 everywhere", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
    vi.stubEnv("ADMIN_EMAILS", "");
    expect(adminEmails()).toEqual([]);
    const prev = process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
    try {
      expect(adminEmails()).toEqual([]);
      // The address that used to be the built-in default, assembled so the literal does not live in the repository.
      const former = ["hejazy", "gmail.com"].join("@");
      expect(isFounder(former)).toBe(false);
      // Someone registers that address on a fresh database: an ordinary account, nothing more.
      await createUser({ email: former, name: "Claimant", phone: "", password: "abc12345", lang: "ar" });
      await signIn(former);
      expect(await isAdminCookie()).toBe(false);
      expect((await overview.GET(json("/api/admin/overview", "GET"))).status).toBe(401);
      expect((await log.GET(json("/api/admin/log", "GET"))).status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.ADMIN_EMAILS = prev;
    }
  });

  it("a listed address is a founder; the list is the only source", () => {
    vi.stubEnv("ADMIN_EMAILS", " Founder@Test.Example , second@test.example");
    expect(adminEmails()).toEqual(["founder@test.example", "second@test.example"]);
    expect(isFounder("FOUNDER@test.example")).toBe(true);
  });

  it("src/lib/auth.ts holds no email address literal", () => {
    const src = readFileSync("src/lib/auth.ts", "utf8");
    expect(src.match(/["'`][^"'`\s]+@[^"'`\s]+\.[a-z]{2,}["'`]/gi) ?? []).toEqual([]);
  });
});
