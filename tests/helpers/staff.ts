import { DUMMY_HASH, saveStaff, sealStaffSecret, type Staff } from "@/lib/staff";
import { fromBase32, hotp, newTotpSecret, totpStep } from "@/lib/totp";

let n = 0;
/** A fresh staff address, never a customer's. */
export const staffAddress = (p = "staff") => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@staff.example`;
/** A staff record written straight to the store (no setup code, no password unless given). */
export async function makeStaff(over: Partial<Staff> = {}): Promise<Staff> {
  const s: Staff = { email: staffAddress(), name: "Staff", role: "owner", passHash: "", createdAt: new Date().toISOString(), createdBy: "key", ...over };
  await saveStaff(s);
  return s;
}

/** The 6-digit code of `secret` at `ms`. */
export const codeAt = (secret: string, ms = Date.now()) => hotp(fromBase32(secret)!, totpStep(ms));

/**
 * A staff record that can hold a session: an authenticator sealed with the current CONNECT_SECRET and a password hash.
 * `passHash` defaults to a cost-12 hash of a password nobody knows, so tests that never type it stay fast.
 */
export async function enrolledStaff(over: Partial<Staff> = {}): Promise<{ staff: Staff; secret: string }> {
  const secret = newTotpSecret();
  const staff = await makeStaff({ passHash: DUMMY_HASH, totp: { ...sealStaffSecret(secret), at: new Date().toISOString() }, ...over });
  return { staff, secret };
}
