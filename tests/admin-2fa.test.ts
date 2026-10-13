import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { base32, fromBase32, hotp, looksLikeRecovery, newRecoveryCode, newTotpSecret, otpauthUri, recoveryHash, totpMatch, totpStep } from "@/lib/totp";
import { ADMIN_2FA_COOKIE, CODE_TRIES_ALL, CODE_TRIES_PER_IP, ENROLMENT_KEY, PENDING_KEY, STEP_UP_IDLE, STEP_UP_MAX, openSecret, sealSecret, type Enrolment } from "@/lib/admin-2fa";
import { ADMIN_2FA_EVENT, secondFactorRetry, type SecondFactorAsk } from "@/lib/admin-fetch";
import { adminSignIn, jar, json, newUser, params, signIn } from "./helpers/session";
import * as twoFa from "@/app/api/admin/2fa/route";
import * as plan from "@/app/api/admin/plan/route";
import * as users from "@/app/api/admin/users/[email]/route";
import * as wishlist from "@/app/api/admin/wishlist/route";
import * as skills from "@/app/api/admin/skills/route";
import * as topups from "@/app/api/admin/topups/route";

/**
 * The founder console's second factor (360 study C-004, leftovers L055): rules 1370-1384 in
 * docs/system/tests/1370-admin-second-factor.md. Authenticator codes are computed here from the secret the setup hands
 * out, on a frozen clock, so every test chooses which 30-second step it is in.
 */
const KEY = "admin-2fa-test-key-0123456789";
let ipN = 0;
/** Every test its own address, so the per-IP code budget of one test never leaks into the next. */
let IP = "198.51.100.1";
const h = (extra: Record<string, string> = {}) => ({ "x-forwarded-for": IP, ...extra });
/** Each test a day of its own, so a step burned in one test (`admin2fa:used:{step}`) is never the next test's step. */
let T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const at = (ms: number) => vi.setSystemTime(new Date(ms));
const codeAt = (secret: string, ms: number) => hotp(fromBase32(secret)!, totpStep(ms));

const call = (body: unknown, headers: Record<string, string> = {}) => twoFa.POST(json("/api/admin/2fa", "POST", body, h(headers)));
const status = async () => (await twoFa.GET(json("/api/admin/2fa", "GET", undefined, h()))).json();
/** A founder write: one credit added to `email` through POST /api/admin/plan. */
const addCredit = (email: string, headers: Record<string, string> = {}) => plan.POST(json("/api/admin/plan", "POST", { email, addCredits: 1, reason: "test reason" }, h(headers)));

/** Start and confirm a setup in the current key session; returns the secret and the recovery code. */
async function enrol(now = T0): Promise<{ secret: string; recovery: string }> {
  at(now);
  const s = await (await call({ action: "start" })).json();
  expect(s.ok).toBe(true);
  const c = await (await call({ action: "confirm", code: codeAt(s.secret, now) })).json();
  expect(c.ok).toBe(true);
  return { secret: s.secret, recovery: c.recovery };
}

/** A founder signed in as themselves (ADMIN_EMAILS): a 30-day session, unlike the key session's 15 idle minutes. */
async function asFounder(): Promise<string> {
  const founder = await newUser("founder");
  vi.stubEnv("ADMIN_EMAILS", founder.email);
  const token = await signIn(founder.email);
  // The helper's record lives an hour; a real sign-in lives 30 days, and the 12-hour test needs that.
  await db.set(`session:${token}`, { email: founder.email, at: Date.now() }, 30 * 86_400);
  return founder.email;
}

let customer: User;
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); vi.stubEnv("CONNECT_SECRET", "admin-2fa-connect-secret"); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  IP = `198.51.100.${++ipN}`;
  T0 = Date.UTC(2026, 9, 12, 12, 0, 0) + ipN * 86_400_000;
  at(T0);
  await Promise.all([db.del(ENROLMENT_KEY), db.del(PENDING_KEY), db.del("rate:admin2fa:all")]);
  customer = await newUser("twofa");
  jar().clear();
  await adminSignIn();
});
afterEach(() => { vi.useRealTimers(); vi.stubEnv("ADMIN_EMAILS", ""); });

describe("authenticator codes are RFC 6238 without a dependency (rule 1370)", () => {
  it("matches the RFC 4226 and RFC 6238 SHA-1 test vectors", () => {
    const key = Buffer.from("12345678901234567890");
    expect(base32(key)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(fromBase32("gezd gnbv-gy3tqojqgezdgnbvgy3tqojq")!.equals(key)).toBe(true);
    expect(["755224", "287082", "359152"]).toEqual([0, 1, 2].map((c) => hotp(key, c)));
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(hotp(key, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(hotp(key, Math.floor(1234567890 / 30), 8)).toBe("89005924");
  });
  it("accepts the code one step either side of now and nothing further, and only six digits", () => {
    const s = newTotpSecret();
    expect(fromBase32(s)!.length).toBe(20);
    for (const d of [-1, 0, 1]) expect(totpMatch(s, codeAt(s, T0 + d * 30_000), T0)).toBe(totpStep(T0) + d);
    for (const d of [-3, -2, 2, 3]) expect(totpMatch(s, codeAt(s, T0 + d * 30_000), T0)).not.toBe(totpStep(T0) + d);
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) expect(totpMatch(s, bad, T0)).toBeNull();
    expect(otpauthUri(s, "founder console")).toMatch(new RegExp(`^otpauth://totp/Thakeen%3Afounder%20console\\?secret=${s}&issuer=Thakeen&algorithm=SHA1&digits=6&period=30$`));
  });
  it("package.json gains no TOTP dependency; its one QR dependency is uqr, which draws the setup code (rule 1624)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => /otp|speakeasy|authenticator/i.test(d))).toEqual([]);
    expect(Object.keys(pkg.dependencies).filter((d) => /qr/i.test(d))).toEqual(["uqr"]);
  });
});

describe("the secret is stored encrypted and the recovery code only as a hash (rules 1371, 1372)", () => {
  it("seals with AES-GCM under its own label; a different CONNECT_SECRET does not open it", () => {
    const s = newTotpSecret();
    const blob = sealSecret(s);
    expect(blob).not.toContain(s);
    expect(openSecret(blob)).toBe(s);
    vi.stubEnv("CONNECT_SECRET", "another-secret");
    expect(openSecret(blob)).toBeNull();
    vi.stubEnv("CONNECT_SECRET", "admin-2fa-connect-secret");
    expect(openSecret("not.a.blob")).toBeNull();
  });
  it("the enrolment record holds neither the secret nor the recovery code", async () => {
    const { secret, recovery } = await enrol();
    const rec = (await db.get<Enrolment>(ENROLMENT_KEY))!;
    const raw = JSON.stringify(rec);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(recovery.replace(/-/g, ""));
    expect(rec.rc).toBe(recoveryHash(recovery));
    expect(rec.by).toBe("key");
  });
  it("one recovery code of 100 bits in four groups of five", () => {
    const r = newRecoveryCode();
    expect(r).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
    expect(looksLikeRecovery(r.toLowerCase().replace(/-/g, " "))).toBe(true);
    expect(recoveryHash(r)).toBe(recoveryHash(r.toLowerCase().replace(/-/g, "")));
    expect(newRecoveryCode()).not.toBe(r);
  });
});

describe("rollout never locks the founder out (rule 1373)", () => {
  it("before enrolment every write works on the key alone, and the status says not enrolled", async () => {
    expect(await status()).toEqual({ ok: true, enrolled: false, at: null, stepUp: false });
    expect((await addCredit(customer.email)).status).toBe(200);
    expect((await getUser(customer.email))!.credits).toBe(customer.credits + 1);
  });
  it("a started setup enforces nothing until a code confirms it, and lapses after 15 minutes", async () => {
    expect((await call({ action: "start" })).status).toBe(200);
    expect((await status()).enrolled).toBe(false);
    expect((await addCredit(customer.email)).status).toBe(200);
    expect(await db.ttl(PENDING_KEY)).toBeLessThanOrEqual(900);
  });
});

describe("setup inside the console (rules 1374, 1375)", () => {
  it("confirms only with a code from the new secret, then answers the recovery code once", async () => {
    const s = await (await call({ action: "start" })).json();
    expect(s.uri).toContain(s.secret);
    const wrong = await call({ action: "confirm", code: codeAt(newTotpSecret(), T0) });
    expect([wrong.status, (await wrong.json()).error]).toEqual([400, "bad_code"]);
    const ok = await (await call({ action: "confirm", code: codeAt(s.secret, T0) })).json();
    expect(ok.recovery).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
    expect(await db.get(PENDING_KEY)).toBeNull();
    const st = await status();
    expect([st.enrolled, st.stepUp]).toEqual([true, true]);
    // Nothing more to confirm: the recovery code is never handed out again.
    expect((await call({ action: "confirm", code: codeAt(s.secret, T0 + 30_000) })).status).toBe(409);
  });
  it("a setup started by another actor cannot be confirmed by this one", async () => {
    await asFounder();
    const s = await (await call({ action: "start" })).json();
    jar().clear();
    await adminSignIn();
    expect((await call({ action: "confirm", code: codeAt(s.secret, T0) })).status).toBe(409);
  });
  it("replacing an enrolled authenticator needs the second factor first", async () => {
    await enrol();
    jar().delete(ADMIN_2FA_COOKIE);
    const r = await call({ action: "start" });
    expect([r.status, (await r.json()).error]).toEqual([403, "second_factor"]);
  });
  it("without CONNECT_SECRET in production nothing is enrolled and the console stays key-only", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONNECT_SECRET", "");
    const r = await call({ action: "start" });
    expect([r.status, (await r.json()).error]).toEqual([503, "no_secret_key"]);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CONNECT_SECRET", "admin-2fa-connect-secret");
    expect((await status()).enrolled).toBe(false);
  });
});

describe("after enrolment every founder write needs the second factor (rule 1376)", () => {
  it("money, plans, impersonation, skills and the wishlist answer 403 second_factor and change nothing", async () => {
    await enrol();
    jar().delete(ADMIN_2FA_COOKIE);
    const who = params({ email: encodeURIComponent(customer.email) });
    const res = await Promise.all([
      addCredit(customer.email),
      users.POST(json(`/api/admin/users/x`, "POST", { action: "impersonate", minutes: 60 }, h()), who),
      topups.POST(json("/api/admin/topups", "POST", { email: customer.email, action: "add", credits: 100 }, h())),
      skills.POST(json("/api/admin/skills", "POST", { action: "test" }, h())),
      skills.PUT(json("/api/admin/skills", "PUT", { items: [] }, h())),
      wishlist.POST(json("/api/admin/wishlist", "POST", { action: "promote", title: { ar: "عنوان", en: "Title" } }, h())),
    ]);
    for (const r of res) expect([r.status, (await r.json()).error]).toEqual([403, "second_factor"]);
    expect((await getUser(customer.email))!.credits).toBe(customer.credits);
  });
  it("every POST, PUT, PATCH and DELETE under /api/admin calls the gate, except the key form, impersonation stop, the 2FA route and marking leads seen", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === "route.ts") files.push(p); } };
    walk("src/app/api/admin");
    const exempt = ["login", "impersonate", "2fa", "leads"].map((s) => join("src/app/api/admin", s, "route.ts"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const writes = (src.match(/export (?:async )?function (POST|PUT|PATCH|DELETE)\b/g) ?? []).length;
      if (!writes || exempt.includes(f)) continue;
      expect((src.match(/await secondFactorRefusal\(req, who\)/g) ?? []).length, f).toBe(writes);
    }
  });
  it("reads stay on the key alone (rule 1382)", async () => {
    await enrol();
    jar().delete(ADMIN_2FA_COOKIE);
    expect((await plan.GET(json("/api/admin/plan", "GET", undefined, h()))).status).toBe(200);
    expect((await wishlist.GET(json("/api/admin/wishlist", "GET", undefined, h()))).status).toBe(200);
  });
});

describe("the step-up (rule 1377)", () => {
  it("a right code opens it; writes then pass until 30 idle minutes or 12 hours", async () => {
    await asFounder();
    const { secret } = await enrol();
    jar().delete(ADMIN_2FA_COOKIE);
    at(T0 + 60_000);
    const v = await (await call({ action: "verify", code: codeAt(secret, T0 + 60_000) })).json();
    expect(v).toEqual({ ok: true, via: "totp", stepUp: true });
    expect((await addCredit(customer.email)).status).toBe(200);
    // Kept alive by use, never past the absolute cap.
    let t = T0 + 60_000;
    while (t + (STEP_UP_IDLE - 60) * 1000 < T0 + STEP_UP_MAX * 1000) {
      t += (STEP_UP_IDLE - 60) * 1000;
      at(t);
      expect((await addCredit(customer.email)).status, `at +${(t - T0) / 60_000} min`).toBe(200);
    }
    at(T0 + 60_000 + STEP_UP_MAX * 1000);
    expect((await addCredit(customer.email)).status).toBe(403);
  });
  it("ends after 30 minutes without a write", async () => {
    await asFounder();
    await enrol();
    at(T0 + (STEP_UP_IDLE - 60) * 1000);
    expect((await addCredit(customer.email)).status).toBe(200);
    at(T0 + (2 * STEP_UP_IDLE - 120) * 1000);
    expect((await addCredit(customer.email)).status, "renewed by the write before").toBe(200);
    at(T0 + (3 * STEP_UP_IDLE) * 1000);
    expect((await addCredit(customer.email)).status).toBe(403);
  });
  it("is tied to the session it was opened in: a new key session, or another actor, does not inherit it", async () => {
    await enrol();
    const cookie = jar().get(ADMIN_2FA_COOKIE)!;
    jar().clear();
    await adminSignIn();
    jar().set(ADMIN_2FA_COOKIE, cookie);
    expect((await addCredit(customer.email)).status, "a new key session").toBe(403);
    await asFounder();
    jar().set(ADMIN_2FA_COOKIE, cookie);
    expect((await addCredit(customer.email)).status, "the founder's own sign-in").toBe(403);
  });
});

describe("codes are one-time and rate limited (rule 1378)", () => {
  it("the code that confirmed the setup cannot open a step-up in the same 30 seconds", async () => {
    const { secret } = await enrol();
    jar().delete(ADMIN_2FA_COOKIE);
    expect((await call({ action: "verify", code: codeAt(secret, T0) })).status).toBe(400);
    at(T0 + 30_000);
    expect((await call({ action: "verify", code: codeAt(secret, T0 + 30_000) })).status).toBe(200);
  });
  it(`${CODE_TRIES_PER_IP} wrong codes per IP in 15 minutes, then 429 with Retry-After even for the right one`, async () => {
    const { secret } = await enrol();
    at(T0 + 30_000);
    for (let i = 0; i < CODE_TRIES_PER_IP; i++) expect((await call({ action: "verify", code: "000000" })).status).toBe(400);
    const r = await call({ action: "verify", code: codeAt(secret, T0 + 30_000) });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("900");
  });
  it("right codes do not count against the budget", async () => {
    const { secret } = await enrol();
    for (let i = 1; i <= CODE_TRIES_PER_IP + 2; i++) {
      at(T0 + i * 30_000);
      expect((await call({ action: "verify", code: codeAt(secret, T0 + i * 30_000) })).status, `try ${i}`).toBe(200);
    }
  });
  it(`the whole console allows ${CODE_TRIES_ALL} wrong codes an hour, from any number of addresses`, async () => {
    await enrol();
    for (let i = 0; i < CODE_TRIES_ALL; i++) {
      IP = `203.0.113.${i}`;
      expect((await call({ action: "verify", code: "000000" })).status).toBe(400);
    }
    IP = "203.0.113.250";
    expect((await call({ action: "verify", code: "000000" })).status).toBe(429);
  });
});

describe("the recovery code (rule 1379)", () => {
  it("used once, it removes the enrolment and the console asks for a new setup; it never works twice", async () => {
    const { recovery } = await enrol();
    jar().delete(ADMIN_2FA_COOKIE);
    const r = await (await call({ action: "verify", code: recovery.toLowerCase() })).json();
    expect(r).toEqual({ ok: true, via: "recovery", stepUp: false });
    expect((await status()).enrolled).toBe(false);
    expect((await addCredit(customer.email)).status).toBe(200);
    expect((await call({ action: "verify", code: recovery })).status).toBe(409);
  });
  it("a wrong recovery code changes nothing", async () => {
    await enrol();
    expect((await call({ action: "verify", code: newRecoveryCode() })).status).toBe(400);
    expect((await status()).enrolled).toBe(true);
  });
});

describe("scripts on the key header send the code in x-admin-otp (rule 1380)", () => {
  it("a right 6-digit code passes one write; a recovery code in the header is refused and keeps the enrolment", async () => {
    const { secret, recovery } = await enrol();
    jar().clear();
    at(T0 + 30_000);
    expect((await addCredit(customer.email, { "x-admin-key": KEY })).status).toBe(403);
    expect((await addCredit(customer.email, { "x-admin-key": KEY, "x-admin-otp": codeAt(secret, T0 + 30_000) })).status).toBe(200);
    // Burned: the same code again is refused.
    expect((await addCredit(customer.email, { "x-admin-key": KEY, "x-admin-otp": codeAt(secret, T0 + 30_000) })).status).toBe(403);
    expect((await addCredit(customer.email, { "x-admin-key": KEY, "x-admin-otp": recovery })).status).toBe(403);
    expect(await db.get(ENROLMENT_KEY)).not.toBeNull();
  });
});

describe("the console asks for the code and sends the write again (rule 1381)", () => {
  const refused = () => new Response(JSON.stringify({ ok: false, error: "second_factor" }), { status: 403 });
  const g = globalThis as { window?: unknown };
  let target: EventTarget;
  beforeEach(() => { target = new EventTarget(); g.window = target; });
  afterEach(() => { delete g.window; });

  it("re-sends once the prompt says the step-up is open", async () => {
    target.addEventListener(ADMIN_2FA_EVENT, (e) => { const a = (e as CustomEvent<SecondFactorAsk>).detail; a.handled = true; setTimeout(() => a.done(true), 0); });
    const again = vi.fn(async () => new Response("{}", { status: 200 }));
    expect((await secondFactorRetry(refused(), again)).status).toBe(200);
    expect(again).toHaveBeenCalledTimes(1);
  });
  it("gives the 403 back when the founder cancels, or when no prompt is on the page", async () => {
    const again = vi.fn(async () => new Response("{}", { status: 200 }));
    expect((await secondFactorRetry(refused(), again)).status).toBe(403);
    target.addEventListener(ADMIN_2FA_EVENT, (e) => { const a = (e as CustomEvent<SecondFactorAsk>).detail; a.handled = true; a.done(false); });
    expect((await secondFactorRetry(refused(), again)).status).toBe(403);
    expect(again).not.toHaveBeenCalled();
  });
  it("leaves every other answer alone", async () => {
    const again = vi.fn();
    for (const r of [new Response("{}", { status: 200 }), new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }), new Response("not json", { status: 403 })]) {
      expect(await secondFactorRetry(r, again)).toBe(r);
    }
    expect(again).not.toHaveBeenCalled();
  });
});

describe("audit and the console's banner (rules 1383, 1384)", () => {
  it("setup and recovery are in admin:log under system, without the secret or any code", async () => {
    const { secret, recovery } = await enrol();
    await call({ action: "verify", code: recovery });
    const rows = (await db.lrange("admin:log", 0, 5)).join("\n");
    expect(rows).toContain("2fa.enrol");
    expect(rows).toContain("2fa.recovery");
    expect(rows).not.toContain(secret);
    expect(rows).not.toContain(recovery.replace(/-/g, "").slice(0, 10));
  });
  it("the console layout renders the banner, setup and prompt on every page behind the gate", () => {
    const layout = readFileSync("src/app/[lang]/admin/layout.tsx", "utf8");
    expect(layout).toContain("<SecondFactor lang={lang} enrolled={sf.enrolled} />");
    expect(layout).toContain("secondFactorStatus()");
    const sf = readFileSync("src/components/admin/SecondFactor.tsx", "utf8");
    expect(sf).toContain("ADMIN_2FA_EVENT");
    expect(sf).toContain("a.handled = true");
  });
});
