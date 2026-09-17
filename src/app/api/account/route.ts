import { NextResponse } from "next/server";
import { currentUser, destroySession, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { listTasks } from "@/lib/brand";
import { listFiles } from "@/lib/files";
import bcrypt from "bcryptjs";
import { saveUser } from "@/lib/auth";

/** PATCH {currentPassword, newPassword} · DELETE {password} → wipe account */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  if (!b.newPassword || b.newPassword.length < 8) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (!(await verifyPassword(u, b.currentPassword ?? ""))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  u.passHash = await bcrypt.hash(b.newPassword, 10);
  await saveUser(u);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { password?: string };
  if (!(await verifyPassword(u, b.password ?? ""))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  const e = u.email;
  for (const t of await listTasks(e)) await db.del(`task:${e}:${t.id}`);
  for (const f of await listFiles(e)) await db.del(`file:${e}:${f.name}`);
  for (const k of [`tasks:${e}`, `files:${e}`, `brand:${e}`, `prefs:${e}`, `chat:${e}`, `gov:${e}`, `schedule:${e}`, `brief:${e}`, `profile:${e}`, `conns:${e}`, `mcptoken-of:${e}`, `user:${e}`]) await db.del(k);
  await db.lpush("deleted-accounts", JSON.stringify({ email: e, at: new Date().toISOString() }));
  await destroySession();
  return NextResponse.json({ ok: true });
}
