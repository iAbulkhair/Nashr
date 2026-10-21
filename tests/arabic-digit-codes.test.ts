import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { westernDigits } from "@/lib/verify-client";
import { fromBase32, hotp, newTotpSecret, totpMatch, totpStep } from "@/lib/totp";
import { ENROLMENT_KEY, PENDING_KEY } from "@/lib/admin-2fa";
import { adminSignIn, jar, json, newUser, signIn, signOut } from "./helpers/session";
import { codeAt as staffCodeAt } from "./helpers/staff";
import * as consoleTwoFa from "@/app/api/admin/2fa/route";
import * as accountTwoFa from "@/app/api/account/2fa/route";

/**
 * Authenticator codes typed in Arabic digits (rules 2610-2612, docs/system/tests/2610-arabic-digit-codes.md). The
 * founder typed the console setup code on an Arabic keyboard (١٢٣٤٥٦) and every code was refused as wrong: `\d` matches
 * only 0-9, in the server's six-digit checks and in the setup field's `pattern`.
 */
const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";
const arabic = (c: string) => c.replace(/\d/g, (d) => AR[Number(d)]);
const persian = (c: string) => c.replace(/\d/g, (d) => FA[Number(d)]);
const read = (f: string) => readFileSync(f, "utf8");

let ipN = 0;
let IP = "203.0.113.1";
let T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const at = (ms: number) => vi.setSystemTime(new Date(ms));
const codeAt = (secret: string, ms: number) => hotp(fromBase32(secret)!, totpStep(ms));
const consoleCall = (body: unknown) => consoleTwoFa.POST(json("/api/admin/2fa", "POST", body, { "x-forwarded-for": IP }));

beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", "arabic-digits-test-key-0123456789"); vi.stubEnv("CONNECT_SECRET", "arabic-digits-connect-secret"); });
afterEach(() => { vi.useRealTimers(); signOut(); });

describe("rule 2610: Arabic-Indic and Persian digits read as 0-9 wherever an authenticator code is checked", () => {
  it("westernDigits maps both digit sets and leaves every other character alone", () => {
    expect(westernDigits(AR)).toBe("0123456789");
    expect(westernDigits(FA)).toBe("0123456789");
    expect(westernDigits("١2٣ ۴5-x")).toBe("123 45-x");
    expect(westernDigits("ABCDE-FGHIJ")).toBe("ABCDE-FGHIJ");
  });
  it("totpMatch takes the same code in Western, Arabic-Indic or Persian digits, and still nothing but six digits", () => {
    const s = newTotpSecret();
    const c = codeAt(s, T0);
    for (const typed of [c, arabic(c), persian(c), `${arabic(c).slice(0, 3)} ${arabic(c).slice(3)}`]) expect(totpMatch(s, typed, T0)).toBe(totpStep(T0));
    expect(totpMatch(s, arabic(c).slice(0, 5), T0)).toBeNull();
    expect(totpMatch(s, `${arabic(c)}١`, T0)).toBeNull();
  });
});

describe("rule 2611: the founder console setup and code prompt accept a code typed in Arabic digits", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    IP = `203.0.113.${++ipN}`;
    T0 = Date.UTC(2026, 9, 21, 12, 0, 0) + ipN * 86_400_000;
    at(T0);
    await Promise.all([db.del(ENROLMENT_KEY), db.del(PENDING_KEY), db.del("rate:admin2fa:all")]);
    jar().clear();
    await adminSignIn();
  });
  it("confirm with ١٢٣٤٥٦-style digits enrols, and the code prompt takes them too", async () => {
    const s = await (await consoleCall({ action: "start" })).json();
    const ok = await (await consoleCall({ action: "confirm", code: arabic(codeAt(s.secret, T0)) })).json();
    expect(ok.ok).toBe(true);
    expect(ok.recovery).toBeTruthy();
    at(T0 + 60_000);
    const v = await (await consoleCall({ action: "verify", code: persian(codeAt(s.secret, T0 + 60_000)) })).json();
    expect([v.ok, v.via]).toEqual([true, "totp"]);
  });
  it("a wrong code in Arabic digits is still wrong", async () => {
    const s = await (await consoleCall({ action: "start" })).json();
    expect(s.ok).toBe(true);
    const r = await consoleCall({ action: "confirm", code: arabic(codeAt(newTotpSecret(), T0)) });
    expect([r.status, (await r.json()).error]).toEqual([400, "bad_code"]);
    expect(await db.get(ENROLMENT_KEY)).toBeNull();
  });
});

describe("rule 2612: customer and staff codes too, and the browser no longer blocks Arabic digits before sending", () => {
  it("a customer confirms the two-step setup with Arabic digits", async () => {
    const u = await newUser("ardigits");
    await signIn(u.email);
    const call = (body: Record<string, unknown>) => accountTwoFa.POST(json("/api/account/2fa", "POST", body, { "x-forwarded-for": `203.0.113.${200 + (++ipN % 50)}` }));
    const s = await (await call({ action: "start", password: "abc12345" })).json();
    const c = await (await call({ action: "confirm", code: arabic(staffCodeAt(s.secret)) })).json();
    expect(c.ok).toBe(true);
  });
  it("every server check of a typed authenticator code reads the digits first", () => {
    expect(read("src/lib/totp.ts")).toMatch(/const given = westernDigits\(code\)/);
    expect(read("src/lib/mfa.ts")).toMatch(/const code = westernDigits\(typed\);\n\s+if \(!\/\^\\d\{6\}\$\/\.test\(code\)\)/);
    expect(read("src/lib/staff-code.ts")).toMatch(/westernDigits\(typed\)/);
    expect(read("src/lib/staff-admin.ts")).toMatch(/westernDigits\(raw\)/);
    expect(read("src/app/api/admin/staff/login/route.ts")).toMatch(/westernDigits\(b\.code\)/);
  });
  it("the console setup field's pattern takes Arabic digits, and the customer confirm button is enabled by them", () => {
    const sf = read("src/components/admin/SecondFactor.tsx");
    // Written with \u escapes (rule 1584: no Arabic-Indic digit in UI source); the browser reads them in the pattern.
    const pattern = JSON.parse(/pattern=\{("[^"]+")\}/.exec(sf)![1]) as string;
    // Browsers compile `pattern` with the `v` flag and anchor it whole.
    const field = new RegExp(`^(?:${pattern})$`, "v");
    for (const ok of ["123456", "١٢٣٤٥٦", "۱۲۳۴۵۶"]) expect(field.test(ok)).toBe(true);
    for (const bad of ["12345", "abcdef", "١٢٣٤٥"]) expect(field.test(bad)).toBe(false);
    expect(read("src/components/app/settings/TwoStepSettings.tsx")).toMatch(/valid=\{\/\^\\d\{6\}\$\/\.test\(westernDigits\(code\)/);
  });
});
