import bcrypt from "bcryptjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { db } from "./db";
import { getLogin, normalizeEmail, validEmail } from "./auth";
import { connectSecret, kidOf } from "./connectors/store";
import { sameSecret } from "./secret";
import { newRecoveryCode } from "./totp";
import { log } from "./log";

/**
 * Staff identity (docs/specs/2026-10-13-staff-identity.md phase 1, rules 1630-1654, docs/system/flows.md section 71).
 *
 * A staff member is a `staff:{email}` record, a different record type from any customer `User` (rule 1630): the same
 * address may also be a customer, but the two never share a password (rule 1641), a session, a cookie or a recovery
 * path. Nothing in this file reads or writes a customer record, except the one bcrypt compare that refuses a staff
 * password equal to the customer password of the same address.
 *
 * Stored shapes are new keys only (rule 679 expand): `staff:{email}`, `staff:index`, `staff:config`. Old code never
 * reads them.
 */

export type StaffRole = "owner" | "support";
/** The roles phase 1 knows. Only `owner` can write, and only `owner` can be created (rule 1637). */
export const STAFF_ROLES: readonly StaffRole[] = ["owner", "support"];
/** The sealed authenticator secret: AES-256-GCM blob, the `kid` of the key that sealed it, and when it was enrolled. */
export type StaffTotp = { enc: string; kid: string; at: string };
export type Staff = {
  email: string;
  name: string;
  role: StaffRole;
  /** bcrypt, cost 12; "" until the setup code is redeemed. */
  passHash: string;
  totp?: StaffTotp;
  /** SHA-256 of the unused recovery codes (8 issued at enrolment). */
  rc?: string[];
  createdAt: string;
  /** "key" (bootstrap) or the staff email that created the record. */
  createdBy: string;
  disabled?: boolean;
  /** ISO: sessions and step-ups issued before it are void (rule 1635). */
  sessionsAfter?: string;
  lastSignInAt?: string;
};
/** `customerPathOff`: the founder's customer session no longer opens the console (rule 1650). */
export type StaffConfig = { customerPathOff?: { at: string; by: string } };

export const STAFF_INDEX = "staff:index";
export const STAFF_CONFIG = "staff:config";
export const staffKey = (email: string) => `staff:${email}`;
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Only `owner` writes. Any other value, a future role included, is read-only: the check fails closed (rule 1637). */
export const canWrite = (role: unknown) => role === "owner";

const isStaff = (v: unknown): v is Staff =>
  !!v && typeof v === "object" && typeof (v as Staff).email === "string" && typeof (v as Staff).passHash === "string" && typeof (v as Staff).role === "string";

/** The address as staff records are keyed: normalized, and null when it is not an address at all. */
export function staffEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = normalizeEmail(raw);
  return validEmail(e) ? e : null;
}

/** The staff record for an address, or null (unknown, malformed, or not an address). */
export async function getStaff(raw: unknown): Promise<Staff | null> {
  const e = staffEmail(raw);
  if (!e) return null;
  const s = await db.get<Staff>(staffKey(e));
  return isStaff(s) && s.email === e ? s : null;
}

/** Write a staff record and keep the index. The caller holds `withStaffLock` for a read-modify-write. */
export async function saveStaff(s: Staff): Promise<void> {
  await Promise.all([db.set(staffKey(s.email), s), db.sadd(STAFF_INDEX, s.email)]);
}

/** Every staff record, in one read of the index and one MGET. */
export async function listStaff(): Promise<Staff[]> {
  const emails = (await db.smembers(STAFF_INDEX)).filter((e) => typeof e === "string" && e.length > 0).sort();
  if (!emails.length) return [];
  const recs = await db.mget<Staff>(emails.map(staffKey));
  return recs.filter(isStaff);
}

/**
 * An owner who can actually manage staff: enabled, with a password and an enrolled authenticator. A disabled owner, or
 * one who never finished setup (or whose credentials a reset cleared), does not count, so a record that can never sign
 * in neither blocks bootstrap nor counts as "another owner" (rules 1639, 1643, 1659).
 */
export const activeOwner = (s: Staff): boolean => s.role === "owner" && !s.disabled && !!s.passHash && !!s.totp;

/** Whether an active owner exists (bootstrap answers 409 once one does, rule 1639). */
export async function ownerExists(): Promise<boolean> {
  return (await listStaff()).some(activeOwner);
}

/** Whether an active owner other than `email` exists (the key session's reset and enable need none, rule 1643). */
export async function otherActiveOwner(email: string): Promise<boolean> {
  return (await listStaff()).some((s) => activeOwner(s) && s.email !== email);
}

/** The lock every change to who can manage staff runs under: last-owner checks, disable, enable, role, reset (rule 1659). */
export const OWNERS_LOCK = "lock:staff:owners";

export async function staffConfig(): Promise<StaffConfig> {
  const c = await db.get<StaffConfig>(STAFF_CONFIG);
  return c && typeof c === "object" ? c : {};
}

/** True when the founder's customer session no longer opens the console (rule 1650). */
export async function customerPathOff(): Promise<boolean> {
  const c = await staffConfig();
  return !!c.customerPathOff && typeof c.customerPathOff.at === "string";
}

/** A session or step-up issued at `atMs` predates the record's `sessionsAfter` (rule 1635). */
export const issuedBeforeStaff = (s: Pick<Staff, "sessionsAfter">, atMs: number) =>
  !!s.sessionsAfter && atMs < new Date(s.sessionsAfter).getTime();

/**
 * Read-modify-write a staff record under `lock:staff:{email}` (the same retry loop as `withUserLock` in credits.ts).
 * `fn` gets the fresh record, or null when there is none.
 */
export async function withStaffLock<T>(email: string, fn: (s: Staff | null) => Promise<T>): Promise<T> {
  const key = `lock:staff:${email}`;
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await new Promise((r) => setTimeout(r, 50));
  }
  if (!got) throw new Error("staff_lock_timeout");
  try {
    return await fn(await getStaff(email));
  } finally {
    await db.unlock(key).catch((e) => log.error("staff lock release failed", e));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Passwords (rule 1641)

/** bcrypt cost for staff passwords. The customer accounts use the same KDF (bcryptjs) at cost 10. */
export const STAFF_BCRYPT_COST = 12;
export const STAFF_PASSWORD_MIN = 12;
/**
 * At most 72 bytes in UTF-8: bcrypt reads only the first 72 bytes, so a longer password would be cut without a word and
 * any text after byte 72 would not matter (rule 1641). 72 Latin letters, about 36 Arabic ones.
 */
export const STAFF_PASSWORD_MAX = 72;
export const passwordBytes = (pw: string) => Buffer.byteLength(pw, "utf8");
/**
 * A bcrypt hash at cost 12 of a random value nobody knows. An unknown address is compared against it, so a sign-in for
 * an address with no staff record costs the same time as one for a real record (rule 1631).
 */
export const DUMMY_HASH = "$2b$12$OLMX5wbgmRotAT42fQv.YunJWeUoIyO9LrSeh946DVqq4cCloyJK2";

/** A short built-in list of common passwords of 12 or more characters, compared without case. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password1234", "password12345", "password123456", "password123!", "passwordpassword", "123456789012", "1234567890ab",
  "123456789abc", "abc123456789", "qwerty123456", "qwertyuiop12", "qwertyqwerty", "1q2w3e4r5t6y", "zaq12wsxcde3",
  "iloveyou1234", "letmein12345", "welcome12345", "changeme1234", "administrator", "admin1234567", "admin123456789",
  "superuser1234", "000000000000", "111111111111", "123123123123", "abcdefghijkl", "trustno1trustno1", "football1234",
  "monkey123456", "dragon123456", "sunshine1234", "princess1234", "baseball1234", "starwars1234", "thakeen12345",
  "thakeen123456", "thakeenadmin", "thakeen@2026", "nashradmin12", "nashr1234567", "thakeen2026!", "p@ssw0rd1234",
]);

export type PasswordRefusal = "password_short" | "password_long" | "password_common" | "password_customer";

/**
 * Why a new staff password is refused, or null: 12 characters to 72 bytes, not on the common list, and not the customer
 * password of the same address (one bcrypt compare against the owner or member login, when there is one). No
 * composition rules.
 */
export async function passwordRefusal(email: string, pw: unknown): Promise<PasswordRefusal | null> {
  if (typeof pw !== "string" || pw.length < STAFF_PASSWORD_MIN) return "password_short";
  if (passwordBytes(pw) > STAFF_PASSWORD_MAX) return "password_long";
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return "password_common";
  const login = await getLogin(email);
  // The person's hash (multi-workspace M1: `login.person`, the record a sign-in checks).
  const customerHash = login?.person.passHash ?? "";
  if (typeof customerHash === "string" && customerHash && (await bcrypt.compare(pw, customerHash))) return "password_customer";
  return null;
}

export const hashStaffPassword = (pw: string) => bcrypt.hash(pw, STAFF_BCRYPT_COST);

/**
 * Compare a typed password with a staff record. Always runs exactly one bcrypt compare at cost 12, against the dummy
 * hash when the record is missing or has no password yet, so the time never tells a staff address apart (rule 1631).
 */
export async function staffPasswordMatches(s: Staff | null, pw: unknown): Promise<boolean> {
  const typed = typeof pw === "string" && passwordBytes(pw) <= STAFF_PASSWORD_MAX ? pw : "";
  const hash = s && s.passHash ? s.passHash : DUMMY_HASH;
  const ok = await bcrypt.compare(typed, hash);
  return ok && !!s && !!s.passHash && typed.length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Authenticator secrets (rule 1654)

/**
 * Staff secrets are sealed with AES-256-GCM under SHA-256(`nashr-staff-totp:` + CONNECT_SECRET): their own label, so a
 * staff blob never opens as a connector token or as the console's `admin:2fa` secret, nor the other way round. Each
 * record names the key that sealed it (`kid`, the connector store's fingerprint, rule 1351), so after a rotation
 * (`CONNECT_SECRET` new, `CONNECT_SECRET_PREVIOUS` old) it still opens, and the next sign-in seals it again with the
 * current key.
 */
const sealKey = (label: string, secret: string) => createHash("sha256").update(`${label}:${secret}`).digest();
function keyring(label: string): { kid: string; key: Buffer }[] {
  const current = connectSecret();
  const previous = process.env.CONNECT_SECRET_PREVIOUS;
  const ring = [{ kid: kidOf(current), key: sealKey(label, current) }];
  if (previous && previous !== current) ring.push({ kid: kidOf(previous), key: sealKey(label, previous) });
  return ring;
}
/** The label staff secrets are sealed under. Customer secrets (src/lib/mfa.ts, rule 1931) use their own. */
export const STAFF_SEAL_LABEL = "nashr-staff-totp";

export function sealStaffSecret(secret: string): { enc: string; kid: string } {
  return sealWithLabel(STAFF_SEAL_LABEL, secret);
}
/** Seal `secret` with AES-256-GCM under the current CONNECT_SECRET and `label` (rule 1654; reused by rule 1931). */
export function sealWithLabel(label: string, secret: string): { enc: string; kid: string } {
  const [{ kid, key }] = keyring(label);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return { enc: `${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`, kid };
}

/**
 * Open a sealed secret with the key its `kid` names. `stale` is true when that key is the previous one, so the caller
 * seals it again. Null when no key in the ring matches or the blob does not open: the gate then refuses, never opens.
 */
export function openStaffSecret(t: { enc: string; kid?: string } | undefined | null): { secret: string; stale: boolean } | null {
  return openWithLabel(STAFF_SEAL_LABEL, t);
}
/** Open a blob `sealWithLabel` made under the same `label`; `stale` when the previous key opened it. */
export function openWithLabel(label: string, t: { enc: string; kid?: string } | undefined | null): { secret: string; stale: boolean } | null {
  if (!t || typeof t.enc !== "string") return null;
  const ring = keyring(label);
  const tries = typeof t.kid === "string" ? ring.filter((r) => r.kid === t.kid) : ring;
  for (const r of tries) {
    try {
      const [iv, tag, enc] = t.enc.split(".");
      const d = createDecipheriv("aes-256-gcm", r.key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      const secret = Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
      return { secret, stale: r.kid !== ring[0].kid };
    } catch {
      // the next key, if any
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Recovery codes (rule 1642)

export const RECOVERY_CODES = 8;
export const cleanCode = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
/** A staff recovery code (or setup code) as typed: 20 base32 characters once dashes and spaces are dropped. */
export const looksLikeStaffCode = (s: unknown): s is string => typeof s === "string" && s.length <= 64 && /^[A-Z2-7]{20}$/.test(cleanCode(s));
/** How a staff recovery code is kept: SHA-256 under its own label, never the code itself. */
export const staffRecoveryHash = (code: string) => sha(`nashr-staff-recovery:${cleanCode(code)}`);

/** Eight new codes, shown once, and their hashes for the record. `hash` is the staff one unless a caller names its own (rule 1932). */
export function newRecoveryCodes(hash: (code: string) => string = staffRecoveryHash): { codes: string[]; rc: string[] } {
  const codes = Array.from({ length: RECOVERY_CODES }, () => newRecoveryCode());
  return { codes, rc: codes.map(hash) };
}

/** The index of the matching unused code in `rc`, or -1. Every entry is compared in constant time. */
export function recoveryIndex(rc: readonly string[] | undefined, code: string, hash: (code: string) => string = staffRecoveryHash): number {
  if (!Array.isArray(rc)) return -1;
  const h = hash(code);
  let found = -1;
  rc.forEach((x, i) => { if (sameSecret(x, h) && found < 0) found = i; });
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// The sign-in lock (rule 1644)

/** Failed sign-ins for one address within the window that lock it, and how long the lock lasts (seconds). */
export const STAFF_LOCK_AFTER = 10;
export const STAFF_LOCK_WINDOW = 15 * 60;
/** Failures are counted here, never in `admin:log`, so a flood cannot push real audit rows out of the capped list. */
export const staffFailKey = (email: string) => `stafffail:${sha(email)}`;

/** True while the address is locked. */
export async function staffLocked(email: string): Promise<boolean> {
  const n = Number(await db.get<number>(staffFailKey(email)));
  return Number.isFinite(n) && n >= STAFF_LOCK_AFTER;
}

/**
 * Count one failed sign-in for the address. True exactly when this failure locks it (the 10th in the window): the
 * lock then lasts the full window from now, and the caller writes the one `staff.locked` row.
 */
export async function countStaffFailure(email: string): Promise<boolean> {
  const k = staffFailKey(email);
  const n = await db.incrby(k, 1);
  if (n === STAFF_LOCK_AFTER) {
    await db.expire(k, STAFF_LOCK_WINDOW);
    return true;
  }
  await db.expireNx(k, STAFF_LOCK_WINDOW).catch(() => {});
  return false;
}

export const clearStaffFailures = (email: string) => db.del(staffFailKey(email));

// ---------------------------------------------------------------------------------------------------------------------
// Setup and reset codes (rules 1639, 1640, 1643)

/** A setup code works once, for 30 minutes, and only for the address it was issued for. */
export const SETUP_TTL = 30 * 60;
export type SetupKind = "setup" | "reset";
export type SetupRec = { email: string; by: string; at: string; kind: SetupKind };
export const setupKey = (code: string) => `staffsetup:${sha(`nashr-staff-setup:${cleanCode(code)}`)}`;

/**
 * Issue a single-use setup (or reset) code for `email`: 20 base32 characters in groups of five, shown once on screen and
 * handed over in person. Only its hash is stored. Never mailed, never put in a URL (rule 1643).
 */
export async function issueSetupCode(email: string, by: string, kind: SetupKind): Promise<string> {
  const code = newRecoveryCode();
  await db.set(setupKey(code), { email, by, at: new Date().toISOString(), kind } satisfies SetupRec, SETUP_TTL);
  return code;
}

/** The setup record a code names, without spending it; null for an unknown, expired or malformed code. */
export async function peekSetupCode(code: unknown): Promise<SetupRec | null> {
  if (!looksLikeStaffCode(code)) return null;
  const r = await db.get<SetupRec>(setupKey(code));
  return r && typeof r.email === "string" && (r.kind === "setup" || r.kind === "reset") ? r : null;
}

/** Spend a setup code (atomic GETDEL): the record, or null when it is gone or was spent by a racing request. */
export async function takeSetupCode(code: string): Promise<SetupRec | null> {
  const r = await db.getdel<SetupRec>(setupKey(code));
  return r && typeof r.email === "string" && (r.kind === "setup" || r.kind === "reset") ? r : null;
}
