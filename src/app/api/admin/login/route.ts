import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const COOKIE = "nashr_admin";
export const ADMIN_COOKIE = COOKIE;

export async function POST(req: Request) {
  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  if (!process.env.WAITLIST_ADMIN_KEY || key !== process.env.WAITLIST_ADMIN_KEY) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(COOKIE, key, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(COOKIE);
  return NextResponse.json({ ok: true });
}
