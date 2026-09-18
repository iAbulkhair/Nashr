import { createHash } from "crypto";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, getUser, revokeSessions, saveUser, strongPassword } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { revokeAllMcp } from "@/lib/mcp";
import { db } from "@/lib/db";
import { allow, clientIp } from "@/lib/rate";

/** POST {token, password} → sets the new password, burns the token, signs the user in. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: string; password?: string };
  if (!(await allow(`reset:ip:${clientIp(req)}`, 10, 900))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const pw = b.password ?? "";
  if (!strongPassword(pw)) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (!b.token || !/^[a-f0-9]{64}$/.test(b.token)) return NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });
  const key = `pwreset:${createHash("sha256").update(b.token).digest("hex")}`;
  const rec = await db.get<{ email: string }>(key);
  const u = rec ? await getUser(rec.email) : null;
  if (!rec || !u) return NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });
  await db.del(key);
  if (u.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
  const hash = await bcrypt.hash(pw, 10);
  await withUserLock(u.email, async (x) => { x.passHash = hash; revokeSessions(x); await saveUser(x); });
  // A reset is what an owner does after losing control of the account: old sessions and every MCP token die with the old password.
  await revokeAllMcp(u.email);
  await createSession(u.email);
  return NextResponse.json({ ok: true });
}
