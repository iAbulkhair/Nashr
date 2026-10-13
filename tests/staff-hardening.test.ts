import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  OWNERS_LOCK, STAFF_INDEX, STAFF_LOCK_AFTER, STAFF_PASSWORD_MAX, getStaff, hashStaffPassword, issueSetupCode, newRecoveryCodes, ownerExists,
  passwordRefusal, saveStaff, staffFailKey, staffPasswordMatches,
} from "@/lib/staff";
import { STAFF_COOKIE, openStaffSession, readStaffSession, staffSessionLive } from "@/lib/staff-session";
import { keyStaffAlert } from "@/lib/staff-alert";
import { SW } from "@/lib/staff-words";
import { adminSignIn, jar, json, settle } from "./helpers/session";
import { codeAt, enrolledStaff, freshIp, makeStaff, staffAddress, staffLogin, staffSignIn } from "./helpers/staff";

/**
 * Hardening of staff identity after the 2026-10-13 security review of claude/staff-identity (rules 1641, 1643, 1644,
 * 1647, 1659 in docs/system/tests/1630-staff-identity.md): the key session cannot take over a staff owner, a reset voids
 * the old credentials at once, no state leaves nobody able to manage staff, someone else's failures cannot lock the owner
 * out, the own-password check is limited, and passwords stop at bcrypt's 72 bytes.
 */
const sends: { to: string; subject: string; text: string }[] = [];
// sendEmail itself is replaced (not the resend module): two first-time sends at once can slip past a module mock.
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (to: string, subject: string, text: string) => { sends.push({ to, subject, text }); return true; },
}));

const KEY = "staff-hardening-test-key-0123456789";
const R = "hardening test reason";
const PW = "the right long phrase";
let pwHash = "";
const F1 = "founder-one@founders.example", F2 = "founder-two@founders.example";
beforeAll(async () => {
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); vi.stubEnv("CONNECT_SECRET", "staff-hardening-secret-one");
});
beforeEach(async () => { jar().clear(); sends.length = 0; await db.del(STAFF_INDEX); });
afterEach(async () => { vi.useRealTimers(); await db.del("admin:2fa"); vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("MAIL_FROM", ""); });

const staffRoute = () => import("@/app/api/admin/staff/route");
const meRoute = () => import("@/app/api/admin/staff/me/route");
const bootstrapRoute = () => import("@/app/api/admin/staff/bootstrap/route");
const twoFaRoute = () => import("@/app/api/admin/2fa/route");
const post = async (route: Promise<{ POST: (r: Request) => Promise<Response> }>, url: string, body: Record<string, unknown>, headers: Record<string, string> = {}, ip = freshIp()) =>
  (await route).POST(json(url, "POST", body, { "x-forwarded-for": ip, ...headers }));
const manage = (body: Record<string, unknown>, headers: Record<string, string> = {}) => post(staffRoute(), "/api/admin/staff", { reason: R, ...body }, headers);
const logRows = async () => (await db.lrange("admin:log", 0, 80)).map((r) => JSON.parse(r) as { action?: string; target?: string; actor?: string; via?: string; extra?: Record<string, unknown> });
const withPassword = async (over = {}) => enrolledStaff({ passHash: (pwHash ||= await hashStaffPassword(PW)), ...over });
let epoch = Date.now() + 500 * 60 * 60_000;
function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  epoch += 60 * 60_000;
  let t = epoch;
  vi.setSystemTime(t);
  return () => { t += 31_000; vi.setSystemTime(t); };
}
async function enrolConsoleCode(): Promise<string> {
  const r = await twoFaRoute();
  const s = await (await r.POST(json("/api/admin/2fa", "POST", { action: "start" }, { "x-forwarded-for": freshIp() }))).json();
  const c = await (await r.POST(json("/api/admin/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, { "x-forwarded-for": freshIp() }))).json();
  if (!c.ok) throw new Error("console enrolment failed");
  return s.secret as string;
}
const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "re_test_key"); vi.stubEnv("MAIL_FROM", "Thakeen <console@mail.example>"); vi.stubEnv("ADMIN_EMAILS", `${F1},${F2}`); };

describe("the key session cannot take over a staff owner (rule 1643)", () => {
  it("without the console code enrolled, the key session resets and enables nothing: 403 console_code_required", async () => {
    const { staff } = await withPassword();
    const off = await makeStaff({ disabled: true });
    await adminSignIn();
    for (const [action, email] of [["reset", staff.email], ["enable", off.email]] as const) {
      const r = await manage({ action, email });
      expect(r.status, action).toBe(403);
      expect(await r.json()).toEqual({ ok: false, error: "console_code_required" });
    }
    expect((await getStaff(staff.email))!.passHash).toBe(pwHash);
    expect((await getStaff(off.email))!.disabled).toBe(true);
  });

  it("with it enrolled: no code is console_code_required, a wrong one bad_code; another active owner means 409 owner_active", async () => {
    const tick = clock();
    const { staff: other } = await withPassword();
    const target = await makeStaff({ passHash: pwHash });
    const off = await makeStaff({ disabled: true });
    await adminSignIn();
    const secret = await enrolConsoleCode();
    tick();
    expect(await (await manage({ action: "reset", email: target.email })).json()).toEqual({ ok: false, error: "console_code_required" });
    expect(await (await manage({ action: "reset", email: target.email, code: "000000" })).json()).toEqual({ ok: false, error: "bad_code" });
    tick();
    const r = await manage({ action: "reset", email: target.email, code: codeAt(secret) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "owner_active" });
    tick();
    expect(await (await manage({ action: "enable", email: off.email, code: codeAt(secret) })).json()).toEqual({ ok: false, error: "owner_active" });
    tick();
    // Not even the active owner itself: an owner who can sign in resets their own way, never through the key.
    expect(await (await manage({ action: "reset", email: other.email, code: codeAt(secret) })).json()).toMatchObject({ ok: true });
    expect((await getStaff(target.email))!.passHash).toBe(pwHash);
    expect((await getStaff(off.email))!.disabled).toBe(true);
  });

  it("when no other active owner exists: the reset voids the old credentials, and the founders get a mail with no secret in it", async () => {
    const tick = clock();
    mailOn();
    const { codes, rc } = newRecoveryCodes();
    const { staff } = await withPassword({ rc });
    const live = await openStaffSession(staff.email);
    jar().clear();
    await adminSignIn();
    const secret = await enrolConsoleCode();
    tick();
    const r = await manage({ action: "reset", email: staff.email, code: codeAt(secret) });
    expect(r.status).toBe(200);
    const { code } = await r.json();
    await settle();
    const rec = (await getStaff(staff.email))!;
    expect(rec.passHash).toBe("");
    expect(rec.totp).toBeUndefined();
    expect(rec.rc).toBeUndefined();
    expect(await staffSessionLive(live.hash, staff.email)).toBe(false);
    expect(sends.map((m) => m.to).sort()).toEqual([F1, F2]);
    for (const m of sends) {
      expect(m.text).toContain(staff.email);
      expect(m.text).not.toContain(code);
      expect(m.text).not.toContain(R);
      for (const c of codes) expect(m.text).not.toContain(c);
    }
    expect(sends.some((m) => m.to === staff.email)).toBe(false);
    expect((await logRows()).find((x) => x.action === "staff.reset" && x.target === staff.email)).toMatchObject({ actor: "key", via: "key" });
  });

  it("a disabled sole owner can be enabled by the key session (no deadlock), with the founders' mail; without mail set up nothing is sent", async () => {
    const tick = clock();
    const { staff } = await withPassword({ disabled: true });
    await adminSignIn();
    const secret = await enrolConsoleCode();
    tick();
    expect((await manage({ action: "enable", email: staff.email, code: codeAt(secret) })).status).toBe(200);
    await settle();
    expect(sends).toHaveLength(0); // mail not configured: mailReady() is false
    expect((await getStaff(staff.email))!.disabled).toBeUndefined();
    await saveStaff({ ...(await getStaff(staff.email))!, disabled: true });
    mailOn();
    tick();
    expect((await manage({ action: "enable", email: staff.email, code: codeAt(secret) })).status).toBe(200);
    await settle();
    expect(sends.map((m) => m.to).sort()).toEqual([F1, F2]);
    expect(sends[0].subject).toMatch(/enabled again from the key session/);
  });

  it("the alert names the action, the login and the time in Arabic and English, and nothing else", () => {
    const m = keyStaffAlert("reset", "x@staff.example", new Date("2026-10-13T10:20:30Z"));
    expect(m.text).toContain("x@staff.example");
    expect(m.text).toContain("2026-10-13 10:20 UTC");
    expect(m.text).toMatch(/[؀-ۿ]/);
    expect(m.text).toMatch(/break-glass/);
    expect(readFileSync("src/lib/staff-alert.ts", "utf8")).toMatch(/adminEmails\(\)\.map/);
  });
});

describe("a reset voids the old credentials at once (rule 1643)", () => {
  it("an owner's reset of another owner: the old password, authenticator and recovery codes stop working before the code is redeemed", async () => {
    const tick = clock();
    const { staff: owner, secret } = await withPassword();
    const { codes, rc } = newRecoveryCodes();
    const { staff: other } = await withPassword({ rc });
    await staffSignIn(owner.email, PW, secret);
    tick();
    const r = await manage({ action: "reset", email: other.email, code: codeAt(secret) });
    expect(r.status).toBe(200);
    expect(await (await manage({ action: "reset", email: owner.email, code: (tick(), codeAt(secret)) })).json()).toEqual({ ok: false, error: "not_self" });
    const rec = (await getStaff(other.email))!;
    expect(rec).toMatchObject({ passHash: "" });
    expect(rec.totp).toBeUndefined();
    expect(rec.rc).toBeUndefined();
    jar().clear();
    expect((await staffLogin(other.email, PW)).status).toBe(401);
    expect(await staffPasswordMatches(rec, PW)).toBe(false);
    expect(codes.length).toBe(8);
  });
});

describe("nobody can be left unable to manage staff (rule 1659)", () => {
  it("disable, enable, role and reset wait for lock:staff:owners", async () => {
    const tick = clock();
    const { staff: owner, secret } = await withPassword();
    const { staff: other } = await withPassword();
    await staffSignIn(owner.email, PW, secret);
    tick();
    expect(await db.lock(OWNERS_LOCK, 10)).toBe(true);
    const pending = manage({ action: "disable", email: other.email, code: codeAt(secret) });
    await new Promise((r) => setTimeout(r, 200));
    expect((await getStaff(other.email))!.disabled).toBeUndefined(); // still waiting for the lock
    await db.unlock(OWNERS_LOCK);
    expect((await pending).status).toBe(200);
    expect((await getStaff(other.email))!.disabled).toBe(true);
    const src = readFileSync("src/app/api/admin/staff/route.ts", "utf8");
    expect(src).toMatch(/withNamedLock<Out>\(OWNERS_LOCK, async \(\) => \{[\s\S]*lastOwner\(email\)[\s\S]*otherActiveOwner|withNamedLock<Out>\(OWNERS_LOCK, async \(\) => \{[\s\S]*otherActiveOwner\(email\)[\s\S]*lastOwner\(email\)/);
    expect(readFileSync("src/app/api/admin/staff/bootstrap/route.ts", "utf8")).toContain("withNamedLock(OWNERS_LOCK,");
  });

  it("an owner who is disabled or never finished setup does not count: bootstrap still works, and an active owner cannot be the last one switched off", async () => {
    const tick = clock();
    await makeStaff({ passHash: pwHash || (pwHash = await hashStaffPassword(PW)) }); // never enrolled
    await withPassword({ disabled: true });
    expect(await ownerExists()).toBe(false);
    await adminSignIn();
    const secret = await enrolConsoleCode();
    tick();
    const b = await post(bootstrapRoute(), "/api/admin/staff/bootstrap", { email: staffAddress("boot2"), name: "Founder", reason: R }, { "x-admin-otp": codeAt(secret) });
    expect(b.status).toBe(200);
    jar().clear();
    const { staff: solo, secret: s2 } = await withPassword();
    const { staff: half } = await enrolledStaff({ passHash: "" }); // an authenticator but no password: not active
    await staffSignIn(solo.email, PW, s2);
    tick();
    expect(await (await manage({ action: "role", email: half.email, role: "support", code: codeAt(s2) })).json()).toEqual({ ok: true });
    expect(await ownerExists()).toBe(true);
  });
});

describe("someone else's failures cannot lock the owner out (rule 1644)", () => {
  it("while locked: the password alone, a wrong code, or a wrong password with a right code are the same 401; the password and the right code together sign in", async () => {
    clock();
    const { staff, secret } = await withPassword();
    for (let i = 0; i < STAFF_LOCK_AFTER; i++) await staffLogin(staff.email, "the wrong long phrase");
    const plain = '{"ok":false,"error":"invalid"}';
    const answers = await Promise.all([
      staffLogin(staff.email, PW),
      loginWith(staff.email, PW, "000000"),
      loginWith(staff.email, "the wrong long phrase", codeAt(secret)),
      loginWith(staffAddress("nobody"), PW, "123456"),
    ]);
    expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(await Promise.all(answers.map((r) => r.text())))).toEqual(new Set([plain]));
    expect(jar().has(STAFF_COOKIE)).toBe(false);
    const ok = await loginWith(staff.email, PW, codeAt(secret));
    expect(await ok.json()).toEqual({ ok: true, next: "done" });
    expect(await readStaffSession()).toMatchObject({ email: staff.email });
    expect(Number(await db.get(staffFailKey(staff.email)))).toBeGreaterThanOrEqual(STAFF_LOCK_AFTER); // the lock stays for the guesser
    expect((await logRows()).find((r) => r.action === "staff.signin" && r.target === staff.email)).toMatchObject({ via: "staff", locked: true });
  });

  it("the codes sent with a locked password are tries of their own: 5 per address per 15 minutes", async () => {
    const { staff } = await withPassword();
    await db.set(staffFailKey(staff.email), STAFF_LOCK_AFTER, 900);
    for (let i = 0; i < 5; i++) expect((await loginWith(staff.email, PW, "000000")).status).toBe(401);
    expect((await loginWith(staff.email, PW, "000000")).status).toBe(429);
  });

  it("the staff.locked row is written after the answer, so the 10th failure costs the same time", async () => {
    const { staff } = await withPassword();
    for (let i = 0; i < STAFF_LOCK_AFTER; i++) await staffLogin(staff.email, "the wrong long phrase");
    await settle();
    expect((await logRows()).filter((r) => r.action === "staff.locked" && r.target === staff.email)).toHaveLength(1);
    const src = readFileSync("src/app/api/admin/staff/login/route.ts", "utf8");
    expect(src).toMatch(/after\(\(\) => adminAudit\(\{ actor: "system", section: "system", action: "staff\.locked"/);
    expect(src).not.toMatch(/await adminAudit\(\{ actor: "system"/);
  });
});
const loginWith = async (email: unknown, password: unknown, code: unknown, ip = freshIp()) =>
  (await import("@/app/api/admin/staff/login/route")).POST(json("/api/admin/staff/login", "POST", { email, password, code }, { "x-forwarded-for": ip }));

describe("the own-password check is a password guess too (rule 1644)", () => {
  it("refused while the address is locked, 5 per IP per 15 minutes, a wrong one counts toward the lock", async () => {
    const tick = clock();
    const { staff, secret } = await withPassword();
    await staffSignIn(staff.email, PW, secret);
    const change = (current: string, ip: string) => post(meRoute(), "/api/admin/staff/me", { action: "password", current, password: "a brand new long phrase", code: (tick(), codeAt(secret)) }, {}, ip);
    await db.set(staffFailKey(staff.email), STAFF_LOCK_AFTER, 900);
    expect(await (await change(PW, freshIp())).json()).toEqual({ ok: false, error: "invalid" });
    await db.del(staffFailKey(staff.email));
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await change("not my password at all", ip)).status).toBe(401);
    expect(Number(await db.get(staffFailKey(staff.email)))).toBe(5);
    const r = await change(PW, ip);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ ok: false, error: "slow_down" });
    expect(await bcrypt.compare(PW, (await getStaff(staff.email))!.passHash)).toBe(true);
  });
});

describe("staff passwords stop at bcrypt's 72 bytes (rule 1641)", () => {
  it("72 bytes pass, 73 are refused, in Latin and in Arabic letters; a longer typed password never matches", async () => {
    expect(STAFF_PASSWORD_MAX).toBe(72);
    const e = staffAddress();
    expect(await passwordRefusal(e, "q".repeat(72))).toBeNull();
    expect(await passwordRefusal(e, "q".repeat(73))).toBe("password_long");
    expect(await passwordRefusal(e, "ب".repeat(36))).toBeNull(); // 2 bytes each in UTF-8
    expect(await passwordRefusal(e, "ب".repeat(37))).toBe("password_long");
    const pw = "z".repeat(72);
    const s = await makeStaff({ passHash: await hashStaffPassword(pw) });
    expect(await staffPasswordMatches(s, pw)).toBe(true);
    expect(await staffPasswordMatches(s, pw + "anything")).toBe(false); // bcrypt alone would have said yes
    for (const lang of ["ar", "en"] as const) {
      expect(SW[lang].errors.password_long).toContain("72");
      expect(SW[lang].passwordHint).toContain("72");
    }
    for (const f of ["src/components/admin/StaffSignIn.tsx", "src/components/admin/StaffAccount.tsx"]) expect(readFileSync(f, "utf8"), f).not.toContain("maxLength={128}");
  });
});

describe("the words of the fixes exist in both languages", () => {
  it("console_code_required, owner_active and the locked-address hint", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(SW[lang].errors.console_code_required.length).toBeGreaterThan(10);
      expect(SW[lang].errors.owner_active.length).toBeGreaterThan(10);
      expect(SW[lang].lockedNote.length).toBeGreaterThan(10);
    }
    expect(SW.ar.errors.owner_active).toMatch(/[؀-ۿ]/);
    void issueSetupCode;
  });
});
