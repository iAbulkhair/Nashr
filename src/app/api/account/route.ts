import { NextResponse } from "next/server";
import { currentUser, destroySession, verifyPassword } from "@/lib/auth";
import { wipeAccount } from "@/lib/account";
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
  await wipeAccount(u.email);
  await destroySession();
  return NextResponse.json({ ok: true });
}
