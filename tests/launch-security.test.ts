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

describe("production never runs on the memory store (rule 320)", () => {
  const noRedis = () => { for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) vi.stubEnv(k, ""); };

  it("a production deployment without Redis credentials rejects every call with store_not_configured", async () => {
    noRedis();
    vi.stubEnv("VERCEL_ENV", "production");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const fresh = await import("@/lib/db");
    expect(fresh.usingPersistentStore).toBe(false);
    await expect(fresh.db.get("x")).rejects.toBeInstanceOf(fresh.StoreNotConfigured);
    await expect(fresh.db.set("x", 1)).rejects.toThrow(/store_not_configured/);
    await expect(fresh.db.incrby("rate:x", 1)).rejects.toThrow(/store_not_configured/);
    // Importing it (what `next build` does) is fine; only a call fails, and the log names the variables, never a value.
    expect(err.mock.calls.flat().join(" ")).toMatch(/store_not_configured/);
    err.mockRestore();
  });

  it("local dev, tests, CI and preview keep the memory store", async () => {
    noRedis();
    for (const env of ["", "preview", "development"]) {
      vi.stubEnv("VERCEL_ENV", env);
      vi.resetModules();
      const fresh = await import("@/lib/db");
      await fresh.db.set("launch:mem", env || "none");
      expect(await fresh.db.get("launch:mem")).toBe(env || "none");
    }
  });
});

describe("production never answers with the model mock (rule 321)", () => {
  it("no key in a production deployment is 'paused', never 'mock'; elsewhere the dev mock stays", async () => {
    const { modelState } = await import("@/lib/model");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(modelState()).toBe("mock");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(modelState()).toBe("mock");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VERCEL_ENV", "production");
    expect(modelState()).toBe("paused");
    err.mockRestore();
  });

  it("generate, the free tools and the chat refuse in production without a key: nothing charged, no [DEV MOCK] saved", async () => {
    const { newUser } = await import("./helpers/session");
    const { getUser } = await import("@/lib/auth");
    const { listTasks } = await import("@/lib/brand");
    const { chat } = await import("@/lib/chat");
    const { PAUSED_REPLY } = await import("@/lib/model");
    const generateRoute = await import("@/app/api/generate/route");
    const toolRoute = await import("@/app/api/tools/[tool]/route");
    const { TOOLS } = await import("@/lib/tools");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const u = await newUser("prodnokey");
    await db.set(`brand:${u.email}`, { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-10-01T00:00:00.000Z" });
    await signIn(u.email);
    const res = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("model_paused");
    expect(await getUser(u.email).then((x) => x!.credits)).toBe(50);
    expect(JSON.stringify(await listTasks(u.email))).not.toMatch(/DEV MOCK/);
    const slug = TOOLS[0].slug;
    const tool = await toolRoute.POST(json(`/api/tools/${slug}`, "POST", {}, ip()), { params: Promise.resolve({ tool: slug }) });
    expect(tool.status).toBe(503);
    expect(await tool.text()).not.toMatch(/DEV MOCK/);
    const reply = await chat((await getUser(u.email))!, "hello", undefined, "noor", { lang: "en" });
    expect(reply.content).toBe(PAUSED_REPLY.en);
    err.mockRestore();
  });
});

describe("the waitlist keeps email addresses out of the logs (rule 322)", () => {
  it("stores through the shared store and never logs the record", async () => {
    const waitlist = await import("@/app/api/waitlist/route");
    const logs = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "info").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    const email = `lead-${Date.now()}@test.example`;
    const res = await waitlist.POST(json("/api/waitlist", "POST", { email, company: "Roastery" }, ip()));
    expect(await res.json()).toMatchObject({ ok: true, stored: true, duplicate: false });
    expect((await (await waitlist.POST(json("/api/waitlist", "POST", { email }, ip()))).json())).toMatchObject({ ok: true, duplicate: true });
    expect(await db.sismember("waitlist:emails", email)).toBe(true);
    expect(logs.flatMap((s) => s.mock.calls.flat()).join(" ")).not.toContain(email);
    logs.forEach((s) => s.mockRestore());
    vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
    const rows = (await (await waitlist.GET(json("/api/waitlist", "GET", undefined, { "x-admin-key": KEY, ...ip() }))).json()) as { rows: { email: string }[] };
    expect(rows.rows.some((r) => r.email === email)).toBe(true);
    expect(readFileSync("src/app/api/waitlist/route.ts", "utf8")).not.toMatch(/console\.log/);
  });
});

describe("the auth forms never get stuck and say what went wrong (rule 323)", () => {
  it("postJson never throws: a dropped connection is status 0, an HTML error page is an empty body", async () => {
    const { postJson } = await import("@/lib/auth-client");
    const dropped = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await postJson("/api/auth/login", {}, dropped)).toEqual({ status: 0, body: {} });
    const html = (async () => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await postJson("/api/auth/signup", {}, html)).toEqual({ status: 502, body: {} });
    const ok = (async () => Response.json({ ok: true, mail: false })) as unknown as typeof fetch;
    expect(await postJson("/api/auth/forgot", {}, ok)).toEqual({ status: 200, body: { ok: true, mail: false } });
  });

  it("maps a status and code to one message: a rate limit, the connection and the server are never 'wrong password'", async () => {
    const { authMessage, AUTH_ERR, failureCode, succeeded } = await import("@/lib/auth-client");
    const code = (status: number, error?: string) => failureCode({ status, body: error ? { ok: false, error } : {} });
    expect([code(0), code(429, "slow_down"), code(500), code(502), code(504, "invalid"), code(200), code(401, "invalid"), code(403, "suspended"), code(409, "exists"), code(400, "captcha_failed"), code(503, "captcha_unavailable")])
      .toEqual(["network", "slow_down", "server", "server", "server", "server", "invalid", "suspended", "exists", "captcha_failed", "captcha_unavailable"]);
    expect(succeeded({ status: 200, body: { ok: false } })).toBe(false);
    expect(succeeded({ status: 200, body: { ok: true } })).toBe(true);
    for (const lang of ["ar", "en"] as const) {
      const own = { invalid: `wrong-${lang}` };
      expect(authMessage("invalid", lang, own)).toBe(own.invalid);
      for (const c of ["network", "slow_down", "server", "captcha_failed", "captcha_unavailable", "disabled"] as const) {
        expect(authMessage(c, lang, own)).toBe(AUTH_ERR[lang][c]);
        expect(AUTH_ERR[lang][c].length).toBeGreaterThan(10);
      }
      // An unknown code never reaches the screen as a raw identifier.
      expect(authMessage("some_new_code", lang, own)).toBe(AUTH_ERR[lang].server);
    }
    expect(new Set(Object.values(AUTH_ERR.en)).size, "every message is distinct").toBe(Object.keys(AUTH_ERR.en).length);
    expect(Object.keys(AUTH_ERR.ar)).toEqual(Object.keys(AUTH_ERR.en));
  });

  it("every auth form posts through postJson and clears its busy state in finally", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(src).not.toMatch(/await fetch\(/);
    expect(src).not.toMatch(/\.json\(\)(?!\.catch)/);
    expect(src.match(/await postJson\(/g)?.length).toBe(4);
    expect(src.match(/\} finally \{/g)?.length).toBe(4);
  });
});

describe("password rules are not colour-only (rule 324)", () => {
  it("the client checks agree with the server's strongPassword", async () => {
    const { passwordChecks } = await import("@/lib/auth-client");
    const { strongPassword } = await import("@/lib/auth");
    for (const pw of ["", "abc", "abcdefgh", "12345678", "abcdefg1", "كلمةسر12", "short1", "nodigitshere", "goodpass1", "        1a"]) {
      expect(passwordChecks(pw).every(Boolean), pw).toBe(strongPassword(pw));
    }
  });

  it("a live status line counts the rules met, and an early press names the unmet ones", async () => {
    const { passwordChecks, rulesStatus, unmetRules } = await import("@/lib/auth-client");
    const rules = { en: ["At least 8 characters", "At least one letter", "At least one number"], ar: ["8 أحرف على الأقل", "حرف واحد على الأقل", "رقم واحد على الأقل"] };
    expect(rulesStatus(passwordChecks("abc"), "en")).toBe("1 of 3 password rules met");
    expect(rulesStatus(passwordChecks("abcdefg1"), "en")).toBe("3 of 3 password rules met");
    expect(rulesStatus(passwordChecks("abc"), "ar")).toBe("1 من 3 شروط لكلمة المرور متحققة");
    expect(unmetRules(passwordChecks("abc"), rules.en, "en")).toBe("Your password still needs: At least 8 characters, At least one number.");
    expect(unmetRules(passwordChecks("abc"), rules.ar, "ar")).toBe("كلمة المرور ما زالت تحتاج: 8 أحرف على الأقل، رقم واحد على الأقل.");
    expect(unmetRules(passwordChecks("abcdefg1"), rules.en, "en")).toBe("");
  });

  it("the forms render a text state per rule, one live line, and a focusable aria-disabled submit", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(src).not.toMatch(/<ul[^>]*aria-live/);
    expect(src).toMatch(/className="sr-only"> \(\{checks\[i\] \? T\.met : T\.unmet\}\)/);
    expect(src).toMatch(/<p className="sr-only" aria-live="polite">\{rulesStatus\(checks, lang\)\}<\/p>/);
    // The submit is no longer disabled by the rules: it stays focusable and is described by the rules list.
    expect(src).not.toMatch(/disabled=\{busy \|\|/);
    expect(src.match(/aria-disabled=\{/g)?.length).toBe(2);
    expect(src).toContain('aria-describedby={step === 2 ? "signup-rules" : undefined}');
    expect(src).toContain('aria-describedby="reset-rules"');
  });
});
