import { NextResponse } from "next/server";
import { createSession, getUser, normalizeEmail, verifyPassword } from "@/lib/auth";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const u = await getUser(normalizeEmail(b.email ?? ""));
  if (!u || !(await verifyPassword(u, b.password ?? ""))) return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  if (u.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
  await createSession(u.email);
  return NextResponse.json({ ok: true });
}
