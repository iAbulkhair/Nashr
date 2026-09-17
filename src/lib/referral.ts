import { adjust } from "./credits";
import { createHash } from "crypto";
import { db } from "./db";
import { getUser } from "./auth";

export const REFERRAL_CREDITS = 50;

export function codeFor(email: string) {
  return createHash("sha256").update("nashr-ref:" + email).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
}
export async function registerCode(email: string) {
  const code = codeFor(email);
  await db.set(`ref:${code}`, email);
  return code;
}
export async function ownerOf(code: string) {
  return db.get<string>(`ref:${code.toUpperCase()}`);
}
/** Called once on signup. Credits both sides. */
export async function applyReferral(newEmail: string, code: string) {
  const refEmail = await ownerOf(code);
  if (!refEmail || refEmail === newEmail) return false;
  const [ref, nu] = await Promise.all([getUser(refEmail), getUser(newEmail)]);
  if (!ref || !nu) return false;
  await adjust(refEmail, REFERRAL_CREDITS);
  await adjust(newEmail, REFERRAL_CREDITS);
  await db.lpush(`referrals:${refEmail}`, JSON.stringify({ email: newEmail, at: new Date().toISOString() }));
  await db.set(`referredBy:${newEmail}`, refEmail);
  return true;
}
export async function referralStats(email: string) {
  const rows = await db.lrange(`referrals:${email}`, 0, 99);
  return { code: codeFor(email), count: rows.length, earned: rows.length * REFERRAL_CREDITS, rows: rows.map((r) => JSON.parse(r) as { email: string; at: string }) };
}
