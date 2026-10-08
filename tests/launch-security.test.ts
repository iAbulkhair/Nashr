import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminSignIn, jar, json, signIn, signOut } from "./helpers/session";
import { createHash } from "node:crypto";
import { adminEmails, ADMIN_SESSION_IDLE, ADMIN_SESSION_MAX, ADMIN_SESSION_RENEW, createUser, isAdmin, isAdminCookie, isFounder } from "@/lib/auth";
import { db } from "@/lib/db";

import * as adminLogin from "@/app/api/admin/login/route";
import * as overview from "@/app/api/admin/overview/route";
import * as log from "@/app/api/admin/log/route";

/**
 * Launch security (rules 420-436, docs/system/tests.md): the founder console's key session, the admin email list that
 * fails closed, Cloudflare Turnstile on signup and forgot-password, the auth forms' error states, and production never
 * running on the memory store or the model mock.
 */

const KEY = "launch-admin-key-0123456789";
let ipN = 0;
/** A fresh client address per test, so the per-IP throttles of one test never refuse another's calls. */
const ip = () => ({ "x-real-ip": `198.51.100.${++ipN}` });

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("the founder console's key session (rules 420-424, 429, 435)", () => {
  beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); signOut(); });

  it("420: a right key sets an opaque session id, never the key, and opens the console", async () => {
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

  it("420: a wrong key, a prefix of it and a non-string key are refused and set no cookie", async () => {
    const h = ip();
    for (const key of [KEY.slice(0, -1), `${KEY}x`, "", 12345, null]) {
      expect((await adminLogin.POST(json("/api/admin/login", "POST", { key }, h))).status).toBe(401);
    }
    expect(jar().has("nashr_admin")).toBe(false);
  });

  it("421: logging out deletes the server record, so putting the same cookie back opens nothing", async () => {
    const id = await adminSignIn();
    expect(await isAdminCookie()).toBe(true);
    expect((await adminLogin.DELETE()).status).toBe(200);
    expect(jar().has("nashr_admin")).toBe(false);
    jar().set("nashr_admin", id);
    expect(await isAdminCookie()).toBe(false);
    expect(await isAdmin(json("/api/admin/log", "GET"))).toBe(false);
    expect((await log.GET(json("/api/admin/log", "GET"))).status).toBe(401);
  });

  it("422: a key session ends after 15 minutes without an admin request; each admin request renews it", async () => {
    expect(ADMIN_SESSION_IDLE).toBe(15 * 60);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const min = (n: number) => vi.setSystemTime(Date.now() + n * 60 * 1000);
    await adminSignIn();
    min(10);
    expect((await overview.GET(json("/api/admin/overview", "GET"))).status, "an admin request 10 minutes in").toBe(200);
    min(14);
    expect(await isAdmin(json("/api/admin/log", "GET")), "14 minutes idle after a renewing request").toBe(true);
    min(14);
    expect(await isAdminCookie(), "the page load renewed it too").toBe(true);
    min(16);
    expect(await isAdminCookie(), "16 minutes idle").toBe(false);
    expect((await overview.GET(json("/api/admin/overview", "GET"))).status).toBe(401);
    expect((await log.GET(json("/api/admin/log", "GET"))).status).toBe(401);

    // A fresh session nobody uses is gone 16 minutes after the key entry, and its record with it.
    signOut();
    const id = await adminSignIn();
    min(16);
    expect(await isAdminCookie(), "16 minutes after the key entry with no request").toBe(false);
    expect(await db.get(`adminsession:${createHash("sha256").update(id).digest("hex")}`), "the record expired").toBeNull();
  });

  it("422: no key session outlives 12 hours from the key entry, however busy", async () => {
    expect(ADMIN_SESSION_MAX).toBe(12 * 3600);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const t0 = Date.now();
    const id = await adminSignIn();
    const rec = `adminsession:${createHash("sha256").update(id).digest("hex")}`;
    // An admin request every 10 minutes for 11 hours 50 minutes keeps it open.
    for (let m = 10; m <= 710; m += 10) {
      vi.setSystemTime(t0 + m * 60 * 1000);
      expect(await isAdminCookie(), `minute ${m}`).toBe(true);
    }
    // A request 5 minutes before the cap renews it, but only up to the cap: the record's TTL never runs past 12 hours.
    vi.setSystemTime(t0 + (ADMIN_SESSION_MAX - 300) * 1000);
    expect(await isAdminCookie()).toBe(true);
    vi.setSystemTime(t0 + (ADMIN_SESSION_MAX - 1) * 1000);
    expect(await isAdminCookie(), "one second before the cap").toBe(true);
    vi.setSystemTime(t0 + (ADMIN_SESSION_MAX + 1) * 1000);
    expect(await isAdminCookie(), "one second after the cap, 5 minutes after a request").toBe(false);
    expect(await db.get(rec), "the record's TTL ended at the cap").toBeNull();
    // The cookie itself carries the 12-hour cap (the test jar keeps no cookie options, so this reads the source).
    expect(readFileSync("src/lib/auth.ts", "utf8")).toMatch(/jar\.set\(ADMIN_COOKIE, id, await sessionCookie\(ADMIN_SESSION_MAX\)\)/);
  });

  it("435: renewing is one Redis write at most once a minute, never brings back a logged-out session, and holds old records to both limits", async () => {
    expect(ADMIN_SESSION_RENEW).toBe(60);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const id = await adminSignIn();
    const rec = `adminsession:${createHash("sha256").update(id).digest("hex")}`;
    const setXx = vi.spyOn(db, "setXx");
    const set = vi.spyOn(db, "set");
    try {
      // Inside the first minute: reads only.
      vi.setSystemTime(Date.now() + 30 * 1000);
      for (let i = 0; i < 5; i++) expect(await isAdminCookie()).toBe(true);
      expect(setXx).not.toHaveBeenCalled();
      // Past it: a burst of admin calls costs exactly one SET XX, with the TTL of the idle window.
      vi.setSystemTime(Date.now() + 31 * 1000);
      for (let i = 0; i < 3; i++) expect(await isAdminCookie()).toBe(true);
      expect((await overview.GET(json("/api/admin/overview", "GET"))).status).toBe(200);
      expect(setXx).toHaveBeenCalledTimes(1);
      expect(setXx.mock.calls[0][0]).toBe(rec);
      expect(setXx.mock.calls[0][2]).toBe(ADMIN_SESSION_IDLE);
      expect(set.mock.calls.filter((c) => String(c[0]).startsWith("adminsession:"))).toHaveLength(0);

      // A renewal that read the record just before a logout deleted it cannot bring it back (SET XX).
      const stale = await db.get(rec);
      vi.setSystemTime(Date.now() + 2 * 60 * 1000);
      expect((await adminLogin.DELETE()).status).toBe(200);
      jar().set("nashr_admin", id);
      vi.spyOn(db, "get").mockResolvedValueOnce(stale);
      await isAdminCookie();
      expect(await db.get(rec), "the logged-out record stays gone").toBeNull();
      expect(await isAdminCookie()).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }

    // A record written before this change (12-hour TTL, no `seen`) is held to the idle limit in code.
    const old = "d".repeat(64);
    const kp = createHash("sha256").update(`nashr-admin-key:${KEY}`).digest("hex");
    await db.set(`adminsession:${createHash("sha256").update(old).digest("hex")}`, { kp, at: Date.now() - 16 * 60 * 1000 }, 12 * 3600);
    signOut();
    jar().set("nashr_admin", old);
    expect(await isAdminCookie(), "16 minutes since the key entry, never renewed").toBe(false);
    // ... and to the absolute limit, even with a recent `seen`.
    await db.set(`adminsession:${createHash("sha256").update(old).digest("hex")}`, { kp, at: Date.now() - (ADMIN_SESSION_MAX * 1000 + 1000), seen: Date.now() - 60 * 1000 }, 3600);
    expect(await isAdminCookie(), "past 12 hours").toBe(false);
  });

  it("435: work in the customer view keeps the key session alive (one write a minute at most); 16 idle minutes end both", async () => {
    const users = await import("@/app/api/admin/users/[email]/route");
    const { currentUser } = await import("@/lib/auth");
    const customer = await createUser({ email: `idle-${Date.now().toString(36)}@test.example`, name: "Customer", phone: "", password: "abc12345", lang: "en" });
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const t0 = Date.now();
    const id = await adminSignIn();
    const rec = `adminsession:${createHash("sha256").update(id).digest("hex")}`;
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", reason: "support" }), { params: Promise.resolve({ email: encodeURIComponent(customer.email) }) });
    expect(res.status).toBe(200);
    // The founder is busy in the customer view for 40 minutes, never touching the console: the key session stays open.
    const setXx = vi.spyOn(db, "setXx");
    try {
      for (const m of [5, 10, 14, 20, 28, 40]) {
        vi.setSystemTime(t0 + m * 60 * 1000);
        expect((await currentUser())?.email, `customer view at ${m} minutes`).toBe(customer.email);
        expect((await currentUser())?.email, "a second request in the same minute").toBe(customer.email);
      }
      expect(setXx.mock.calls.every((c) => c[0] === rec), "only the key session's record is renewed").toBe(true);
      expect(setXx, "one renewal per request minute, not per request").toHaveBeenCalledTimes(6);
    } finally {
      vi.restoreAllMocks();
    }
    expect(await db.get(rec), "the key session is still there").not.toBeNull();
    // 16 minutes without a request on either side: the impersonation and the key session end together.
    vi.setSystemTime(t0 + 56 * 60 * 1000);
    expect(await currentUser(), "16 idle minutes").toBeNull();
    expect(await isAdminCookie(), "the key session went with it").toBe(false);
  });

  it("435: a customer request through a key impersonation never outruns the key session's 12-hour cap", async () => {
    const users = await import("@/app/api/admin/users/[email]/route");
    const { currentUser } = await import("@/lib/auth");
    const customer = await createUser({ email: `cap-${Date.now().toString(36)}@test.example`, name: "Customer", phone: "", password: "abc12345", lang: "en" });
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const t0 = Date.now();
    const id = await adminSignIn();
    const rec = `adminsession:${createHash("sha256").update(id).digest("hex")}`;
    // Twelve hours of console use (a request every 10 minutes), then an impersonation in its last minutes.
    for (let m = 10; m < 12 * 60 - 5; m += 10) {
      vi.setSystemTime(t0 + m * 60 * 1000);
      expect(await isAdminCookie()).toBe(true);
    }
    vi.setSystemTime(t0 + (12 * 60 - 4) * 60 * 1000);
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate" }), { params: Promise.resolve({ email: encodeURIComponent(customer.email) }) });
    expect(res.status).toBe(200);
    const setXx = vi.spyOn(db, "setXx");
    try {
      vi.setSystemTime(t0 + (12 * 60 - 2) * 60 * 1000);
      expect((await currentUser())?.email).toBe(customer.email);
      expect(setXx.mock.calls[0]?.[2], "the renewal's TTL stops at the cap").toBeLessThanOrEqual(2 * 60);
    } finally {
      vi.restoreAllMocks();
    }
    vi.setSystemTime(t0 + ADMIN_SESSION_MAX * 1000 + 1000);
    expect(await currentUser(), "one second past 12 hours").toBeNull();
    expect(await db.get(rec)).toBeNull();
  });

  it("435: the audit log states how long a key impersonation really lasts", async () => {
    const users = await import("@/app/api/admin/users/[email]/route");
    const customer = await createUser({ email: `audit-${Date.now().toString(36)}@test.example`, name: "Customer", phone: "", password: "abc12345", lang: "en" });
    const entry = async () => (await db.lrange("admin:log", 0, 49)).map((r) => JSON.parse(r)).find((e) => e.email === customer.email && e.what === "impersonate");
    await adminSignIn();
    expect((await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate" }), { params: Promise.resolve({ email: encodeURIComponent(customer.email) }) })).status).toBe(200);
    expect(await entry()).toMatchObject({ actor: "key", expiresInMin: 120, idleMin: 15, endsWithKeySession: true });
    // Opened with the header (no key session): 2 hours, tied to the key alone, no idle limit to report.
    await db.del("admin:log");
    signOut();
    expect((await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate" }, { "x-admin-key": KEY, ...ip() }), { params: Promise.resolve({ email: encodeURIComponent(customer.email) }) })).status).toBe(200);
    const e = await entry();
    expect(e).toMatchObject({ actor: "key", expiresInMin: 120 });
    expect(e.idleMin).toBeUndefined();
  });

  it("423: rotating WAITLIST_ADMIN_KEY ends every key session; removing it disables the path", async () => {
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

  it("424: the raw key in the cookie (what a browser kept from before) opens nothing; the header still works", async () => {
    jar().set("nashr_admin", KEY);
    expect(await isAdminCookie()).toBe(false);
    expect((await overview.GET(json("/api/admin/overview", "GET"))).status).toBe(401);
    signOut();
    expect((await overview.GET(json("/api/admin/overview", "GET", undefined, { "x-admin-key": KEY, ...ip() }))).status).toBe(200);
  });

  it("429: an impersonation opened with the key ends with the key session's logout and with a key rotation", async () => {
    const users = await import("@/app/api/admin/users/[email]/route");
    const { currentUser } = await import("@/lib/auth");
    const customer = await createUser({ email: `imp-${Date.now().toString(36)}@test.example`, name: "Customer", phone: "", password: "abc12345", lang: "en" });
    const impersonate = async () => {
      const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", reason: "support" }), { params: Promise.resolve({ email: encodeURIComponent(customer.email) }) });
      expect(res.status).toBe(200);
      const u = await currentUser();
      expect(u?.email).toBe(customer.email);
      expect(u?.actor).toMatchObject({ kind: "founder", impersonating: "key" });
      return jar().get("nashr_session")!;
    };

    // Opened from a key session, then "End key session": the customer session stops working too.
    await adminSignIn();
    const first = await impersonate();
    expect((await adminLogin.DELETE()).status).toBe(200);
    expect(await currentUser(), "logout of the key session").toBeNull();
    expect(await db.get(`session:${first}`), "the record may linger until its TTL, but it opens nothing").not.toBeNull();

    // Opened from a key session, then the key is rotated: the customer session stops working.
    signOut();
    await adminSignIn();
    await impersonate();
    vi.stubEnv("WAITLIST_ADMIN_KEY", "a-rotated-admin-key-555555");
    expect(await currentUser(), "key rotated").toBeNull();
    vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);

    // Opened with the x-admin-key header (no key session): tied to the key alone.
    signOut();
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate" }, { "x-admin-key": KEY, ...ip() }), { params: Promise.resolve({ email: encodeURIComponent(customer.email) }) });
    expect(res.status).toBe(200);
    expect((await currentUser())?.email).toBe(customer.email);
    vi.stubEnv("WAITLIST_ADMIN_KEY", "");
    expect(await currentUser(), "key removed").toBeNull();

    // A key impersonation record without the binding (written before this check) opens nothing.
    vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
    await db.set("session:" + "c".repeat(64), { email: customer.email, at: Date.now(), imp: "key" }, 600);
    signOut();
    jar().set("nashr_session", "c".repeat(64));
    expect(await currentUser()).toBeNull();
  });

  it("424: the login route compares with sameSecret and stores no key", () => {
    const src = readFileSync("src/app/api/admin/login/route.ts", "utf8");
    expect(src).toContain("sameSecret(");
    expect(src).not.toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/jar\.set\(/);
  });
});

describe("the console says when its session ended and links back in (rule 436)", () => {
  it("adminFetch announces a 401 on window and passes every response through unchanged", async () => {
    const { adminFetch, ADMIN_ENDED_EVENT } = await import("@/lib/admin-fetch");
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    let fired = 0;
    target.addEventListener(ADMIN_ENDED_EVENT, () => fired++);
    try {
      const answer = (status: number) => (async () => Response.json({ ok: status === 200 }, { status })) as unknown as typeof fetch;
      expect((await adminFetch("/api/admin/plan", undefined, answer(200))).status).toBe(200);
      expect((await adminFetch("/api/admin/plan", undefined, answer(403))).status).toBe(403);
      expect((await adminFetch("/api/admin/plan", undefined, answer(500))).status).toBe(500);
      expect(fired, "only a 401 means the session ended").toBe(0);
      const r = await adminFetch("/api/admin/evals", undefined, answer(401));
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ ok: false });
      expect(fired).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the message is bilingual, names both limits, and the link goes to the key form or the sign-in page", async () => {
    const { ADMIN_ENDED, adminEndedHref } = await import("@/lib/admin-fetch");
    for (const lang of ["ar", "en"] as const) {
      expect(ADMIN_ENDED[lang].key).toMatch(/15/);
      expect(ADMIN_ENDED[lang].key).toMatch(/12/);
      expect(ADMIN_ENDED[lang].founder.length).toBeGreaterThan(10);
      expect(adminEndedHref(lang, true)).toBe(`/${lang}/app/admin?login=1`);
      expect(adminEndedHref(lang, false)).toBe(`/${lang}/app/login`);
    }
    expect(ADMIN_ENDED.ar.key).toMatch(/[\u0600-\u06FF]/);
    expect(ADMIN_ENDED.en.key).not.toMatch(/[\u0600-\u06FF]/);
  });

  it("every admin call in the console and its panels goes through adminFetch; a 401 shows the message, never an empty table", () => {
    // PartnersPanel and PaymentsPanel came with the partner programme (PR #236, rule 418).
    for (const f of ["AdminConsole", "GoldenPanel", "WishlistPanel", "LeadsPanel", "PartnersPanel", "PaymentsPanel"]) {
      const src = readFileSync(`src/components/app/${f}.tsx`, "utf8");
      expect(src, f).not.toMatch(/(?<![A-Za-z])fetch\(["`]\/api\/admin/);
      expect(src, f).toMatch(/adminFetch\(["`]\/api\/admin/);
    }
    const src = readFileSync("src/components/app/AdminConsole.tsx", "utf8");
    expect(src).not.toMatch(/status === 401\) return setUsers\(\[\]\)/);
    expect(src).toContain("window.addEventListener(ADMIN_ENDED_EVENT, onEnded)");
    expect(src).toMatch(/if \(ended\) \{[\s\S]*?role="alert"[\s\S]*?adminEndedHref\(lang, keySession\)/);
  });
});

describe("founder emails fail closed (rule 425)", () => {
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

/** The deployment signals `isProductionDeploy` reads, all cleared, then the given ones set. vitest runs as NODE_ENV=test. */
const deployEnv = (env: { VERCEL_ENV?: string; APP_ENV?: string; NODE_ENV?: string } = {}) => {
  vi.stubEnv("VERCEL_ENV", env.VERCEL_ENV ?? "");
  vi.stubEnv("APP_ENV", env.APP_ENV ?? "");
  vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "test");
};

describe("production is detected on any host, failing closed (rules 430-431)", () => {
  it("Vercel production, APP_ENV=production and any unmarked production build are production", async () => {
    const { isProductionDeploy } = await import("@/lib/deploy-env");
    const production = [
      { VERCEL_ENV: "production" },
      { APP_ENV: "production" },
      // Hostinger or any other host: a production build with no deployment variable at all (env vars wiped).
      { NODE_ENV: "production" },
      // VERCEL_ENV=production and APP_ENV=production cannot be overridden by an opt-out.
      { VERCEL_ENV: "production", APP_ENV: "test", NODE_ENV: "production" },
      { APP_ENV: "production", VERCEL_ENV: "preview" },
      // An unknown or misspelt APP_ENV is production, never a silent opt-out.
      { APP_ENV: "prod", NODE_ENV: "production" },
      { APP_ENV: "staging" },
    ];
    for (const env of production) {
      deployEnv(env);
      expect(isProductionDeploy(), JSON.stringify(env)).toBe(true);
    }
  });

  it("local dev, vitest, Vercel previews and the e2e suite (APP_ENV=test) are not", async () => {
    const { isProductionDeploy } = await import("@/lib/deploy-env");
    const notProduction = [
      {},
      { NODE_ENV: "development" },
      { VERCEL_ENV: "preview", NODE_ENV: "production" },
      { VERCEL_ENV: "development", NODE_ENV: "production" },
      // The e2e suite: a production build marked as a test (playwright.config.ts webServer.env).
      { APP_ENV: "test", NODE_ENV: "production" },
      { APP_ENV: "development", NODE_ENV: "production" },
      { APP_ENV: "preview", NODE_ENV: "production" },
    ];
    for (const env of notProduction) {
      deployEnv(env);
      expect(isProductionDeploy(), JSON.stringify(env)).toBe(false);
    }
  });

  it("db and the model ask isProductionDeploy, not VERCEL_ENV; the e2e server is marked APP_ENV=test", () => {
    for (const f of ["src/lib/db.ts", "src/lib/model.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(/isProductionDeploy\(\)/);
      expect(src, f).not.toMatch(/process\.env\.VERCEL_ENV/);
    }
    expect(readFileSync("playwright.config.ts", "utf8")).toMatch(/env:\s*\{\s*APP_ENV:\s*"test"\s*\}/);
  });
});

describe("production never runs on the memory store (rule 430)", () => {
  const noRedis = () => { for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) vi.stubEnv(k, ""); };

  it("a production deployment on any host without Redis credentials rejects every call with store_not_configured", async () => {
    // Vercel production, an explicit APP_ENV, and a bare production build on another host (Hostinger with no variables).
    for (const env of [{ VERCEL_ENV: "production" }, { APP_ENV: "production" }, { NODE_ENV: "production" }]) {
      noRedis();
      deployEnv(env);
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
    }
  });

  it("local dev, tests, previews and the e2e suite keep the memory store", async () => {
    noRedis();
    const envs = [{}, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { NODE_ENV: "development" }, { APP_ENV: "test", NODE_ENV: "production" }];
    for (const env of envs) {
      deployEnv(env);
      vi.resetModules();
      const fresh = await import("@/lib/db");
      await fresh.db.set("launch:mem", JSON.stringify(env));
      expect(await fresh.db.get("launch:mem")).toBe(JSON.stringify(env));
    }
  });
});

describe("production never answers with the model mock (rule 431)", () => {
  it("no key in a production deployment is 'paused', never 'mock'; elsewhere the dev mock stays", async () => {
    const { modelState } = await import("@/lib/model");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    for (const env of [{}, { VERCEL_ENV: "preview" }, { NODE_ENV: "development" }, { APP_ENV: "test", NODE_ENV: "production" }]) {
      deployEnv(env);
      expect(modelState(), JSON.stringify(env)).toBe("mock");
    }
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [{ VERCEL_ENV: "production" }, { APP_ENV: "production" }, { NODE_ENV: "production" }]) {
      deployEnv(env);
      expect(modelState(), JSON.stringify(env)).toBe("paused");
    }
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
    // A production build on a host other than Vercel, with no deployment variable set.
    deployEnv({ NODE_ENV: "production" });
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

describe("the waitlist keeps email addresses out of the logs (rule 432)", () => {
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

describe("the auth forms never get stuck and say what went wrong (rule 433)", () => {
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

describe("password rules are not colour-only (rule 434)", () => {
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
    const rules = readFileSync("src/components/app/PasswordRules.tsx", "utf8");
    expect(rules).not.toMatch(/<ul[^>]*aria-live/);
    expect(rules).toMatch(/className="sr-only"> \(\{checks\[i\] \? T\.met : T\.unmet\}\)/);
    expect(rules).toMatch(/<p className="sr-only" aria-live="polite">\{rulesStatus\(checks, lang\)\}<\/p>/);
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    // The submit is no longer disabled by the rules: it stays focusable and is described by the rules list.
    expect(src).not.toMatch(/disabled=\{busy \|\|/);
    expect(src.match(/aria-disabled=\{/g)?.length).toBe(2);
    expect(src).toContain('aria-describedby={step === 2 ? "signup-rules" : undefined}');
    expect(src).toContain('aria-describedby="reset-rules"');
    expect(src.match(/<PasswordRules id="(signup|reset)-rules"/g)?.length).toBe(2);
  });

  it("the invite form (JoinForm) uses the same rules, no native minLength and an aria-disabled submit", () => {
    const src = readFileSync("src/components/app/JoinForm.tsx", "utf8");
    expect(src).toContain('<PasswordRules id="join-rules" rules={J.rules} checks={checks} lang={lang} />');
    expect(src).toContain("passwordChecks(pw)");
    expect(src).toContain("setErr(unmetRules(checks, J.rules, lang))");
    expect(src).not.toMatch(/minLength=\{8\}/);
    expect(src).not.toMatch(/<ul[^>]*aria-live/);
    expect(src).not.toMatch(/disabled=\{busy \|\| !ok\}/);
    expect(src).toContain('aria-disabled={!ok ? true : undefined} aria-describedby="join-rules"');
  });
});

describe("Cloudflare Turnstile on signup and forgot-password (rules 426-428)", () => {
  const SITE = "0x4AAAAAAAtestsitekey", SECRET = "0x4AAAAAAAtestsecret";
  const on = () => { vi.stubEnv("TURNSTILE_SITE_KEY", SITE); vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET); };
  const answer = (body: unknown, status = 200) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const fresh = () => `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@test.example`;
  afterEach(() => vi.restoreAllMocks());

  it("426: with either key unset nothing is checked (fail open) and the form gets no site key", async () => {
    const { turnstileSiteKey, verifyTurnstile } = await import("@/lib/turnstile");
    const signup = await import("@/app/api/auth/signup/route");
    const f = vi.spyOn(globalThis, "fetch");
    for (const [site, secret] of [["", ""], [SITE, ""], ["", SECRET]]) {
      vi.stubEnv("TURNSTILE_SITE_KEY", site);
      vi.stubEnv("TURNSTILE_SECRET_KEY", secret);
      expect(turnstileSiteKey()).toBeNull();
      expect(await verifyTurnstile(undefined, "1.2.3.4")).toBe("ok");
    }
    expect((await signup.POST(json("/api/auth/signup", "POST", { email: fresh(), password: "abc12345", name: "Open" }, ip()))).status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });

  it("426: signup without a token, or with a rejected one, is 400 captcha_failed and creates no account", async () => {
    on();
    signOut();
    const signup = await import("@/app/api/auth/signup/route");
    const { getUser } = await import("@/lib/auth");
    const f = answer({ success: false, "error-codes": ["invalid-input-response"] });
    const a = fresh(), b = fresh();
    const none = await signup.POST(json("/api/auth/signup", "POST", { email: a, password: "abc12345", name: "Bot" }, ip()));
    expect([none.status, ((await none.json()) as { error: string }).error]).toEqual([400, "captcha_failed"]);
    expect(f, "no token: nothing to ask Cloudflare").not.toHaveBeenCalled();
    const bad = await signup.POST(json("/api/auth/signup", "POST", { email: b, password: "abc12345", name: "Bot", turnstile: "forged-token" }, ip()));
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "captcha_failed"]);
    expect(await getUser(a)).toBeNull();
    expect(await getUser(b)).toBeNull();
    expect(jar().has("nashr_session")).toBe(false);
  });

  it("426: a passed check creates the account; the verify call goes to Cloudflare's fixed URL as a form with secret, token and IP", async () => {
    on();
    signOut();
    const signup = await import("@/app/api/auth/signup/route");
    const { getUser } = await import("@/lib/auth");
    const f = answer({ success: true });
    const email = fresh();
    const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Human", turnstile: "good-token" }, { "x-real-ip": "203.0.113.9" }));
    expect(res.status).toBe(200);
    expect(await getUser(email)).not.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    expect(init.signal, "a timeout bounds the call").toBeInstanceOf(AbortSignal);
    const form = new URLSearchParams(init.body as URLSearchParams);
    expect(Object.fromEntries(form)).toEqual({ secret: SECRET, response: "good-token", remoteip: "203.0.113.9" });
  });

  it("426: Cloudflare not answering, an error status or a non-JSON body is 503 captcha_unavailable; an overlong token is refused unasked", async () => {
    on();
    const { verifyTurnstile } = await import("@/lib/turnstile");
    const signup = await import("@/app/api/auth/signup/route");
    const down = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const res = await signup.POST(json("/api/auth/signup", "POST", { email: fresh(), password: "abc12345", name: "X", turnstile: "tok" }, ip()));
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([503, "captcha_unavailable"]);
    down.mockRestore();
    answer({ oops: true }, 500);
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe("unavailable");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe("unavailable");
    vi.restoreAllMocks();
    const f = answer({ success: true });
    expect(await verifyTurnstile("x".repeat(2049), "1.2.3.4")).toBe("failed");
    expect(await verifyTurnstile(["tok"], "1.2.3.4")).toBe("failed");
    expect(f).not.toHaveBeenCalled();
    // `success` must be literally true.
    answer({ success: "true" });
    expect(await verifyTurnstile("tok", "unknown")).toBe("failed");
  });

  it("427: forgot-password checks the token before the per-address limit and the lookup; a refusal reveals nothing", async () => {
    on();
    const forgot = await import("@/app/api/auth/forgot/route");
    const f = answer({ success: false });
    const target = fresh();
    for (let i = 0; i < 5; i++) {
      const res = await forgot.POST(json("/api/auth/forgot", "POST", { email: target, lang: "en" }, ip()));
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, "captcha_failed"]);
    }
    expect(f).not.toHaveBeenCalled();
    // Five refused tries did not use up the address's three links per 15 minutes.
    expect(await db.get(`rate:forgot:em:${target}`)).toBeNull();
    vi.restoreAllMocks();
    answer({ success: true });
    const ok = await forgot.POST(json("/api/auth/forgot", "POST", { email: target, lang: "en", turnstile: "good" }, ip()));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("427: the per-IP limit runs before the token check, so a flood of junk tokens from one IP stops calling Cloudflare", async () => {
    on();
    const forgot = await import("@/app/api/auth/forgot/route");
    // A fresh Response per call: a body can be read only once.
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ success: false }), { status: 200, headers: { "content-type": "application/json" } }));
    const one = ip();
    for (let i = 0; i < 8; i++) {
      const res = await forgot.POST(json("/api/auth/forgot", "POST", { email: fresh(), lang: "en", turnstile: `junk-${i}` }, one));
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, "captcha_failed"]);
    }
    expect(f).toHaveBeenCalledTimes(8);
    const ninth = await forgot.POST(json("/api/auth/forgot", "POST", { email: fresh(), lang: "en", turnstile: "junk-9" }, one));
    // Over the limit: the same silent answer as before, and no ninth siteverify call.
    expect(ninth.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(8);
  });

  it("427: the pages hand the form the site key only when both keys are set", () => {
    for (const page of ["signup", "forgot"]) {
      const src = readFileSync(`src/app/[lang]/app/${page}/page.tsx`, "utf8");
      expect(src).toContain("turnstileKey={turnstileSiteKey()}");
    }
    const form = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(form.match(/<Turnstile siteKey=\{turnstileKey\}/g)?.length).toBe(2);
    // The secret never reaches a client file.
    for (const f of ["src/components/app/AuthForm.tsx", "src/components/app/Turnstile.tsx"]) expect(readFileSync(f, "utf8")).not.toContain("TURNSTILE_SECRET_KEY");
  });

  it("428: the security headers do not block the Turnstile script or iframe", async () => {
    const config = (await import("../next.config")).default;
    const rules = await config.headers!();
    const csp = rules.flatMap((r) => r.headers).find((h) => h.key.toLowerCase() === "content-security-policy")?.value ?? "";
    for (const d of ["default-src", "script-src", "script-src-elem", "frame-src", "child-src", "connect-src"]) {
      const directive = csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${d} `));
      if (directive) expect(directive, `${d} must allow Turnstile`).toContain("https://challenges.cloudflare.com");
    }
    const { TURNSTILE_SCRIPT_URL, TURNSTILE_VERIFY_URL } = await import("@/lib/turnstile");
    expect(readFileSync("src/components/app/Turnstile.tsx", "utf8")).toContain(`"${TURNSTILE_SCRIPT_URL}"`);
    expect(TURNSTILE_VERIFY_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
  });
});
