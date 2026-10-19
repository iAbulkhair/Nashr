import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createSession, currentUser, destroySession, revokeSessions, saveUser, strongPassword } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { wipeAccount } from "@/lib/account";
import { revokeAllMcp } from "@/lib/mcp";
import { revokeBook } from "@/lib/booking-token";
import { revokeFeed } from "@/lib/feed-token";
import { forbid } from "@/lib/roles";
import { saveMember, withMemberLock } from "@/lib/team";
import { ownPasswordMatches as matches } from "@/lib/own-password";
import { acct } from "@/lib/account-id";

/**
 * PATCH {currentPassword, newPassword}: the acting login changes ITS OWN password. A member rewrites the member record
 * and signs out only its own other devices; the owner rewrites the account's and also loses every MCP token and grant.
 * Refused while a founder impersonates. DELETE {password}: wipe the account, owner only.
 */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "password.change");
  if (no) return no;
  const a = u.actor!;
  const b = (await req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  const pw = typeof b.newPassword === "string" ? b.newPassword : "";
  if (!strongPassword(pw)) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (!(await matches(u, b.currentPassword))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  const hash = await bcrypt.hash(pw, 10);

  if (a.kind === "member") {
    // The member record only, under its own lock. Every other device of this member is signed out; the owner's hash,
    // sessions, MCP token and connected apps are not touched.
    const done = await withMemberLock(a.email, async (m) => {
      if (m.memberOf !== acct(u)) return false;
      m.passHash = hash;
      m.sessionsAfter = new Date().toISOString();
      await saveMember(m);
      return true;
    });
    if (!done) return NextResponse.json({ ok: false }, { status: 401 });
    // This member's own calendar feed and booking links end with the old password; the owner's and the others' stay.
    await Promise.all([revokeFeed(a.email), revokeBook(a.email)]);
  } else {
    // Inside the user lock, on the fresh record: saving the copy read at the start of the request could undo a credit charge.
    await withUserLock(acct(u), async (x) => { x.passHash = hash; revokeSessions(x); await saveUser(x); });
    // Every other device is signed out, and every MCP token and connected app dies with the old password, exactly as in
    // the reset route: a stolen bearer token must not outlive the password it was obtained with.
    await Promise.all([revokeAllMcp(acct(u)), revokeFeed(u.email), revokeBook(u.email)]);
  }
  // This device stays signed in, as the same login that made the change.
  await destroySession();
  await createSession(a.email);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Owner only, never while a founder impersonates: the wipe cascades to every member login, invite and brand.
  const no = forbid(u, "account.delete");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { password?: string };
  if (!(await matches(u, b.password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await wipeAccount(acct(u));
  await destroySession();
  return NextResponse.json({ ok: true });
}
