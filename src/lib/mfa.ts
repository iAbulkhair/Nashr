import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "./db";
import { normalizeEmail } from "./auth";
import { allow, clientIp, giveBack, retryLater } from "./rate";
import { newTotpSecret, otpauthUri, totpMatch } from "./totp";
import { cleanCode, looksLikeStaffCode, newRecoveryCodes, openWithLabel, recoveryIndex, sealWithLabel } from "./staff";
import { withLoginLock } from "./team";

/**
 * Customer two-step sign-in (rules 1930-1937, docs/system/flows.md "Customer two-step sign-in"). Offered to every login,
 * owner or member, and recommended to the owner. Built from the staff code (src/lib/staff.ts, src/lib/staff-code.ts):
 * the same RFC 6238 codes (src/lib/totp.ts), the same sealed-secret keyring, the same eight hashed recovery codes, each
 * under its OWN label, so a customer blob never opens as a staff secret, nor a staff recovery code as a customer one.
 *
 * Stored shapes are new keys only (rule 679 expand): `mfa:{login}` (the enrolment) and `mfa:pending:{login}` (a setup
 * not yet confirmed, 15 minutes). The key is always the acting login's own address, from the session or from the login
 * that just proved its password, never from a request field. An enrolment written before the login record was created
 * (a removed member re-invited, a deleted account registered again) is ignored (`mfaActive`): nobody inherits someone
 * else's authenticator.
 */
export const MFA_LABEL = "nashr-mfa-totp";
export const MFA_RECOVERY_LABEL = "nashr-mfa-recovery";
/** A setup not confirmed with a code within this many seconds is dropped. */
export const MFA_SETUP_TTL = 15 * 60;
/** Code tries per IP and per login in each window (as the staff codes). */
export const MFA_TRIES = 5, MFA_TRIES_WINDOW = 15 * 60;

export type MfaEnrolment = { enc: string; kid: string; rc: string[]; at: string };
type Pending = { enc: string; kid: string; at: string };

export const mfaKey = (login: string) => `mfa:${normalizeEmail(login)}`;
const pendingKey = (login: string) => `mfa:pending:${normalizeEmail(login)}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const usedKey = (login: string, step: number) => `mfaotp:used:${sha(normalizeEmail(login))}:${step}`;
const ipBucket = (req: Request) => `mfacode:ip:${clientIp(req)}`;
const loginBucket = (login: string) => `mfacode:em:${sha(normalizeEmail(login))}`;

/** How a customer recovery code is kept: SHA-256 under its own label, never the code itself (rule 1932). */
export const mfaRecoveryHash = (code: string) => sha(`${MFA_RECOVERY_LABEL}:${cleanCode(code)}`);

const isEnrolment = (v: unknown): v is MfaEnrolment =>
  !!v && typeof v === "object" && typeof (v as MfaEnrolment).enc === "string" && typeof (v as MfaEnrolment).at === "string" && Array.isArray((v as MfaEnrolment).rc);

/**
 * The login's live enrolment, or null. `bornAt` is when the login record was created (an owner's `createdAt`, a
 * member's `acceptedAt`): an enrolment older than that belongs to a previous holder of the address and is ignored.
 */
export async function mfaActive(login: string, bornAt: string | undefined): Promise<MfaEnrolment | null> {
  const rec = await db.get<MfaEnrolment>(mfaKey(login));
  if (!isEnrolment(rec)) return null;
  const born = bornAt ? new Date(bornAt).getTime() : 0;
  if (!(new Date(rec.at).getTime() >= born)) return null;
  return rec;
}

/** Take one code try for this login and IP; null when allowed, else the 429. A right code hands both hits back. */
export async function takeMfaTry(req: Request, login: string): Promise<NextResponse | null> {
  const [one, two] = await Promise.all([allow(ipBucket(req), MFA_TRIES, MFA_TRIES_WINDOW), allow(loginBucket(login), MFA_TRIES, MFA_TRIES_WINDOW)]);
  return one && two ? null : retryLater({ ok: false, error: "slow_down" }, MFA_TRIES_WINDOW);
}
async function tryAccepted(req: Request, login: string): Promise<void> {
  await Promise.all([giveBack(ipBucket(req)), giveBack(loginBucket(login))]);
}

/** A 6-digit code against `secret`, burning its 30-second step for this login, so a code seen once never works twice. */
async function totpOnce(login: string, secret: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const step = totpMatch(secret, code, Date.now());
  if (step === null) return false;
  return db.setNx(usedKey(login, step), 1, 120);
}

export type MfaCheck = { ok: true; via: "totp" | "recovery"; left: number } | { ok: false; res: NextResponse };
export const badCode = () => NextResponse.json({ ok: false, error: "bad_code" }, { status: 400 });

/**
 * Check a code typed by the login (rate limited per IP and per login): the authenticator's 6 digits, or one recovery
 * code, which is spent under the login lock (`withLoginLock`, the lock every login write takes), so two requests can
 * never spend the same code. Recovery codes are accepted only where `recovery` is true.
 */
export async function checkMfaCode(req: Request, login: string, bornAt: string | undefined, code: unknown, { recovery = true }: { recovery?: boolean } = {}): Promise<MfaCheck> {
  if (typeof code !== "string" || code.length > 64) return { ok: false, res: badCode() };
  const slow = await takeMfaTry(req, login);
  if (slow) return { ok: false, res: slow };
  const typed = code.replace(/\s/g, "");
  if (recovery && looksLikeStaffCode(typed)) {
    const left = await withLoginLock(login, async () => {
      const rec = await mfaActive(login, bornAt);
      if (!rec) return -1;
      const i = recoveryIndex(rec.rc, typed, mfaRecoveryHash);
      if (i < 0) return -1;
      const rc = rec.rc.filter((_, j) => j !== i);
      await db.set(mfaKey(login), { ...rec, rc } satisfies MfaEnrolment);
      return rc.length;
    });
    if (left < 0) return { ok: false, res: badCode() };
    await tryAccepted(req, login);
    return { ok: true, via: "recovery", left };
  }
  const rec = await mfaActive(login, bornAt);
  const opened = rec ? openWithLabel(MFA_LABEL, rec) : null;
  if (!rec || !opened || !(await totpOnce(login, opened.secret, typed))) return { ok: false, res: badCode() };
  await tryAccepted(req, login);
  // A secret sealed with the previous CONNECT_SECRET is sealed again with the current one (as the staff secrets).
  if (opened.stale) await reseal(login, opened.secret).catch(() => {});
  return { ok: true, via: "totp", left: rec.rc.length };
}

async function reseal(login: string, secret: string): Promise<void> {
  await withLoginLock(login, async () => {
    const cur = await db.get<MfaEnrolment>(mfaKey(login));
    if (!isEnrolment(cur)) return;
    const fresh = openWithLabel(MFA_LABEL, cur);
    if (!fresh || fresh.secret !== secret || !fresh.stale) return;
    await db.set(mfaKey(login), { ...cur, ...sealWithLabel(MFA_LABEL, secret) } satisfies MfaEnrolment);
  });
}

/** Begin setup: a new secret kept sealed for 15 minutes until a code from it confirms it. Nothing is enrolled yet. */
export async function startMfaSetup(login: string): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  await db.set(pendingKey(login), { ...sealWithLabel(MFA_LABEL, secret), at: new Date().toISOString() } satisfies Pending, MFA_SETUP_TTL);
  return { secret, uri: otpauthUri(secret, normalizeEmail(login)) };
}

/**
 * Finish setup with a code from the new secret (rate limited, the step burned). Writes the enrolment with eight new
 * recovery codes' hashes and returns the codes: the only time they are shown. Under the login lock.
 */
export async function confirmMfaSetup(req: Request, login: string, code: unknown): Promise<{ ok: true; codes: string[] } | { ok: false; res: NextResponse }> {
  if (typeof code !== "string" || code.length > 64) return { ok: false, res: badCode() };
  const slow = await takeMfaTry(req, login);
  if (slow) return { ok: false, res: slow };
  const p = await db.get<Pending>(pendingKey(login));
  const opened = p && typeof p.enc === "string" ? openWithLabel(MFA_LABEL, p) : null;
  if (!p || !opened) return { ok: false, res: NextResponse.json({ ok: false, error: "no_setup" }, { status: 409 }) };
  if (!(await totpOnce(login, opened.secret, code.replace(/\s/g, "")))) return { ok: false, res: badCode() };
  const { codes, rc } = newRecoveryCodes(mfaRecoveryHash);
  await withLoginLock(login, async () => {
    await db.set(mfaKey(login), { ...sealWithLabel(MFA_LABEL, opened.secret), rc, at: new Date().toISOString() } satisfies MfaEnrolment);
    await db.del(pendingKey(login));
  });
  await tryAccepted(req, login);
  return { ok: true, codes };
}

/** Eight fresh recovery codes replace the old ones (the caller has checked the password and a code). */
export async function renewMfaRecovery(login: string, bornAt: string | undefined): Promise<string[] | null> {
  return withLoginLock(login, async () => {
    const rec = await mfaActive(login, bornAt);
    if (!rec) return null;
    const { codes, rc } = newRecoveryCodes(mfaRecoveryHash);
    await db.set(mfaKey(login), { ...rec, rc } satisfies MfaEnrolment);
    return codes;
  });
}

/** Turn two-step sign-in off for this login (the caller has checked the password and a code). */
export async function removeMfa(login: string): Promise<void> {
  await withLoginLock(login, () => Promise.all([db.del(mfaKey(login)), db.del(pendingKey(login))]));
}

/** What the settings card shows: whether it is on, since when and how many recovery codes are left. */
export async function mfaStatus(login: string, bornAt: string | undefined): Promise<{ enabled: boolean; at: string | null; recoveryLeft: number }> {
  const rec = await mfaActive(login, bornAt);
  return rec ? { enabled: true, at: rec.at, recoveryLeft: rec.rc.length } : { enabled: false, at: null, recoveryLeft: 0 };
}

/** Every key this login's two-step sign-in can hold, for the account wipe and the address move. */
export const mfaKeys = (login: string) => [mfaKey(login), pendingKey(login)];

// ---------------------------------------------------------------------------------------------------------------------
// The sign-in challenge (rule 1934): a proven password (or a Google sign-in) on a login with two-step sign-in on gets
// no session yet. It gets a random challenge id in an httpOnly cookie; the server keeps which login proved itself. The
// code then goes to POST /api/auth/login/mfa, which re-runs every login refusal before it creates the session.

/** The cookie that carries a pending sign-in challenge. */
export const MFA_COOKIE = "thakeen_mfa";
/** A password (or Google) proof waits this many seconds for its code. */
export const CHALLENGE_TTL = 5 * 60;
/** Wrong codes one challenge takes before it is dropped and the password must be typed again. */
export const CHALLENGE_TRIES = 5;
export type Challenge = { email: string; at: number; tries: number; via: "password" | "google"; next?: string };
export const challengeKey = (id: string) => `mfachal:${sha(id)}`;

/** Open a challenge for `email` and set its cookie. */
export async function openChallenge(email: string, via: Challenge["via"], next?: string): Promise<void> {
  const id = randomBytes(32).toString("base64url");
  await db.set(challengeKey(id), { email: normalizeEmail(email), at: Date.now(), tries: 0, via, ...(next ? { next } : {}) } satisfies Challenge, CHALLENGE_TTL);
  (await cookies()).set(MFA_COOKIE, id, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: CHALLENGE_TTL });
}

/** The challenge behind this browser's cookie, with its id, or null when there is none or it has expired. */
export async function readChallenge(): Promise<{ id: string; ch: Challenge } | null> {
  const id = (await cookies()).get(MFA_COOKIE)?.value;
  if (!id || id.length > 100) return null;
  const ch = await db.get<Challenge>(challengeKey(id));
  if (!ch || typeof ch.email !== "string" || Date.now() - Number(ch.at) > CHALLENGE_TTL * 1000) return null;
  return { id, ch };
}

/** Count one wrong code on the challenge; the fifth drops it. */
export async function failChallenge(id: string, ch: Challenge): Promise<void> {
  const tries = (Number(ch.tries) || 0) + 1;
  if (tries >= CHALLENGE_TRIES) {
    await db.del(challengeKey(id));
    return;
  }
  const left = Math.max(1, CHALLENGE_TTL - Math.floor((Date.now() - Number(ch.at)) / 1000));
  await db.setXx(challengeKey(id), { ...ch, tries } satisfies Challenge, left);
}

/** Spend the challenge: single use, so a replayed request after success finds nothing. True when this call took it. */
export async function takeChallenge(id: string): Promise<boolean> {
  const got = await db.getdel<Challenge>(challengeKey(id));
  (await cookies()).delete(MFA_COOKIE);
  return !!got;
}
