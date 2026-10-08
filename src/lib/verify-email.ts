import { createHash, randomInt } from "crypto";
import { db } from "./db";
import { saveUser, type User } from "./auth";
import { withUserLock } from "./credits";
import { sameSecret } from "./rate";
import { isProductionDeploy } from "./deploy-env";
import { mailReady, sendEmail } from "./notify";

/**
 * Email verification codes (rules 757-758). A new owner proves the address with a 6-digit code mailed to it; until then
 * the account reads as signed out (rule 751).
 *
 * Only a SHA-256 hash of the code is stored (`verify:code:{email}`), so a Redis read never reveals a live code, and the
 * hash is salted with the address so one guess does not match two accounts. The record expires with the code (900 s).
 *
 * Wrong guesses are counted in their own key (`verify:tries:{email}`) with an atomic INCRBY BEFORE the comparison, not
 * read-modify-written inside the code record: twelve parallel guesses each get a distinct count, so no more than five
 * ever reach the comparison. The fifth wrong answer deletes the code. Callers pass the session's normalized email,
 * never an address taken from the request.
 */
export const VERIFY = { ttl: 900, attempts: 5, gap: 60, perHour: 5, perIpHour: 20, movesPerDay: 3 } as const;

const codeKey = (email: string) => `verify:code:${email}`;
const triesKey = (email: string) => `verify:tries:${email}`;
const hashOf = (email: string, code: string) => createHash("sha256").update(`nashr-verify:${email}:${code}`).digest("hex");

type CodeRecord = { hash: string; sentAt: number };
export type CheckResult = { ok: true } | { ok: false; reason: "expired" | "wrong" | "locked"; attemptsLeft?: number };

/** Turn what the owner typed into digits: Arabic-Indic and Persian digits become Latin, everything else is dropped. */
export function normalizeCode(typed: string): string {
  return String(typed ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, "");
}

/** A fresh code replaces any older one and resets the attempts. Returns the code for the mail; it is stored only hashed. */
export async function issueVerifyCode(email: string): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const rec: CodeRecord = { hash: hashOf(email, code), sentAt: Date.now() };
  await Promise.all([db.set(codeKey(email), rec, VERIFY.ttl), db.del(triesKey(email))]);
  return code;
}

/**
 * Compare what was typed with the stored hash. Does not consume the code: the verify route calls `markVerified` after
 * an `ok`, which is what deletes it.
 */
export async function checkVerifyCode(email: string, typed: string): Promise<CheckResult> {
  const rec = await db.get<CodeRecord>(codeKey(email));
  if (!rec) return { ok: false, reason: "expired" };
  const n = await db.incrby(triesKey(email), 1);
  await db.expireNx(triesKey(email), VERIFY.ttl);
  if (n > VERIFY.attempts) {
    await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
    return { ok: false, reason: "locked" };
  }
  if (sameSecret(rec.hash, hashOf(email, normalizeCode(typed)))) return { ok: true };
  if (n >= VERIFY.attempts) {
    await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
    return { ok: false, reason: "locked" };
  }
  return { ok: false, reason: "wrong", attemptsLeft: VERIFY.attempts - n };
}

/** Whether a code is waiting for this address (issued, not expired, not consumed or locked). */
export async function hasPendingCode(email: string): Promise<boolean> {
  return (await db.get(codeKey(email))) !== null;
}

/** Stamp the address as proved (kept if it already is, so a repeat never moves the date) and drop the code and its counter. */
export async function markVerified(email: string): Promise<void> {
  await withUserLock(email, async (u) => {
    if (!u.emailVerifiedAt) {
      u.emailVerifiedAt = new Date().toISOString();
      await saveUser(u);
    }
  });
  await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
}

/** The plain-text mail carrying the code, in the owner's language. */
export function verifyMail(u: Pick<User, "lang">, code: string): { subject: string; text: string } {
  return u.lang === "en"
    ? {
        subject: `Your Thakeen code: ${code}`,
        text: `Your verification code: ${code}\nIt works for 15 minutes.\nIf you did not ask for it, ignore this email.`,
      }
    : {
        subject: `رمز التحقق في ذكين: ${code}`,
        text: `رمز التحقق: ${code}\nصالح لمدة 15 دقيقة.\nإذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.`,
      };
}

/** Drop a pending code and its attempt counter (a code nobody received must not be left to guess against). */
export async function dropVerifyCode(email: string): Promise<void> {
  await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
}

/**
 * Rule 766: a test deploy (`APP_ENV=test`, never a production deploy) hands the code back in the response, so the e2e
 * suite can verify an account without a mailbox. Nothing else ever returns a code.
 */
export const devCodeExposed = (): boolean => process.env.APP_ENV === "test" && !isProductionDeploy();

/**
 * Issue a fresh code and mail it in the owner's language. `sent` is whether the mail went out (false when mail is off, the
 * provider refused it or the call threw). A code nobody received is dropped, except on a test deploy (`devCodeExposed`),
 * where the caller hands it back as `devCode`. The address is the session's `u.email`, never one from a request.
 */
export async function sendVerifyCode(u: Pick<User, "email" | "lang">): Promise<{ sent: boolean; code: string }> {
  const code = await issueVerifyCode(u.email);
  let sent = false;
  if (mailReady()) {
    const m = verifyMail(u, code);
    sent = await sendEmail(u.email, m.subject, m.text).catch(() => false);
  }
  if (!sent && !devCodeExposed()) await dropVerifyCode(u.email);
  return { sent, code };
}
