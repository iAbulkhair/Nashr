import { NextResponse } from "next/server";
import { db } from "./db";
import { allow, clientIp, giveBack, retryLater } from "./rate";
import { totpMatch } from "./totp";
import { openStaffSecret, saveStaff, sealStaffSecret, sha, withStaffLock, type Staff } from "./staff";

/**
 * A staff member's own authenticator code (rules 1632, 1636): checked against that person's secret, never the
 * console's `admin:2fa` one. Tries are limited per IP and per address (5 per 15 minutes each, as rules 1370-1384), a
 * right code hands its hits back, and every accepted 30-second step is burned per person
 * (`staffotp:used:{sha256(email)}:{step}`, 2 minutes), so a code seen over a shoulder cannot be replayed.
 */
export const STAFF_CODE_TRIES = 5, STAFF_CODE_WINDOW = 15 * 60;
const ipBucket = (req: Request) => `staffcode:ip:${clientIp(req)}`;
const emBucket = (email: string) => `staffcode:em:${sha(email)}`;

/** Take one try; null when allowed, else the 429. */
export async function takeStaffTry(req: Request, email: string): Promise<NextResponse | null> {
  const [one, two] = await Promise.all([allow(ipBucket(req), STAFF_CODE_TRIES, STAFF_CODE_WINDOW), allow(emBucket(email), STAFF_CODE_TRIES, STAFF_CODE_WINDOW)]);
  return one && two ? null : retryLater({ ok: false, error: "slow_down" }, STAFF_CODE_WINDOW);
}
export async function staffTryAccepted(req: Request, email: string): Promise<void> {
  await Promise.all([giveBack(ipBucket(req)), giveBack(emBucket(email))]);
}

/** A 6-digit code against `secret`, burning the step for this person. False for a wrong or already used code. */
export async function staffTotpOnce(email: string, secret: string, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const step = totpMatch(secret, code, Date.now());
  if (step === null) return false;
  return db.setNx(`staffotp:used:${sha(email)}:${step}`, 1, 120);
}

export const badCode = () => NextResponse.json({ ok: false, error: "bad_code" }, { status: 400 });

/**
 * Check a 6-digit code from the person's own authenticator (rate limited). Recovery codes are not taken here: they are
 * spent only at sign-in, after the password (rule 1642). A secret sealed with the previous CONNECT_SECRET is sealed
 * again with the current one once a code from it is accepted (rule 1654).
 */
export async function checkStaffCode(req: Request, staff: Staff, code: unknown): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  if (typeof code !== "string" || code.length > 64) return { ok: false, res: badCode() };
  const slow = await takeStaffTry(req, staff.email);
  if (slow) return { ok: false, res: slow };
  const opened = openStaffSecret(staff.totp);
  if (!opened || !(await staffTotpOnce(staff.email, opened.secret, code))) return { ok: false, res: badCode() };
  await staffTryAccepted(req, staff.email);
  if (opened.stale) await resealStaffSecret(staff.email, opened.secret);
  return { ok: true };
}

/** Seal the person's secret again with the current key (after a CONNECT_SECRET rotation). A failure changes nothing. */
export async function resealStaffSecret(email: string, secret: string): Promise<void> {
  await withStaffLock(email, async (s) => {
    if (!s?.totp) return;
    const fresh = openStaffSecret(s.totp);
    if (!fresh || fresh.secret !== secret || !fresh.stale) return;
    s.totp = { ...sealStaffSecret(secret), at: s.totp.at };
    await saveStaff(s);
  }).catch(() => {});
}
