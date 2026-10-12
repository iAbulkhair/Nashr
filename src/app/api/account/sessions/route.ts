import { NextResponse } from "next/server";
import { currentUser, rotateSession, saveUser } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { forbid } from "@/lib/roles";
import { allow, giveBack, retryLater, WINDOW } from "@/lib/rate";
import { ownPasswordMatches } from "@/lib/own-password";
import { saveMember, withMemberLock } from "@/lib/team";

/** Wrong passwords per login and hour: a wrong password answers 401, and this bounds guessing it here. */
const SIGN_OUT_OTHERS_PER_HOUR = 10;

/**
 * POST /api/account/sessions {password} (rules 1150, 1170-1171): sign out every OTHER browser session of the acting
 * login, and keep this one. It stamps `devicesAfter` (the member record for a member, the account for the owner; a
 * member's sign-out never touches the owner's sessions or the other members'), a stamp only `resolveSession` reads.
 * Sessions are not listed: the store keeps them as unindexed `session:h:{sha256(token)}` keys (rule 1265), so the list waits for a later phase.
 *
 * What stays: MCP tokens, connected apps, the calendar feed and booking links. They follow `sessionsAfter` (`loginHolds`
 * in src/lib/secretary-feed.ts), which only a password change or reset moves; this route never moves it (rule 1170).
 * Old sessions, deliberately: a session stored before sessions carried a time (a bare email string, read as issued at 0)
 * is older than any stamp and is signed out too.
 *
 * Needs the login's own password, so a stolen cookie cannot use it to push the real person out; refused while a founder
 * impersonates (`sessions.revoke`). The limit counts wrong passwords only (rules 1170 and 1183): every try takes a hit
 * with `allow` before the password is compared (one atomic INCR, so parallel tries with a stolen cookie cannot all pass
 * a read of the counter), and a correct password gives its hit back, so the real owner's tries never use it up.
 * Order (rule 1171): `rotateSession` writes this device's new session first, then the stamp, then drops the old record,
 * so a failure at any step leaves this device signed in.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "sessions.revoke");
  if (no) return no;
  const a = u.actor!;
  const bucket = `signoutothers:${a.email}`;
  if (!(await allow(bucket, SIGN_OUT_OTHERS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (!(await ownPasswordMatches(u, b.password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await giveBack(bucket);
  const done = await rotateSession(a.email, async (stamp) => {
    if (a.kind === "member") {
      const ok = await withMemberLock(a.email, async (m) => {
        if (m.memberOf !== u.email) return false;
        m.devicesAfter = stamp;
        await saveMember(m);
        return true;
      });
      return ok === true;
    }
    // Inside the user lock, on the fresh record: saving the copy read at the start of the request could undo a credit charge.
    await withUserLock(u.email, async (x) => { x.devicesAfter = stamp; await saveUser(x); });
    return true;
  });
  if (!done) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true });
}
