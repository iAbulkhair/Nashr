import { db } from "./db";

/** Notification channels. Email via Resend when RESEND_API_KEY is set; WhatsApp when the Business API is approved. */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    await resend.emails.send({ from: process.env.MAIL_FROM ?? "Noor at Nashr <onboarding@resend.dev>", to, subject, text });
    return true;
  } catch (e) {
    console.error("email failed", e);
    return false;
  }
}

/** Once-only guard for a named notification per user. */
export async function once(email: string, key: string): Promise<boolean> {
  // One atomic step, not read-then-write: two cron runs overlapping on the same user would otherwise both see nothing
  // and both send. `lock` is SET NX EX, so exactly one caller gets true, and the TTL bounds a marker that used to live
  // for ever.
  const first = await db.lock(onceKey(email, key), ONCE_TTL_SECONDS);
  // The suffix is caller-chosen (`weekly:2026-09-20`, `nudge1`, …) and the store has no key scan, so the names are
  // recorded here; without this an account deletion cannot find them and the address outlives the account.
  if (first) await db.sadd(ONCE_INDEX(email), key);
  return first;
}
export const onceKey = (email: string, key: string) => `notified:${email}:${key}`;
export const ONCE_INDEX = (email: string) => `notifiedkeys:${email}`;
/** Long enough that a "once ever" nudge is never repeated in practice, short enough that the key does not outlive the account. */
const ONCE_TTL_SECONDS = 400 * 86400;
