import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { createSession, getUser, normalizeEmail, verifyPassword } from "@/lib/auth";
import { allow, clientIp } from "@/lib/rate";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(b.email ?? "");
  // Credential stuffing and password guessing: throttle per IP and per targeted account.
  if (!(await allow(`login:ip:${clientIp(req)}`, 20, 900)) || !(await allow(`login:em:${email}`, 8, 900))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const u = await getUser(email);
  if (!u || !(await verifyPassword(u, b.password ?? ""))) return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  if (u.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
  await createSession(u.email);
  await track(u.email, "login");
  return NextResponse.json({ ok: true });
}
