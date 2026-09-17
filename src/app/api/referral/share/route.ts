import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { adjust } from "@/lib/credits";
import { db } from "@/lib/db";

export const SHARE_CREDITS = 20;
const PLATFORMS = ["x", "linkedin", "whatsapp", "instagram"];

/** POST {platform} → one-time credits for sharing Nashr on a social platform (once per platform per account). */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { platform?: string };
  if (!b.platform || !PLATFORMS.includes(b.platform)) return NextResponse.json({ ok: false, error: "bad_platform" }, { status: 400 });
  const key = `shared:${u.email}:${b.platform}`;
  if (await db.get(key)) return NextResponse.json({ ok: true, credited: 0, credits: u.credits, already: true });
  await db.set(key, new Date().toISOString());
  const credits = await adjust(u.email, SHARE_CREDITS);
  return NextResponse.json({ ok: true, credited: SHARE_CREDITS, credits });
}
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const done: string[] = [];
  for (const p of PLATFORMS) if (await db.get(`shared:${u.email}:${p}`)) done.push(p);
  return NextResponse.json({ ok: true, done, credits: SHARE_CREDITS });
}
