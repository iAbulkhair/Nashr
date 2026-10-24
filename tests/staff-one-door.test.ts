import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { INVITE_TTL, SETUP_TTL, STAFF_INDEX, STAFF_LOCK_AFTER, getStaff, hashStaffPassword, saveStaff, sealStaffSecret, setupKey, staffFailKey } from "@/lib/staff";
import { newTotpSecret } from "@/lib/totp";
import { SW } from "@/lib/staff-words";
import { CB } from "@/components/admin/ConsoleBanners";
import { adminSignIn, jar, json, newUser, signIn } from "./helpers/session";
import { codeAt, enrolledStaff, freshIp, staffAddress, staffLogin, staffSetup, staffSignIn } from "./helpers/staff";

/**
 * One door for Thakeen staff (rules 3700-3707, docs/system/tests/3700-staff-one-door.md): the founder creates the first
 * staff login from their own customer session with a fresh proof, the setup code reaches the setup form in a cookie
 * instead of being copied by hand, a locked address is told so without telling which addresses exist, an owner invites
 * staff by email, and the break-glass key form keeps password managers out.
 */
const sends: { to: string; subject: string; text: string }[] = [];
let mailWorks = true;
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (to: string, subject: string, text: string) => { if (!mailWorks) return false; sends.push({ to, subject, text }); return true; },
}));

const KEY = "staff-one-door-test-key-0123456789";
const R = "one door test reason";
const PW = "the right long phrase";
let pwHash = "";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); vi.stubEnv("CONNECT_SECRET", "staff-one-door-secret-one"); });
beforeEach(async () => { jar().clear(); sends.length = 0; mailWorks = true; await db.del(STAFF_INDEX); });
afterEach(async () => { vi.useRealTimers(); await db.del("admin:2fa"); vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("MAIL_FROM", ""); });

const bootstrapRoute = () => import("@/app/api/admin/staff/bootstrap/route");
const staffRoute = () => import("@/app/api/admin/staff/route");
const twoFaRoute = () => import("@/app/api/admin/2fa/route");
const adminLoginRoute = () => import("@/app/api/admin/login/route");
const post = async (route: Promise<{ POST: (r: Request) => Promise<Response> }>, url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  (await route).POST(json(url, "POST", body, { "x-forwarded-for": freshIp(), ...headers }));
const boot = (body: Record<string, unknown>, headers: Record<string, string> = {}) => post(bootstrapRoute(), "/api/admin/staff/bootstrap", body, headers);
const manage = (body: Record<string, unknown>) => post(staffRoute(), "/api/admin/staff", { reason: R, ...body });
const logRows = async () => (await db.lrange("admin:log", 0, 80)).map((r) => JSON.parse(r) as { action?: string; target?: string; actor?: string; via?: string });
const passHash = async () => (pwHash ||= await hashStaffPassword(PW));
const withPassword = async (over = {}) => enrolledStaff({ passHash: await passHash(), ...over });
/** The hand-off cookie's name while it holds a value (a cleared cookie is set to "" with max-age 0). */
const setupCookie = () => [...jar().entries()].find(([k, v]) => k.includes("staff_setup") && v)?.[0];
const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "re_test_key"); vi.stubEnv("MAIL_FROM", "Thakeen <console@mail.example>"); };

let epoch = Date.now() + 900 * 60 * 60_000;
function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  epoch += 60 * 60_000;
  let t = epoch;
  vi.setSystemTime(t);
  return () => { t += 31_000; vi.setSystemTime(t); };
}
/** Enrol the console authenticator from the key session, then leave the jar empty. */
async function enrolConsoleCode(): Promise<string> {
  await adminSignIn();
  const r = await twoFaRoute();
  const s = await (await r.POST(json("/api/admin/2fa", "POST", { action: "start" }, { "x-forwarded-for": freshIp() }))).json();
  const c = await (await r.POST(json("/api/admin/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, { "x-forwarded-for": freshIp() }))).json();
  if (!c.ok) throw new Error("console enrolment failed");
  jar().clear();
  return s.secret as string;
}
async function founder(prefix = "door-founder") {
  const u = await newUser(prefix);
  vi.stubEnv("ADMIN_EMAILS", u.email);
  await signIn(u.email);
  return u;
}

describe("the founder creates the first staff login from their own session (rules 3700, 3701)", () => {
  it("no proof factor: 403 step_up_unavailable, nothing written", async () => {
    await founder();
    const email = staffAddress("boot");
    const r = await boot({ email, name: "Founder", reason: R });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: "step_up_unavailable" });
    expect(await getStaff(email)).toBeNull();
    // Passkey options too: the founder has no passkey.
    expect(await (await boot({ action: "passkey-options" })).json()).toEqual({ ok: false, error: "step_up_unavailable" });
  });

  it("a fresh console code: the record, the audit row, the hand-off cookie; no code in the answer; setup reads the cookie once", async () => {
    const tick = clock();
    const secret = await enrolConsoleCode();
    const u = await founder();
    tick();
    // No code typed: a step-up still open from earlier never counts.
    expect(await (await boot({ name: "Founder", reason: R })).json()).toEqual({ ok: false, error: "fresh_code" });
    // A recovery code, or anything not 6 digits, is refused (a console recovery code would remove the enrolment).
    expect(await (await boot({ name: "Founder", reason: R, code: "ABCD-EFGH-JKLM" })).json()).toEqual({ ok: false, error: "bad_code" });
    expect(await (await boot({ name: "Founder", reason: R, code: "000000" })).json()).toEqual({ ok: false, error: "bad_code" });
    // A passkey response that matches nothing is refused even though a console code would have worked.
    expect(await (await boot({ name: "Founder", reason: R, passkey: { id: "nope", response: {} } })).json()).toEqual({ ok: false, error: "step_up_failed" });
    expect(await getStaff(u.email)).toBeNull();
    tick();
    const ok = await boot({ name: "Founder", reason: R, code: codeAt(secret) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    // The email defaults to the founder's own; the code never travels in the answer.
    expect(await ok.json()).toEqual({ ok: true, email: u.email, next: "setup", expiresIn: SETUP_TTL });
    expect(await getStaff(u.email)).toMatchObject({ role: "owner", passHash: "", createdBy: u.email });
    const name = setupCookie()!;
    expect(name).toBeTruthy();
    const code = jar().get(name)!;
    expect(await db.get(setupKey(code))).toMatchObject({ email: u.email, kind: "setup", by: u.email });
    expect((await logRows()).find((r) => r.action === "staff.bootstrap" && r.target === u.email)).toMatchObject({ actor: u.email, via: "founder-session" });
    expect(JSON.stringify(await db.lrange("admin:log", 0, 50))).not.toContain(code);

    // Setup with no code in the body takes the cookie, for its own address only, once, and clears it.
    expect(await (await staffSetup({ email: staffAddress("other"), password: "a long founder phrase 2026" })).json()).toEqual({ ok: false, error: "invalid" });
    expect(await (await staffSetup({ email: u.email, password: "a long founder phrase 2026" })).json()).toEqual({ ok: true, next: "enrol" });
    expect(setupCookie()).toBeUndefined();
    expect(await db.get(setupKey(code))).toBeNull();
    expect((await staffSetup({ email: u.email, password: "a long founder phrase 2026" })).status).toBe(401);
  });

  it("an edited email works; once an ACTIVE owner exists, 409 for the founder too", async () => {
    const tick = clock();
    const secret = await enrolConsoleCode();
    await founder();
    const other = staffAddress("chosen");
    tick();
    expect(await (await boot({ email: other, name: "Ops", reason: R, code: codeAt(secret) })).json()).toMatchObject({ ok: true, email: other, next: "setup" });
    await saveStaff({ ...(await getStaff(other))!, passHash: await passHash(), totp: { ...sealStaffSecret(newTotpSecret()), at: new Date().toISOString() } });
    tick();
    const r = await boot({ email: staffAddress(), name: "Again", reason: R, code: codeAt(secret) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "exists" });
  });

  it("an impersonating founder, the header key and a staff session never bootstrap", async () => {
    const tick = clock();
    const secret = await enrolConsoleCode();
    const f = await newUser("door-imp-founder");
    const target = await newUser("door-imp-target");
    vi.stubEnv("ADMIN_EMAILS", f.email);
    await signIn(target.email, { imp: f.email });
    tick();
    const email = staffAddress("imp");
    const imp = await boot({ email, name: "Imp", reason: R, code: codeAt(secret) });
    expect([401, 403]).toContain(imp.status);
    expect(await getStaff(email)).toBeNull();
    jar().clear();
    expect(await (await boot({ email: staffAddress(), name: "H", reason: R }, { "x-admin-key": KEY })).json()).toEqual({ ok: false, error: "key_session_only" });
    const { staff, secret: s } = await withPassword({ role: "support" });
    await staffSignIn(staff.email, PW, s);
    expect(await (await boot({ email: staffAddress(), name: "S", reason: R })).json()).toEqual({ ok: false, error: "key_session_only" });
  });

  it("the key session (break-glass) still gets the code once, and no hand-off cookie", async () => {
    await adminSignIn();
    const email = staffAddress("key-boot");
    const r = await (await boot({ email, name: "Key", reason: R })).json();
    expect(r).toMatchObject({ ok: true, email, expiresIn: SETUP_TTL });
    expect(typeof r.code).toBe("string");
    expect(setupCookie()).toBeUndefined();
  });

  it("a cross-site post from the founder's session is refused", async () => {
    await founder();
    const email = staffAddress("csrf");
    const r = await boot({ email, name: "X", reason: R, code: "123456" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(await getStaff(email)).toBeNull();
  });
});

describe("a locked address is told so, an unknown one alike (rule 3702)", () => {
  it("known locked and unknown locked answer the same body; a never-failed address never sees `locked`", async () => {
    const { staff: known } = await withPassword();
    const unknown = staffAddress("ghost");
    await Promise.all([db.set(staffFailKey(known.email), STAFF_LOCK_AFTER, 900), db.set(staffFailKey(unknown), STAFF_LOCK_AFTER, 900)]);
    const [a, b, c] = await Promise.all([staffLogin(known.email, PW), staffLogin(unknown, PW), staffLogin(staffAddress("fresh"), PW)]);
    const [ta, tb, tc] = await Promise.all([a.text(), b.text(), c.text()]);
    expect(ta).toBe(tb);
    expect(JSON.parse(ta)).toEqual({ ok: false, error: "invalid", locked: true });
    expect(JSON.parse(tc)).toEqual({ ok: false, error: "invalid" });
  });

  it("the failure that reaches the limit already answers `locked`, so the form offers the code field at once", async () => {
    const unknown = staffAddress("climb");
    await db.set(staffFailKey(unknown), STAFF_LOCK_AFTER - 1, 900);
    expect(await (await staffLogin(unknown, PW)).json()).toEqual({ ok: false, error: "invalid", locked: true });
  });
});

describe("owners invite staff by email (rules 3706, 3707)", () => {
  async function owner() {
    const tick = clock();
    const { staff, secret } = await withPassword();
    await staffSignIn(staff.email, PW, secret);
    const fresh = () => { tick(); return codeAt(secret); };
    return { staff, fresh };
  }

  it("owner only, a reason, a fresh code and a role; the mail carries the code only in the fragment; only its hash is stored", async () => {
    mailOn();
    const { staff, fresh } = await owner();
    const email = staffAddress("invitee");
    const invite = { action: "invite", email, name: "Sara", role: "support", lang: "ar" };
    expect(await (await manage(invite)).json()).toEqual({ ok: false, error: "fresh_code" });
    expect(await (await manage({ ...invite, role: "admin", code: fresh() })).json()).toEqual({ ok: false, error: "bad_role" });
    expect(await (await manage({ ...invite, reason: "", code: fresh() })).json()).toEqual({ ok: false, error: "reason_short" });
    const r = await manage({ ...invite, code: fresh() });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, email, mailed: true, expiresIn: INVITE_TTL });
    expect(await getStaff(email)).toMatchObject({ role: "support", passHash: "", createdBy: staff.email });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe(email);
    const m = sends[0].text.match(/\/ar\/admin\/login\/setup#invite=([A-Za-z0-9-]+)/);
    expect(m).toBeTruthy();
    const code = m![1];
    expect(sends[0].text).not.toMatch(/[?&](code|invite)=/);
    // Stored under its hash only, for 24 hours; never in an audit row.
    expect(await db.get(setupKey(code))).toMatchObject({ email, kind: "invite", by: staff.email });
    expect(JSON.stringify(await db.lrange("admin:log", 0, 50))).not.toContain(code);
    expect((await logRows()).find((x) => x.action === "staff.invite" && x.target === email)).toMatchObject({ actor: staff.email, via: "staff" });
    // The same address again: 409.
    expect((await manage({ ...invite, code: fresh() })).status).toBe(409);

    // The invitee sets a password with the code from the link, once.
    jar().clear();
    expect(await (await staffSetup({ email, code, password: "an invited long phrase" })).json()).toEqual({ ok: true, next: "enrol" });
    expect((await staffSetup({ email, code, password: "an invited long phrase" })).status).toBe(401);
  });

  it("an invite code stops working after 24 hours", async () => {
    mailOn();
    const { fresh } = await owner();
    const email = staffAddress("late");
    await manage({ action: "invite", email, name: "Late", role: "owner", lang: "en", code: fresh() });
    expect(sends[0].subject).toBe("Your invite to the Thakeen staff console");
    const code = sends[0].text.match(/\/en\/admin\/login\/setup#invite=([A-Za-z0-9-]+)/)![1];
    vi.setSystemTime(new Date(Date.now() + INVITE_TTL * 1000 + 1000));
    jar().clear();
    expect((await staffSetup({ email, code, password: "an invited long phrase" })).status).toBe(401);
  });

  it("mail not set up, or the send failing: the link comes back once instead", async () => {
    const { fresh } = await owner();
    const email = staffAddress("nomail");
    const r = await (await manage({ action: "invite", email, name: "N", role: "support", code: fresh() })).json();
    expect(r).toMatchObject({ ok: true, email, mailed: false, expiresIn: INVITE_TTL });
    expect(r.link).toMatch(/\/ar\/admin\/login\/setup#invite=/);
    expect(sends).toHaveLength(0);
    mailOn();
    mailWorks = false;
    const r2 = await (await manage({ action: "invite", email: staffAddress("fail"), name: "F", role: "support", code: fresh() })).json();
    expect(r2.mailed).toBe(false);
    expect(r2.link).toContain("#invite=");
  });

  it("support staff and the key session cannot invite", async () => {
    const tick = clock();
    const { staff, secret } = await withPassword({ role: "support" });
    await staffSignIn(staff.email, PW, secret);
    tick();
    expect((await manage({ action: "invite", email: staffAddress(), name: "X", role: "support", code: codeAt(secret) })).status).toBe(403);
    jar().clear();
    await adminSignIn();
    expect(await (await manage({ action: "invite", email: staffAddress(), name: "X", role: "support" })).json()).toEqual({ ok: false, error: "staff_owner_only" });
  });

  it("10 invites per owner per hour, then 429 slow_down", async () => {
    const { fresh } = await owner();
    for (let i = 0; i < 10; i++) expect((await manage({ action: "invite", email: staffAddress("many"), name: "M", role: "support", code: fresh() })).status, `invite ${i}`).toBe(200);
    const r = await manage({ action: "invite", email: staffAddress("many"), name: "M", role: "support", code: fresh() });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ ok: false, error: "slow_down" });
  });
});

describe("the break-glass key form (rule 3705) and one founder path (rule 3704)", () => {
  it("the server trims spaces around a pasted key", async () => {
    expect((await post(adminLoginRoute(), "/api/admin/login", { key: `  ${KEY}\n` })).status).toBe(200);
  });

  it("the key field is kept from password managers and has a show toggle", () => {
    const src = readFileSync("src/components/app/AdminLogin.tsx", "utf8");
    for (const a of ['name="bg-admin-key"', 'autoComplete="new-password"', "data-1p-ignore", 'data-lpignore="true"', "data-bwignore", 'data-form-type="other"', "aria-pressed={show}"]) expect(src).toContain(a);
    expect(src).toMatch(/type=\{show \? "text" : "password"\}/);
  });

  it("no normal screen links to the key form", () => {
    for (const f of ["src/components/admin/StaffSignIn.tsx", "src/components/admin/ConsoleBanners.tsx"]) expect(readFileSync(f, "utf8"), f).not.toContain("login=1");
  });

  it("the invite code is read from the fragment and removed from the address bar, never from a query", () => {
    const src = readFileSync("src/components/admin/StaffSignIn.tsx", "utf8");
    expect(src).toContain("location.hash");
    expect(src).toContain("replaceState");
    expect(src).not.toMatch(/searchParams|useSearchParams/);
  });
});

describe("one sign-in screen in plain words (rule 3703)", () => {
  it("the first-time help names the very button the founder banner shows, in both languages", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(SW[lang].firstHelp, lang).toContain(CB[lang].create);
      expect(SW[lang].signInNote, lang).toBeTruthy();
      expect(SW[lang].handoffNote, lang).toMatch(/30/);
      expect(SW[lang].inviteOpenNote, lang).toMatch(/24/);
    }
    const src = readFileSync("src/components/admin/StaffSignIn.tsx", "utf8");
    expect(src).toContain('data-testid="staff-first-help"');
    // The locked-code field appears only on the server's word.
    expect(src).toMatch(/locked === true/);
  });
});
