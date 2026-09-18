import { db } from "./db";

/** Fixed-window rate limit. True when the caller is still inside the allowance. */
export async function allow(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = `rate:${bucket}`;
  const n = await db.incrby(key, 1);
  // First hit in the window sets the expiry; the counter value itself is preserved.
  if (n === 1) await db.set(key, 1, windowSeconds);
  return n <= max;
}

export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
