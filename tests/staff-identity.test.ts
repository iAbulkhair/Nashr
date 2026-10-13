import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { newTotpSecret } from "@/lib/totp";
import {
  COMMON_PASSWORDS, DUMMY_HASH, RECOVERY_CODES, STAFF_BCRYPT_COST, canWrite, getStaff, hashStaffPassword, listStaff, newRecoveryCodes,
  openStaffSecret, passwordRefusal, recoveryIndex, sealStaffSecret, staffKey, staffPasswordMatches, type Staff,
} from "@/lib/staff";
import { kidOf } from "@/lib/connectors/store";
import { jar, newUser } from "./helpers/session";
import { codeAt, enrolledStaff, freshIp, makeStaff, staffAddress, staffCode, staffEnrol, staffLogin, staffSetup } from "./helpers/staff";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STAFF_COOKIE, STAFF_PRE_COOKIE, readStaffSession } from "@/lib/staff-session";
import { STAFF_LOCK_AFTER, getStaff as readStaff, issueSetupCode, staffFailKey } from "@/lib/staff";
import { adminSignIn } from "./helpers/session";

/**
 * Staff identity, phase 1 (docs/specs/2026-10-13-staff-identity.md, rules 1630-1654 in
 * docs/system/tests/1630-staff-identity.md). The session, cookie and gate rules are in tests/staff-session.test.ts and
 * tests/launch-security.test.ts.
 */
const KEY = "staff-identity-test-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); vi.stubEnv("CONNECT_SECRET", "staff-connect-secret-one"); });
beforeEach(() => { jar().clear(); });
afterEach(() => { vi.stubEnv("CONNECT_SECRET", "staff-connect-secret-one"); vi.stubEnv("CONNECT_SECRET_PREVIOUS", ""); });

describe("staff records are their own type (rule 1630)", () => {
  it("a staff record lives at staff:{email}, is indexed, and is never a customer User", async () => {
    const s = await makeStaff();
    expect(await db.get(staffKey(s.email))).toMatchObject({ email: s.email, role: "owner" });
    expect((await listStaff()).map((x) => x.email)).toContain(s.email);
    expect(await getUser(s.email)).toBeNull();
    expect(await getStaff(s.email.toUpperCase())).toMatchObject({ email: s.email });
    expect(await getStaff("not an address")).toBeNull();
  });
  it("only owner writes; support and unknown roles fail closed (rule 1637)", () => {
    expect(canWrite("owner")).toBe(true);
    for (const r of ["support", "admin", "", undefined, null, "OWNER"]) expect(canWrite(r)).toBe(false);
  });
});

describe("staff passwords (rule 1641)", () => {
  it("12-128 characters, not common, bcrypt cost 12", async () => {
    const e = staffAddress();
    expect(await passwordRefusal(e, "short-pass1")).toBe("password_short");
    expect(await passwordRefusal(e, "x".repeat(129))).toBe("password_long");
    expect(await passwordRefusal(e, "Password1234")).toBe("password_common");
    expect([...COMMON_PASSWORDS].every((p) => p === p.toLowerCase())).toBe(true);
    expect(await passwordRefusal(e, "a long and unusual phrase")).toBeNull();
    const h = await hashStaffPassword("a long and unusual phrase");
    expect(bcrypt.getRounds(h)).toBe(STAFF_BCRYPT_COST);
    expect(bcrypt.getRounds(DUMMY_HASH)).toBe(12);
  });
  it("refused when it equals the customer password of the same address", async () => {
    const u = await newUser("dual");
    const same = "customer password twelve";
    await db.set(`user:${u.email}`, { ...(await getUser(u.email))!, passHash: await bcrypt.hash(same, 10) });
    expect(await passwordRefusal(u.email, same)).toBe("password_customer");
    expect(await passwordRefusal(u.email, "a different long phrase")).toBeNull();
  });
  it("the compare runs against the dummy hash for an unknown address or an unset password", async () => {
    const spy = vi.spyOn(bcrypt, "compare");
    expect(await staffPasswordMatches(null, "anything at all here")).toBe(false);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(DUMMY_HASH);
    const s = await makeStaff();
    expect(await staffPasswordMatches(s, "anything at all here")).toBe(false);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(DUMMY_HASH);
    spy.mockRestore();
    const withPw = await makeStaff({ passHash: await hashStaffPassword("the right long phrase") });
    expect(await staffPasswordMatches(withPw, "the right long phrase")).toBe(true);
    expect(await staffPasswordMatches(withPw, "the wrong long phrase")).toBe(false);
  });
});

describe("recovery codes (rule 1642)", () => {
  it("8 codes, stored only as hashes, each matched once", () => {
    const { codes, rc } = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODES);
    expect(new Set(codes).size).toBe(RECOVERY_CODES);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
    expect(JSON.stringify(rc)).not.toContain(codes[0].replace(/-/g, ""));
    expect(recoveryIndex(rc, codes[3].toLowerCase().replace(/-/g, " "))).toBe(3);
    expect(recoveryIndex(rc.filter((_, i) => i !== 3), codes[3])).toBe(-1);
    expect(recoveryIndex(undefined, codes[0])).toBe(-1);
  });
});

describe("authenticator secrets are sealed with a kid (rule 1654)", () => {
  it("seals under its own label and opens with the previous key after a rotation", () => {
    const secret = newTotpSecret();
    const t = sealStaffSecret(secret);
    expect(t.enc).not.toContain(secret);
    expect(t.kid).toBe(kidOf("staff-connect-secret-one"));
    expect(openStaffSecret(t)).toEqual({ secret, stale: false });
    vi.stubEnv("CONNECT_SECRET", "staff-connect-secret-two");
    expect(openStaffSecret(t)).toBeNull();
    vi.stubEnv("CONNECT_SECRET_PREVIOUS", "staff-connect-secret-one");
    expect(openStaffSecret(t)).toEqual({ secret, stale: true });
    const again = sealStaffSecret(secret);
    expect(again.kid).toBe(kidOf("staff-connect-secret-two"));
    expect(openStaffSecret(again)).toEqual({ secret, stale: false });
  });
  it("never opens the console's admin:2fa blob or a damaged one", async () => {
    const { sealSecret } = await import("@/lib/admin-2fa");
    const s = newTotpSecret();
    expect(openStaffSecret({ enc: sealSecret(s), kid: kidOf("staff-connect-secret-one") })).toBeNull();
    expect(openStaffSecret({ enc: "not.a.blob", kid: "x" })).toBeNull();
    expect(openStaffSecret(null)).toBeNull();
  });
});

const PW = "correct horse battery staple";
let pwHash = "";
async function withPassword(over: Partial<Staff> = {}) {
  pwHash ||= await hashStaffPassword(PW);
  return enrolledStaff({ passHash: pwHash, ...over });
}
const logRows = async () => (await db.lrange("admin:log", 0, 50)).map((r) => JSON.parse(r) as { action?: string; target?: string; actor?: string; via?: string });

describe("staff sign-in refuses alike (rule 1631)", () => {
  it("unknown, wrong password, no password yet, disabled and locked get the same 401 invalid", async () => {
    const { staff } = await withPassword();
    const { staff: off } = await withPassword({ disabled: true });
    const noPw = await makeStaff();
    const { staff: locked } = await withPassword();
    await db.set(staffFailKey(locked.email), STAFF_LOCK_AFTER, 900);
    const answers = await Promise.all([
      staffLogin(staffAddress("nobody"), PW), staffLogin(staff.email, "the wrong long phrase"), staffLogin(noPw.email, PW),
      staffLogin(off.email, PW), staffLogin(locked.email, PW), staffLogin("not-an-address", PW), staffLogin(staff.email, undefined),
    ]);
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(answers.map((r) => r.status)).toEqual(Array(7).fill(401));
    expect(new Set(bodies)).toEqual(new Set(['{"ok":false,"error":"invalid"}']));
    expect(jar().has(STAFF_PRE_COOKIE)).toBe(false);
    expect(jar().has(STAFF_COOKIE)).toBe(false);
  });
  it("an unknown address still costs one bcrypt compare against the dummy hash", async () => {
    const spy = vi.spyOn(bcrypt, "compare");
    await staffLogin(staffAddress("ghost"), PW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(DUMMY_HASH);
    spy.mockRestore();
  });
  it("5 tries per IP per 15 minutes; a right password gives its hit back", async () => {
    const { staff } = await withPassword();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await staffLogin(staff.email, i === 0 ? PW : "the wrong long phrase", ip)).status).toBe(i === 0 ? 200 : 401);
    expect((await staffLogin(staff.email, "the wrong long phrase", ip)).status).toBe(401);
    const r = await staffLogin(staff.email, PW, ip);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ ok: false, error: "slow_down" });
  });
});

describe("no staff session without a code (rule 1632)", () => {
  it("a right password opens only the pre-auth step; the code opens the session; a used code is refused", async () => {
    const { staff, secret } = await withPassword();
    expect(await staffCode("123456")).toMatchObject({ status: 401 });
    const a = await staffLogin(staff.email, PW);
    expect(await a.json()).toEqual({ ok: true, next: "code" });
    expect(jar().get(STAFF_PRE_COOKIE)).toMatch(/^[0-9a-f]{64}$/);
    expect(jar().has(STAFF_COOKIE)).toBe(false);
    expect(await readStaffSession()).toBeNull();
    expect((await staffEnrol({ action: "start" })).status).toBe(401); // stage is "code": no enrolment, no skip
    expect((await staffCode("000000")).status).toBe(400);
    const code = codeAt(secret);
    expect(await (await staffCode(code)).json()).toEqual({ ok: true });
    expect(await readStaffSession()).toMatchObject({ email: staff.email });
    expect(jar().get(STAFF_PRE_COOKIE)).toBe("");
    expect((await readStaff(staff.email))!.lastSignInAt).toBeTruthy();
    // The same code again, from a fresh password step: burned.
    await staffLogin(staff.email, PW);
    expect(await (await staffCode(code)).json()).toEqual({ ok: false, error: "bad_code" });
    expect((await logRows()).some((r) => r.action === "staff.signin" && r.target === staff.email && r.via === "staff")).toBe(true);
  });
  it("the first sign-in must enrol: start, confirm with a code, 8 recovery codes, then a session", async () => {
    const s = await makeStaff({ passHash: (pwHash ||= await hashStaffPassword(PW)) });
    expect(await (await staffLogin(s.email, PW)).json()).toEqual({ ok: true, next: "enrol" });
    expect((await staffCode("123456")).status).toBe(401); // no authenticator: the code step is not open
    const st = await (await staffEnrol({ action: "start" })).json();
    expect(st.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(await readStaffSession()).toBeNull();
    expect((await staffEnrol({ action: "confirm", code: "000000" })).status).toBe(400);
    const c = await (await staffEnrol({ action: "confirm", code: codeAt(st.secret) })).json();
    expect(c.ok).toBe(true);
    expect(c.codes).toHaveLength(8);
    const rec = (await readStaff(s.email))!;
    expect(rec.totp?.kid).toBeTruthy();
    expect(JSON.stringify(rec)).not.toContain(st.secret);
    expect(rec.rc).toHaveLength(8);
    expect(await readStaffSession()).toMatchObject({ email: s.email });
  });
});

describe("recovery codes at sign-in (rule 1642)", () => {
  it("needs the password first, is spent once, and forces a new authenticator before any session", async () => {
    const { codes, rc } = newRecoveryCodes();
    const { staff } = await withPassword({ rc });
    await staffLogin(staff.email, PW);
    expect(await (await staffCode(codes[2])).json()).toEqual({ ok: true, next: "enrol" });
    expect((await readStaff(staff.email))!.rc).toHaveLength(7);
    expect((await readStaff(staff.email))!.totp).toBeTruthy(); // the old one stays until a new one is confirmed
    expect(await readStaffSession()).toBeNull();
    expect((await staffCode(codeAt("AAAA"))).status).toBe(401); // the step is now "enrol"
    await staffLogin(staff.email, PW);
    expect(await (await staffCode(codes[2])).json()).toEqual({ ok: false, error: "bad_code" });
    expect((await logRows()).some((r) => r.action === "staff.recovery" && r.target === staff.email)).toBe(true);
  });
});

describe("setup codes and no email recovery (rules 1640, 1643)", () => {
  it("a setup code works once, for its own address, after the password policy; a reset removes the authenticator", async () => {
    const { staff } = await withPassword();
    const code = await issueSetupCode(staff.email, "key", "reset");
    expect((await staffSetup({ email: staffAddress(), code, password: "a brand new long phrase" })).status).toBe(401);
    expect(await (await staffSetup({ email: staff.email, code, password: "short" })).json()).toEqual({ ok: false, error: "password_short" });
    expect(await (await staffSetup({ email: staff.email, code, password: "a brand new long phrase" })).json()).toEqual({ ok: true, next: "enrol" });
    const rec = (await readStaff(staff.email))!;
    expect(rec.totp).toBeUndefined();
    expect(rec.rc).toBeUndefined();
    expect(rec.sessionsAfter).toBeTruthy();
    expect(await bcrypt.compare("a brand new long phrase", rec.passHash)).toBe(true);
    expect((await staffSetup({ email: staff.email, code, password: "another brand new phrase" })).status).toBe(401);
  });
  it("a setup code ends after 30 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = await makeStaff();
      const code = await issueSetupCode(s.email, "key", "setup");
      vi.setSystemTime(new Date(Date.now() + 30 * 60_000 + 1000));
      expect((await staffSetup({ email: s.email, code, password: "a brand new long phrase" })).status).toBe(401);
    } finally { vi.useRealTimers(); }
  });
  it("no staff route or staff library sends mail, and no setup code is read from a URL", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk("src/app/api/admin/staff");
    files.push("src/lib/staff.ts", "src/lib/staff-session.ts", "src/lib/staff-signin.ts", "src/lib/staff-code.ts");
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from "@\/lib\/(mail|email)|from "\.\/(mail|email)|sendMail|sendEmail/);
      expect(src, f).not.toMatch(/searchParams|nextUrl/);
    }
  });
});

describe("the per-address lock (rule 1644)", () => {
  it("10 failures lock the address for 15 minutes, with one staff.locked row; the key path is not affected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { staff } = await withPassword();
      for (let i = 0; i < 12; i++) expect((await staffLogin(staff.email, "the wrong long phrase")).status).toBe(401);
      expect((await staffLogin(staff.email, PW)).status).toBe(401);
      const rows = (await logRows()).filter((r) => r.action === "staff.locked" && r.target === staff.email);
      expect(rows).toHaveLength(1);
      expect((await logRows()).filter((r) => r.target === staff.email && r.action !== "staff.locked")).toHaveLength(0);
      await adminSignIn(); // the console key still opens its session while the staff address is locked
      vi.setSystemTime(new Date(Date.now() + 15 * 60_000 + 1000));
      expect(await (await staffLogin(staff.email, PW)).json()).toEqual({ ok: true, next: "code" });
      expect(await db.get(staffFailKey(staff.email))).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe("roles fail closed on writes (rule 1637)", () => {
  it("support and unknown roles get 403 read_only on a write; reads work", async () => {
    const { openStaffSession } = await import("@/lib/staff-session");
    const plan = await import("@/app/api/admin/plan/route");
    const { json } = await import("./helpers/session");
    const customer = await newUser("rolecheck");
    for (const role of ["support", "admin"]) {
      jar().clear();
      const { staff } = await enrolledStaff({ role: role as Staff["role"] });
      await openStaffSession(staff.email);
      const r = await plan.POST(json("/api/admin/plan", "POST", { email: customer.email, addCredits: 1 }, { "x-forwarded-for": freshIp() }));
      expect(r.status, role).toBe(403);
      expect(await r.json()).toEqual({ ok: false, error: "read_only" });
      expect((await plan.GET(json(`/api/admin/plan?email=${encodeURIComponent(customer.email)}`, "GET"))).status, role).toBe(200);
    }
  });
});
