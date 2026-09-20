import { timingSafeEqual } from "crypto";
import { db } from "./db";

/** Fixed-window rate limit. True when the caller is still inside the allowance. */
export async function allow(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = `rate:${bucket}`;
  const n = await db.incrby(key, 1);
  // First hit in the window sets the expiry; the counter value itself is preserved.
  if (n === 1) await db.set(key, 1, windowSeconds);
  return n <= max;
}

/** Client IP for throttling. Platform-set headers first; the caller-suppliable x-forwarded-for is the last resort and its LAST hop is used. */
export const clientIp = (req: Request) =>
  (req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0].trim() ||
  (req.headers.get("x-forwarded-for") ?? "").split(",").pop()!.trim() || "unknown";

/**
 * Chat turns per account. A turn is free in credits but is the most expensive call in the product (up to five model
 * calls with the full workspace in the prompt), so the spend of a single account is bounded here. Generous enough that
 * no real conversation hits it: the ceiling is roughly a day of continuous use.
 */
export const CHAT_PER_HOUR = 40;
export const CHAT_PER_DAY = 200;
export async function chatAllowed(email: string): Promise<boolean> {
  const [hour, day] = await Promise.all([allow(`chat:h:${email}`, CHAT_PER_HOUR, 3600), allow(`chat:d:${email}`, CHAT_PER_DAY, 86400)]);
  return hour && day;
}

/** Constant-time string comparison for secrets. */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = Buffer.from(a ?? ""), y = Buffer.from(b ?? "");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
