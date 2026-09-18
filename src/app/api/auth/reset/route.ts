import { createHash } from "crypto";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { allow, clientIp } from "@/lib/rate";

/** POST {token, password} → sets the new password, burns the token, signs the user in. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: string; password?: string };
  if (!(await allow(`reset:ip:${clientIp(req)}`, 10, 900))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const pw = b.password ?? "";
  if (pw.length < 8 || !/\p{L}/u.test(pw) || !/\d/.test(pw)) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (!b.token || !/^[a-f0-9]{64}$/.test(b.token)) return NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });
  const key = `pwreset:${createHash("sha256").update(b.token).digest("hex")}`;
  const rec = await db.get<{ email: string }>(key);
  const u = rec ? await getUser(rec.email) : null;
  if (!rec || !u) return NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });
  await db.del(key);
  if (u.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
  u.passHash = await bcrypt.hash(pw, 10);
  await saveUser(u);
  await createSession(u.email);
  return NextResponse.json({ ok: true });
}
