import { NextResponse } from "next/server";
import { createSession, currentUser, destroySession, revokeSessions, verifyPassword, strongPassword } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { wipeAccount } from "@/lib/account";
import bcrypt from "bcryptjs";
import { saveUser } from "@/lib/auth";

/** PATCH {currentPassword, newPassword} · DELETE {password} → wipe account */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  const pw = b.newPassword ?? "";
  if (!strongPassword(pw)) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (!(await verifyPassword(u, b.currentPassword ?? ""))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  const hash = await bcrypt.hash(pw, 10);
  // Inside the user lock, on the fresh record: saving the copy read at the start of the request could undo a credit charge.
  await withUserLock(u.email, async (x) => { x.passHash = hash; revokeSessions(x); await saveUser(x); });
  // Every other device is signed out; this one gets a new session.
  await destroySession();
  await createSession(u.email);
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
