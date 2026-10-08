import { track } from "@/lib/track";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, getLogin, normalizeEmail } from "@/lib/auth";
import { allow, clientIp, retryLater } from "@/lib/rate";

/**
 * POST {email, password}. An email signs in as whatever login it is (src/lib/auth.ts `getLogin`): an owner account or a
 * member of one. The password is checked against THAT login's own hash, so an owner's password never opens a member
 * login and a member's never opens the owner's. The session is issued for the login email; `currentUser` resolves a
 * member session to the owner's account on every request.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  const password = typeof b.password === "string" ? b.password : "";
  // Credential stuffing and password guessing: throttle per IP and per targeted login.
  if (!(await allow(`login:ip:${clientIp(req)}`, 20, 900)) || !(await allow(`login:em:${email}`, 8, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const login = email ? await getLogin(email) : null;
  const hash = !login ? null : login.kind === "owner" ? login.user.passHash : login.member.passHash;
  if (!hash || !(await bcrypt.compare(password, hash))) return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });

  if (login!.kind === "owner") {
    const owner = login!.user;
    if (owner.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
    await createSession(owner.email);
    await track(owner.email, "login");
    return NextResponse.json({ ok: true });
  }

  // A member: the account it belongs to must still exist, not be suspended, and not be a newer account registered at
  // the same address (the same checks `currentUser` makes on every request, answered here so the form can say why).
  const { member, owner } = login!;
  if (!owner || member.memberOf !== owner.email || !(new Date(member.acceptedAt).getTime() >= new Date(owner.createdAt).getTime())) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  }
  if (owner.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
  // Paused by the seat limit (a plan downgrade): kept, never deleted, and back when the owner has room again.
  if (member.disabled) return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
  await createSession(member.email);
  // Product analytics count ACCOUNTS: a member's activity is the owner's account being active. `wipeAccount` deletes
  // the owner-keyed counters, so nothing keyed by the member's address is left behind.
  await track(owner.email, "login");
  return NextResponse.json({ ok: true });
}
