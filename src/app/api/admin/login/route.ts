import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "crypto";
import { allow, clientIp } from "@/lib/rate";

const COOKIE = "nashr_admin";
export const ADMIN_COOKIE = COOKIE;

export async function POST(req: Request) {
  // Five attempts per 15 minutes per IP: the key must not be guessable by brute force.
  if (!(await allow(`adminkey:${clientIp(req)}`, 5, 900))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  const want = Buffer.from(process.env.WAITLIST_ADMIN_KEY ?? ""), got = Buffer.from(String(key ?? ""));
  if (!want.length || want.length !== got.length || !timingSafeEqual(want, got)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(COOKIE, String(key), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(COOKIE);
  return NextResponse.json({ ok: true });
}
