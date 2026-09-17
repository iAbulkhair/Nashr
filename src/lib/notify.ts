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
  const k = `notified:${email}:${key}`;
  if (await db.get(k)) return false;
  await db.set(k, new Date().toISOString());
  return true;
}
