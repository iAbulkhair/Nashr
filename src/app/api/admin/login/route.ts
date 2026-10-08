import { NextResponse } from "next/server";
import { allow, clientIp, sameSecret, retryLater } from "@/lib/rate";
import { createAdminSession, destroyAdminSession } from "@/lib/auth";

/**
 * The founder console's key form. A right key opens a server-side key session (src/lib/auth.ts `createAdminSession`)
 * that ends after 15 minutes without an admin request and 12 hours after the key entry at most: the cookie carries a
 * random id, never the key. DELETE ends it on the server.
 */
export async function POST(req: Request) {
  // Five attempts per 15 minutes per IP: the key must not be guessable by brute force.
  if (!(await allow(`adminkey:${clientIp(req)}`, 5, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const { key } = (await req.json().catch(() => ({}))) as { key?: unknown };
  if (typeof key !== "string" || !sameSecret(key, process.env.WAITLIST_ADMIN_KEY)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  await createAdminSession();
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await destroyAdminSession();
  return NextResponse.json({ ok: true });
}
