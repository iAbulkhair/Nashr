import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { listNotifs, markAllRead } from "@/lib/notifications";

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const all = await listNotifs(u.email);
  const unread = all.filter((n) => !n.read).length;
  if (new URL(req.url).searchParams.get("count")) return NextResponse.json({ ok: true, unread });
  return NextResponse.json({ ok: true, notifications: all, unread });
}
export async function POST() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  await markAllRead(u.email);
  return NextResponse.json({ ok: true });
}
