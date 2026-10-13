import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { newTotpSecret } from "@/lib/totp";
import {
  COMMON_PASSWORDS, DUMMY_HASH, RECOVERY_CODES, STAFF_BCRYPT_COST, canWrite, getStaff, hashStaffPassword, listStaff, newRecoveryCodes,
  openStaffSecret, passwordRefusal, recoveryIndex, sealStaffSecret, staffKey, staffPasswordMatches,
} from "@/lib/staff";
import { kidOf } from "@/lib/connectors/store";
import { jar, newUser } from "./helpers/session";
import { makeStaff, staffAddress } from "./helpers/staff";

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
