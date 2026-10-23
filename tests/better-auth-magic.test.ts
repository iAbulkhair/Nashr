import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { MFA_COOKIE, mfaKey, type MfaEnrolment } from "@/lib/mfa";
import { getMember, saveMember } from "@/lib/team";
import { appDict } from "@/lib/app-i18n";
import { MAGIC_TOKEN, MAGIC_TTL_SECONDS, readMagicToken } from "@/lib/magic-token";
import { magicEligible, magicLinkFor, magicText } from "@/lib/better-auth/magic";
import { BA_ROUTES } from "@/lib/better-auth/handler";
import { baOptions } from "@/lib/better-auth/server";
import { appOrigin } from "@/lib/origin";
import { PERSON_PAGES, appHref, personPage } from "@/lib/ws-path";
import { EMAIL_TEMPLATES, renderEmail } from "@/emails";
import { LoginForm } from "@/components/app/AuthForm";
import * as route from "@/app/api/better-auth/[...all]/route";
import * as magicRoute from "@/app/api/auth/magic/route";
import MagicPage from "@/app/[lang]/app/magic/page";

/**
 * The magic link behind AUTH_ENGINE, step (c) of the better-auth migration (rules 3415-3417,
 * docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md section 6, docs/system/tests/3400-better-auth-orpc.md).
 */
type Mail = { to: string; subject: string; text: string; template?: string; context?: { link?: string }; locale?: string };
const sent: Mail[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => { sent.push((typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as Mail); return true; },
}));
let search = new URLSearchParams();
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => search,
}));

const SECRET = randomBytes(24).toString("hex");
const ORIGIN = "https://thakeen.com";
const on = () => { vi.stubEnv("AUTH_ENGINE", "better-auth"); vi.stubEnv("BETTER_AUTH_SECRET", SECRET); };
const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>"); };
beforeEach(() => { sent.length = 0; search = new URLSearchParams(); });
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

let ipN = 0;
/** Never repeats within a run, and never meets the IPs other test files use. */
const freshIp = () => { ipN++; return `192.0.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
const ask = (email: string, extra: Record<string, unknown> = {}, ip = freshIp()) =>
  route.POST(json("/api/better-auth/sign-in/magic-link", "POST", { email, lang: "en", ...extra }, { origin: ORIGIN, "x-forwarded-for": ip }));
const open = (token: unknown, ip = freshIp()) => magicRoute.POST(json("/api/auth/magic", "POST", { token }, { origin: ORIGIN, "x-forwarded-for": ip }));
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
const SAME = { status: 200, body: { ok: true, status: true, mail: true } };
const tokenIn = (m: Mail) => /#t=([A-Za-z]{32})$/m.exec(m.text)?.[1] ?? "";
/** Where the adapter keeps a link: the identifier better-auth builds from the hashed token, hashed again. */
const rowKey = (token: string) => globalKey.baVerify(createHash("sha256").update(`magic-link:${createHash("sha256").update(token).digest("base64url")}`).digest("hex"));
const verifyWrites = () => { const set = vi.spyOn(db, "set"); return () => set.mock.calls.filter(([k]) => String(k).startsWith("ba:verify:")).length; };
const enrol = (email: string) => db.set(mfaKey(email), { enc: "sealed", kid: "k", rc: [], at: new Date(Date.now() + 1000).toISOString() } satisfies MfaEnrolment);
/** A link mailed to `email` (the request went through), and the token it carries. */
async function linkFor(email: string): Promise<string> {
  sent.length = 0;
  expect(await answer(await ask(email))).toEqual(SAME);
  expect(sent).toHaveLength(1);
  signOut();
  return tokenIn(sent[0]);
}
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
const digestOf = (e: unknown) => String((e as { digest?: unknown } | null)?.digest ?? "");

describe("rule 3415: the link request, behind the switch, the same answer for every address", () => {
  it("off: the request, the verify route and the page are 404, before the store; nothing is mailed", async () => {
    mailOn();
    const u = await newUser("mo");
    const ip = "192.0.250.7";
    for (const env of [{ AUTH_ENGINE: "", BETTER_AUTH_SECRET: SECRET }, { AUTH_ENGINE: "legacy", BETTER_AUTH_SECRET: SECRET }, { AUTH_ENGINE: "better-auth", BETTER_AUTH_SECRET: "short" }]) {
      vi.stubEnv("AUTH_ENGINE", env.AUTH_ENGINE);
      vi.stubEnv("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
      expect(await answer(await ask(u.email, {}, ip))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
      if (env.AUTH_ENGINE !== "better-auth") {
        expect(await answer(await open("a".repeat(32), ip))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
        await expect(MagicPage({ params: Promise.resolve({ lang: "en" }) })).rejects.toSatisfy((e) => digestOf(e).startsWith("NEXT_HTTP_ERROR_FALLBACK;404"));
      }
    }
    expect(sent).toHaveLength(0);
    for (const k of [globalKey.magicIpBucket(ip), globalKey.magicEmailBucket(u.email), globalKey.loginIpBucket(ip)]) expect(await db.get(globalKey.rate(k))).toBeNull();
  });

  it("an owner who may sign in gets one mail in the form's language, the token in the fragment, stored only hashed", async () => {
    on(); mailOn();
    for (const lang of ["ar", "en"] as const) {
      const u = await newUser("ml");
      sent.length = 0;
      expect(await answer(await ask(u.email.toUpperCase(), { lang }))).toEqual(SAME);
      expect(sent).toHaveLength(1);
      const m = sent[0];
      expect(m.to).toBe(u.email);
      expect(m.template).toBe("magicLink");
      expect(m.locale).toBe(lang);
      const token = tokenIn(m);
      expect(token).toMatch(MAGIC_TOKEN);
      expect(m.context?.link).toBe(`${appOrigin()}/${lang}/app/magic#t=${token}`);
      expect(m.text).toContain(m.context!.link!);
      expect(m.text).not.toMatch(/[?&](token|t)=/);
      expect(m.subject).toBe(magicText(lang, "x").subject);
      // The row is under the hash of the hashed token; the token itself is stored nowhere.
      const row = await db.get<Record<string, unknown>>(rowKey(token));
      expect(row).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain(token);
      expect(await db.ttl(rowKey(token))).toBeLessThanOrEqual(MAGIC_TTL_SECONDS);
      expect(await db.ttl(rowKey(token))).toBeGreaterThan(MAGIC_TTL_SECONDS - 60);
    }
  });

  it("a member of a verified owner gets a link too", async () => {
    on(); mailOn();
    const o = await newUser("mo");
    const m = await newMember(o);
    expect(await answer(await ask(m.email))).toEqual(SAME);
    expect(sent.map((x) => x.to)).toEqual([m.email]);
  });

  it("an unknown address, a suspended account, an unverified owner, its member and a paused member: the same answer, no row, no mail", async () => {
    on(); mailOn();
    const suspended = await newUser("ms");
    await saveUser({ ...(await getUser(suspended.email))!, suspended: true });
    const unverified = await newUser("mu", { verified: false });
    const ofUnverified = await newMember(unverified);
    const o = await newUser("mp");
    const paused = await newMember(o, "member", "mp", { legacy: true });
    await saveMember({ ...(await getMember(paused.email))!, disabled: "seats" });
    const writes = verifyWrites();
    for (const email of [`nobody-${randomBytes(4).toString("hex")}@test.example`, suspended.email, unverified.email, ofUnverified.email, paused.email]) {
      expect([email, await answer(await ask(email))]).toEqual([email, SAME]);
    }
    expect(sent).toHaveLength(0);
    expect(writes()).toBe(0);
  });

  it("with mail off: the same answer with `mail: false`, and better-auth is not called", async () => {
    on();
    const u = await newUser("mn");
    const writes = verifyWrites();
    expect(await answer(await ask(u.email))).toEqual({ status: 200, body: { ok: true, status: true, mail: false } });
    expect(sent).toHaveLength(0);
    expect(writes()).toBe(0);
  });

  it("a malformed address is 400 bad_email; only the address and the language reach better-auth", async () => {
    on(); mailOn();
    for (const email of ["", "no-at", "a@b", 7]) expect(await answer(await ask(email as string))).toEqual({ status: 400, body: { ok: false, error: "bad_email" } });
    const u = await newUser("mb");
    // A callback, a name and the browser's own metadata are dropped: the mail links to Thakeen's page in `lang`.
    expect(await answer(await ask(u.email, { lang: "ar", callbackURL: "https://evil.example/x", name: "x", metadata: { lang: "en" } }))).toEqual(SAME);
    expect(sent[0].context?.link).toMatch(new RegExp(`^${appOrigin().replace(/[.]/g, "\\.")}/ar/app/magic#t=[A-Za-z]{32}$`));
    expect(sent[0].text).not.toContain("evil.example");
  });

  it("rate limits: 8 requests an IP and 3 an address per 15 minutes, each over the limit with the same answer and no mail", async () => {
    on(); mailOn();
    const ip = "192.0.251.9";
    const users = await Promise.all(Array.from({ length: 9 }, () => newUser("mr")));
    for (const u of users) expect(await answer(await ask(u.email, {}, ip))).toEqual(SAME);
    expect(sent).toHaveLength(8);
    sent.length = 0;
    const one = await newUser("mr");
    for (let i = 0; i < 4; i++) expect(await answer(await ask(one.email))).toEqual(SAME);
    expect(sent).toHaveLength(3);
  });

  it("Turnstile when configured: a missing token is refused and nothing is mailed", async () => {
    on(); mailOn();
    vi.stubEnv("TURNSTILE_SITE_KEY", "site");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const u = await newUser("mt");
    expect(await answer(await ask(u.email))).toEqual({ status: 400, body: { ok: false, error: "captcha_failed" } });
    expect(sent).toHaveLength(0);
  });

  it("the route is on the allow-list and the plugin is configured as the spec says", () => {
    expect(BA_ROUTES["/sign-in/magic-link"]).toEqual({ method: "POST", kind: "magic" });
    expect(BA_ROUTES["/magic-link/verify"]).toBeUndefined();
    const plugins = baOptions(SECRET).plugins as unknown as { id: string; options?: Record<string, unknown> }[];
    expect(plugins.map((p) => p.id)).toEqual(["magic-link"]);
    expect(plugins[0].options).toMatchObject({ expiresIn: MAGIC_TTL_SECONDS, storeToken: "hashed", disableSignUp: true });
    expect(MAGIC_TTL_SECONDS).toBe(900);
  });

  it("magicEligible: the log-in refusals and the owed address code", async () => {
    const { getLogin } = await import("@/lib/auth");
    const ok = await newUser("me");
    const owed = await newUser("me", { verified: false });
    expect(magicEligible(await getLogin(ok.email))).toBe(true);
    expect(magicEligible(await getLogin(owed.email))).toBe(false);
    expect(magicEligible(null)).toBe(false);
  });
});

describe("rule 3416: opening the link, once, through the session gate", () => {
  it("a press posts the token: a session in the legacy shape, the log-in answer, no token in it", async () => {
    on(); mailOn();
    const u = await newUser("mv");
    const token = await linkFor(u.email);
    const res = await answer(await open(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, verify: false, redirect: false, user: { email: u.email } });
    expect(keysOf(res.body)).not.toContain("token");
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(jar().get("thakeen_session")).toMatch(/^[0-9a-f]{64}$/);
    expect((await currentUser())!.email).toBe(u.email);
    expect(await db.get(rowKey(token))).toBeNull();
  });

  it("a member signs in as the member", async () => {
    on(); mailOn();
    const o = await newUser("mv");
    const m = await newMember(o);
    const token = await linkFor(m.email);
    expect((await answer(await open(token))).status).toBe(200);
    const me = (await currentUser())!;
    expect(me.actor?.kind).toBe("member");
    expect(me.actor?.email).toBe(m.email);
  });

  it("single use: the second press is bad_token, and so are two racing presses after the first wins", async () => {
    on(); mailOn();
    const u = await newUser("m1");
    const token = await linkFor(u.email);
    expect((await open(token)).status).toBe(200);
    signOut();
    expect(await answer(await open(token))).toEqual({ status: 401, body: { ok: false, error: "bad_token" } });
    expect(jar().get("thakeen_session")).toBeUndefined();
    const t2 = await linkFor(u.email);
    const both = await Promise.all([open(t2), open(t2)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("a malformed, unknown or expired token is bad_token and opens nothing", async () => {
    on(); mailOn();
    for (const t of ["", "abc", "a".repeat(31), "a".repeat(33), "a".repeat(31) + "1", 42, null]) {
      expect(await answer(await open(t))).toEqual({ status: 401, body: { ok: false, error: "bad_token" } });
    }
    expect(await answer(await open("Q".repeat(32)))).toEqual({ status: 401, body: { ok: false, error: "bad_token" } });
    const u = await newUser("mx");
    const token = await linkFor(u.email);
    const row = (await db.get<Record<string, unknown>>(rowKey(token)))!;
    await db.set(rowKey(token), { ...row, expiresAt: new Date(Date.now() - 1000).toISOString() }, 600);
    expect(await answer(await open(token))).toEqual({ status: 401, body: { ok: false, error: "bad_token" } });
    expect(jar().get("thakeen_session")).toBeUndefined();
  });

  it("the gate refuses what changed after the mail: a suspension, a paused member", async () => {
    on(); mailOn();
    const u = await newUser("mg");
    const t1 = await linkFor(u.email);
    await saveUser({ ...(await getUser(u.email))!, suspended: true });
    expect(await answer(await open(t1))).toEqual({ status: 403, body: { ok: false, error: "suspended" } });
    const o = await newUser("mg");
    const m = await newMember(o, "member", "mg", { legacy: true });
    const t2 = await linkFor(m.email);
    await saveMember({ ...(await getMember(m.email))!, disabled: "seats" });
    expect(await answer(await open(t2))).toEqual({ status: 403, body: { ok: false, error: "disabled" } });
    expect(jar().get("thakeen_session")).toBeUndefined();
  });

  it("two-step sign-in: the link is the first factor; no session, the challenge cookie, the code step", async () => {
    on(); mailOn();
    const u = await newUser("mf");
    await enrol(u.email);
    const token = await linkFor(u.email);
    expect(await answer(await open(token))).toEqual({ status: 401, body: { ok: false, error: "mfa_required", mfa: true } });
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(jar().get(MFA_COOKIE)).toBeTruthy();
  });

  it("the log-in IP bucket (20 per 15 minutes) guards the verify route", async () => {
    on();
    const ip = "192.0.252.3";
    for (let i = 0; i < 20; i++) expect((await open("a".repeat(32), ip)).status).toBe(401);
    const res = await open("a".repeat(32), ip);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
  });

  it("the page: 404 when off, the landing when on and signed out, the app when signed in", async () => {
    on();
    const el = await MagicPage({ params: Promise.resolve({ lang: "ar" }) });
    expect(isValidElement(el)).toBe(true);
    await expect(MagicPage({ params: Promise.resolve({ lang: "xx" }) })).rejects.toSatisfy((e) => digestOf(e).startsWith("NEXT_HTTP_ERROR_FALLBACK;404"));
    const u = await newUser("mq");
    await signIn(u.email);
    await expect(MagicPage({ params: Promise.resolve({ lang: "ar" }) })).rejects.toSatisfy((e) => digestOf(e).startsWith("NEXT_REDIRECT"));
  });

  it("the page reads the fragment once, clears it, and posts only on the press (mail scanners use nothing)", () => {
    const src = readFileSync("src/components/app/MagicLanding.tsx", "utf8");
    const landing = src.slice(src.indexOf("export function MagicLanding"));
    const effect = landing.slice(landing.indexOf("useEffect("), landing.indexOf("}, []);"));
    expect(effect).toContain("readMagicToken(window.location.hash)");
    expect(effect).toContain("window.history.replaceState(window.history.state, \"\", withoutFragment(window.location))");
    expect(effect).not.toMatch(/postJson|fetch\(/);
    expect(landing).toMatch(/async function onGo\(\) \{[\s\S]*?postJson\("\/api\/auth\/magic", \{ token: tokenRef\.current \}\)/);
    expect(landing).toMatch(/onClick=\{onGo\}/);
    expect(readMagicToken("#t=" + "a".repeat(32))).toBe("a".repeat(32));
    for (const h of ["", "#t=abc", "#t=" + "a".repeat(33), "#token=" + "a".repeat(32), "#t=" + "a".repeat(31) + "-"]) expect(readMagicToken(h)).toBe("");
  });

  it("the layout lets a signed-out visitor reach /magic only while the switch is on; it is a person page", () => {
    const src = readFileSync("src/app/[lang]/app/layout.tsx", "utf8");
    expect(src).toContain('const PUBLIC = ["/login", "/signup", "/forgot", "/reset", "/admin", "/join", "/verify"];');
    expect(src).toContain("(baOn() && path.endsWith(MAGIC))");
    expect(PERSON_PAGES).toContain("/magic");
    expect(personPage("/en/app/magic")).toBe(true);
    expect(appHref("en", "/magic", "w_abcdefghijklmnop")).toBe("/en/app/magic");
  });
});

describe("rule 3417: the log-in tab and the mail", () => {
  it("off: the log-in form is main's, with no tabs and the legacy route", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(createElement(LoginForm, { t: appDict[lang], lang }));
      expect(html).not.toContain('role="tablist"');
      expect(html).toContain('name="password"');
    }
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    const form = src.slice(src.indexOf("export function LoginForm"), src.indexOf("const PW ="));
    expect(form).toContain('postJson(betterAuth ? "/api/better-auth/sign-in/email" : "/api/auth/login", ');
    expect(form).toMatch(/\{betterAuth \? \([\s\S]*?\) : passwordForm\}/);
  });

  it("on: two tabs named in both languages, the password tab first, `?tab=link` opens the link tab", () => {
    const names = { ar: ["طريقة الدخول", "كلمة المرور", "رابط بالبريد"], en: ["How to sign in", "Password", "Email link"] } as const;
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(createElement(LoginForm, { t: appDict[lang], lang, betterAuth: true, passkeys: true }));
      expect(html).toContain(`role="tablist" aria-label="${names[lang][0]}"`);
      expect(html).toMatch(new RegExp(`id="login-tab-password" aria-selected="true"[^>]*>${names[lang][1]}<`));
      expect(html).toMatch(new RegExp(`id="login-tab-link" aria-selected="false"[^>]*>${names[lang][2]}<`));
      expect(html).toContain('id="login-panel-password"');
      expect(html).toContain('autoComplete="username webauthn"');
      search = new URLSearchParams("tab=link");
      const link = renderToStaticMarkup(createElement(LoginForm, { t: appDict[lang], lang, betterAuth: true, passkeys: true }));
      search = new URLSearchParams();
      expect(link).toContain('id="login-panel-link"');
      expect(link).not.toContain('name="password"');
      // The passkey offer lives in the password tab only.
      expect(link).not.toContain("webauthn");
    }
    // `?tab=link` means nothing with the switch off.
    search = new URLSearchParams("tab=link");
    expect(renderToStaticMarkup(createElement(LoginForm, { t: appDict.en, lang: "en" }))).toContain('name="password"');
  });

  it("the log-in page passes the switch and the Turnstile key only while it is on", () => {
    const page = readFileSync("src/app/[lang]/app/login/page.tsx", "utf8");
    expect(page).toContain("const betterAuth = baOn();");
    expect(page).toContain("betterAuth={betterAuth} turnstileKey={betterAuth ? turnstileSiteKey() : null}");
  });

  it("the mail template: Arabic right to left, English left to right, the button and the plain link", () => {
    expect(Object.keys(EMAIL_TEMPLATES)).toContain("magicLink");
    const link = magicLinkFor("ar", "c".repeat(32));
    const ar = renderEmail("magicLink", { link }, "ar");
    const en = renderEmail("magicLink", { link: magicLinkFor("en", "c".repeat(32)) }, "en");
    expect(ar).toContain('dir="rtl"');
    expect(ar).not.toContain('dir="ltr" style="direction:ltr;text-align:left');
    expect(ar).toContain("رابط الدخول إلى ذكين");
    expect(ar).toContain("15 دقيقة");
    expect(en).toContain('dir="ltr"');
    expect(en).toContain("Sign in to Thakeen");
    for (const html of [ar, en]) expect(html.split("#t=" + "c".repeat(32)).length - 1).toBeGreaterThanOrEqual(2);
    // The plain-text part says the same in each language.
    expect(magicText("ar", link).text).toContain(link);
    expect(magicText("en", link).text).toMatch(/15 minutes; it works once/);
  });
});
