import { createHash } from "crypto";
import { isSuspended } from "@/lib/suspension";
import { suspendedAnswer } from "@/lib/login-finish";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSession, emailVerified, getLogin, revokeSessions, revokeTeamSessions, saveUser, strongPassword } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { revokeAllMcp } from "@/lib/mcp";
import { revokeBook, revokeBooks } from "@/lib/booking-token";
import { revokeFeed, revokeFeeds } from "@/lib/feed-token";
import { revokeCalendarLinks } from "@/lib/secretary-gcal";
import { membersKey, saveMember, withMemberLock } from "@/lib/team";
import { db } from "@/lib/db";
import { allow, clientIp, retryLater } from "@/lib/rate";

/** Written by ../forgot/route.ts. Records from before teams carry no `kind`: every login was an owner then. */
type ResetRecord = { email: string; kind?: "owner" | "member" };

const badToken = () => NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });

/**
 * POST {token, password} → sets the new password of the login the token was issued for, burns the token, signs that
 * login in. A member's reset writes the member record only: it never touches the owner's hash, sessions or tokens.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: string; password?: string };
  if (!(await allow(`reset:ip:${clientIp(req)}`, 10, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
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
    if (isSuspended(owner)) return suspendedAnswer(owner);
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
    // The member's own calendar feed and booking links end with the password they were made under, as an owner's MCP
    // tokens do. Only this login's: the owner's links and the rest of the team's are untouched.
    await Promise.all([revokeFeed(member.email), revokeBook(member.email)]);
    // A seat-paused member gets the new password but no session: `currentUser` refuses it until the owner has room.
    if (member.disabled) return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
    // Likewise while the owner has not proved the address (rule 767): `currentUser` refuses the member, as login does.
    if (!emailVerified(owner)) return NextResponse.json({ ok: false, error: "owner_unverified" }, { status: 403 });
    await createSession(member.email);
    return NextResponse.json({ ok: true });
  }

  const owner = login.user;
  if (isSuspended(owner)) return suspendedAnswer(owner);
  // A reset is what an owner does after losing control of the account: the owner's sessions, every member's session
  // (each signs back in with their own password) and every MCP token die with the old password.
  // Rule 769: the link was mailed to this very address and used once, which proves the inbox as well as a code does, so
  // an owner who has not verified yet is verified here (the date is kept when there is one). A member's reset proves the
  // member's address, not the owner's, and never comes here.
  await withUserLock(owner.email, async (x) => { x.passHash = hash; x.emailVerifiedAt ??= new Date().toISOString(); revokeSessions(x); revokeTeamSessions(x); await saveUser(x); });
  // The owner's calendar feed and booking links and every member's go with the MCP tokens, as every member's session does above (the
  // password and the sessions are already saved: a failure here is a 500 and the user asks for a new reset link).
  const roster = await db.smembers(membersKey(owner.email));
  // The owner's linked marketing calendars (Reem B3) end with them too: whoever holds the account next links their own.
  await Promise.all([revokeAllMcp(owner.email), revokeFeeds([owner.email, ...roster]), revokeBooks([owner.email, ...roster]), revokeCalendarLinks(owner.email)]);
  await createSession(owner.email);
  return NextResponse.json({ ok: true });
}
