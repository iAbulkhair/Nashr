import { NextResponse } from "next/server";
import { createSession, currentUser, destroySession, revokeSessions, saveUser } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { forbid } from "@/lib/roles";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { ownPasswordMatches } from "@/lib/own-password";
import { saveMember, withMemberLock } from "@/lib/team";

/** Tries per login and hour: a wrong password answers 401, and this bounds guessing it here. */
const SIGN_OUT_OTHERS_PER_HOUR = 10;

/**
 * POST /api/account/sessions {password} (rule 1150): sign out every OTHER browser session of the acting login, and keep
 * this one. No new stored shape: it moves the revocation stamp the password change already moves (`sessionsAfter` on
 * the member record for a member, on the account for the owner; a member's sign-out never touches the owner's sessions
 * or the other members'), then gives this device a fresh session issued after the stamp. Sessions are not listed: the
 * store keeps them as unindexed `session:{token}` keys, so the list waits for a later phase.
 *
 * Old sessions, deliberately: a session stored before sessions carried a time (a bare email string, read as issued at 0)
 * is older than any stamp and is signed out too. MCP tokens, connected apps, the calendar feed and booking links are not
 * sessions and stay (the password change ends those). Needs the login's own password, so a stolen cookie cannot use it
 * to push the real person out; refused while a founder impersonates (`sessions.revoke`), rate limited per login.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "sessions.revoke");
  if (no) return no;
  const a = u.actor!;
  if (!(await allow(`signoutothers:${a.email}`, SIGN_OUT_OTHERS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (!(await ownPasswordMatches(u, b.password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  if (a.kind === "member") {
    const done = await withMemberLock(a.email, async (m) => {
      if (m.memberOf !== u.email) return false;
      m.sessionsAfter = new Date().toISOString();
      await saveMember(m);
      return true;
    });
    if (!done) return NextResponse.json({ ok: false }, { status: 401 });
  } else {
    // Inside the user lock, on the fresh record: saving the copy read at the start of the request could undo a credit charge.
    await withUserLock(u.email, async (x) => { revokeSessions(x); await saveUser(x); });
  }
  // This device stays signed in, as the same login, with a session issued after the stamp.
  await destroySession();
  await createSession(a.email);
  return NextResponse.json({ ok: true });
}
