import { createHash } from "crypto";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, getLogin, revokeSessions, revokeTeamSessions, saveUser, strongPassword } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { revokeAllMcp } from "@/lib/mcp";
import { revokeFeed } from "@/lib/feed-token";
import { saveMember, withMemberLock } from "@/lib/team";
import { db } from "@/lib/db";
import { allow, clientIp } from "@/lib/rate";

/** Written by ../forgot/route.ts. Records from before teams carry no `kind`: every login was an owner then. */
type ResetRecord = { email: string; kind?: "owner" | "member" };

const badToken = () => NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });

/**
 * POST {token, password} → sets the new password of the login the token was issued for, burns the token, signs that
 * login in. A member's reset writes the member record only: it never touches the owner's hash, sessions or tokens.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: string; password?: string };
  if (!(await allow(`reset:ip:${clientIp(req)}`, 10, 900))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const pw = typeof b.password === "string" ? b.password : "";
  if (!strongPassword(pw)) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (typeof b.token !== "string" || !/^[a-f0-9]{64}$/.test(b.token)) return badToken();
  const id = createHash("sha256").update(b.token).digest("hex");
  const key = `pwreset:${id}`;
  const rec = await db.get<ResetRecord>(key);
  if (!rec || typeof rec.email !== "string") return badToken();
  // Single use. Reading then deleting let two requests racing on one link both pass the read; SET NX lets one through.
  if (!(await db.lock(`pwresetuse:${id}`, 3600))) return badToken();
  await db.del(key);
  const kind = rec.kind === "member" ? "member" : "owner";
  const login = await getLogin(rec.email);
  // The login must still be the one the link was issued for: a member removed since, or an address that changed sides,
  // gets nothing.
  if (!login || login.kind !== kind) return badToken();
  const hash = await bcrypt.hash(pw, 10);

  if (login.kind === "member") {
    const { member, owner } = login;
    if (!owner || member.memberOf !== owner.email) return badToken();
    if (owner.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
    // The member record only, under its own lock. Every other device of THIS member is signed out; the owner and the
    // rest of the team are untouched.
    const done = await withMemberLock(member.email, async (m) => {
      if (m.memberOf !== owner.email) return false;
      m.passHash = hash;
      m.sessionsAfter = new Date().toISOString();
      await saveMember(m);
      return true;
    });
    if (!done) return badToken();
    // The member's own calendar link ends with the password it was made under, as an owner's MCP tokens do. Only this
    // login's: the owner's link and the rest of the team's are untouched.
    await revokeFeed(member.email);
    // A seat-paused member gets the new password but no session: `currentUser` refuses it until the owner has room.
    if (member.disabled) return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
    await createSession(member.email);
    return NextResponse.json({ ok: true });
  }

  const owner = login.user;
  if (owner.suspended) return NextResponse.json({ ok: false, error: "suspended" }, { status: 403 });
  // A reset is what an owner does after losing control of the account: the owner's sessions, every member's session
  // (each signs back in with their own password) and every MCP token die with the old password.
  await withUserLock(owner.email, async (x) => { x.passHash = hash; revokeSessions(x); revokeTeamSessions(x); await saveUser(x); });
  // The owner's calendar link goes with the MCP tokens (a failure of either is a 500, never a half-done reset).
  await Promise.all([revokeAllMcp(owner.email), revokeFeed(owner.email)]);
  await createSession(owner.email);
  return NextResponse.json({ ok: true });
}
