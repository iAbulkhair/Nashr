import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isLastUsed, isLoginMethod, LAST_LOGIN_MAX_AGE, LAST_USED_TEXT, lastUsedCookie, LOGIN_METHODS, readLastUsed } from "@/lib/last-used-method";
import { LAST_LOGIN_COOKIE } from "@/lib/cookie-names";
import * as loginRoute from "@/app/api/auth/login/route";
import { jar, json, newUser, signOut, withHeaders } from "./helpers/session";

/**
 * "Last used" sign-in hint (rules 3103-3105, docs/system/tests/3100-auth-mail-polish.md): after a successful sign-in the
 * server remembers only the method's name in a small, non-secret, non-HttpOnly cookie, and the sign-in form tags that
 * button. The value is one of three words; anything else reads as no hint.
 */

type CookieCall = { op: string; name: string; options: Record<string, unknown> };
const calls = () => (globalThis as unknown as { __testCookieCalls: CookieCall[] }).__testCookieCalls;
afterEach(() => { signOut(); vi.unstubAllEnvs(); });

describe("rule 3103: the helper reads and writes only a method name", () => {
  it("knows exactly three methods", () => {
    expect([...LOGIN_METHODS]).toEqual(["password", "google", "passkey"]);
    for (const m of LOGIN_METHODS) expect(isLoginMethod(m)).toBe(true);
    for (const v of ["", "Password", "sms", "google ", null, undefined, 1, {}]) expect(isLoginMethod(v)).toBe(false);
  });

  it("reads the method from a cookie header and nothing else", () => {
    expect(readLastUsed(`a=1; ${LAST_LOGIN_COOKIE}=google; b=2`)).toBe("google");
    expect(readLastUsed(`${LAST_LOGIN_COOKIE}=passkey`)).toBe("passkey");
    expect(readLastUsed(`${LAST_LOGIN_COOKIE}=password`)).toBe("password");
    for (const h of [null, undefined, "", "x=google", `${LAST_LOGIN_COOKIE}=sms`, `${LAST_LOGIN_COOKIE}=google%3Cscript%3E`, `${LAST_LOGIN_COOKIE}=<b>password</b>`, `${LAST_LOGIN_COOKIE}=googlepasskey`])
      expect(readLastUsed(h), String(h)).toBeNull();
  });

  it("the cookie is a display hint: readable by the page, never a credential", () => {
    const c = lastUsedCookie("google", true);
    expect(c).toEqual({ name: LAST_LOGIN_COOKIE, value: "google", options: { httpOnly: false, sameSite: "lax", secure: true, path: "/", maxAge: LAST_LOGIN_MAX_AGE } });
    expect(lastUsedCookie("password", false).options.secure).toBe(false);
    expect(LAST_LOGIN_COOKIE).toBe("thakeen_last_login");
    expect(LAST_LOGIN_COOKIE).not.toMatch(/session|token|nashr/);
  });

  it("tags only the stored method, in Arabic and English", () => {
    expect(isLastUsed("google", "google")).toBe(true);
    expect(isLastUsed("google", "password")).toBe(false);
    expect(isLastUsed(null, "password")).toBe(false);
    expect(LAST_USED_TEXT).toEqual({ ar: "آخر ما استخدمت", en: "Last used" });
  });
});

describe("rule 3104: the server writes the hint after a successful sign-in only", () => {
  let ipN = 0;
  const login = (email: string, password: string) => {
    const addr = `198.51.100.${(++ipN % 250) + 1}`;
    return withHeaders({ "x-forwarded-for": addr }, () => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": addr })));
  };

  it("a password sign-in sets the cookie to password, not HttpOnly", async () => {
    const u = await newUser("lastpw");
    signOut();
    calls().length = 0;
    const r = await login(u.email, "abc12345");
    expect(r.status).toBe(200);
    expect(jar().get(LAST_LOGIN_COOKIE)).toBe("password");
    const set = calls().filter((c) => c.op === "set" && c.name === LAST_LOGIN_COOKIE);
    expect(set).toHaveLength(1);
    expect(set[0].options).toMatchObject({ httpOnly: false, sameSite: "lax", path: "/" });
  });

  it("a wrong password leaves no hint", async () => {
    const u = await newUser("lastbad");
    signOut();
    calls().length = 0;
    const r = await login(u.email, "wrong-pass1");
    expect(r.status).not.toBe(200);
    expect(jar().has(LAST_LOGIN_COOKIE)).toBe(false);
    expect(calls().some((c) => c.name === LAST_LOGIN_COOKIE)).toBe(false);
  });

  it("every sign-in finisher names its method: finishLogin, Google sign-up and password sign-up", () => {
    const finish = readFileSync("src/lib/login-finish.ts", "utf8");
    expect(finish).toMatch(/await createSession\(email\);\s*\n\s*await rememberLoginMethod\(opts\.via\);/);
    expect(readFileSync("src/app/api/auth/google/callback/route.ts", "utf8")).toMatch(/rememberLoginMethod\("google"\)/);
    expect(readFileSync("src/app/api/auth/signup/route.ts", "utf8")).toMatch(/rememberLoginMethod\("password"\)/);
  });
});

describe("rule 3105: the sign-in form tags the last-used button", () => {
  it("reads the cookie on the client only and tags password, Google and passkey", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(src).toMatch(/readLastUsed\(document\.cookie\)/);
    expect(src).toMatch(/useSyncExternalStore\(noChange, lastUsedNow, noHintOnServer\)/);
    for (const m of ["password", "google", "passkey"]) expect(src, m).toMatch(new RegExp(`method="${m}"`));
    expect(src).toMatch(/LAST_USED_TEXT\[lang\]/);
  });
});
