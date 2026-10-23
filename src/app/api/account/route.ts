import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createSession, currentUser, destroySession, strongPassword } from "@/lib/auth";
import { isPersonLockTimeout, updatePerson } from "@/lib/person";
import { wipeAccount } from "@/lib/account";
import { revokeAllMcp } from "@/lib/mcp";
import { revokeBook } from "@/lib/booking-token";
import { revokeFeed } from "@/lib/feed-token";
import { forbid } from "@/lib/roles";
import { ownPasswordMatches as matches } from "@/lib/own-password";
import { acct } from "@/lib/account-id";
import { accountKey } from "@/lib/keys";
import { isTeamLockTimeout } from "@/lib/team";
import { unlinkGoogle } from "@/lib/google-signin";
import { allow, giveBack, retryLater, WINDOW } from "@/lib/rate";
import { ownedBy } from "@/lib/email-move";
import { pmap } from "@/lib/parallel";

/** Wrong current passwords per login and hour, each route its own bucket (rule 2991, the `mfapw:` pattern). */
const PASSWORD_TRIES_PER_HOUR = 10;

/**
 * The login's own password, behind a wrong-try bucket (rule 2991): `allow` before the compare, `giveBack` after a right
 * one, so only wrong passwords count. Ten wrong ones in an hour answer 429 `slow_down`, as POST /api/account/2fa does;
 * before, a stolen session cookie could guess the password here without limit.
 */
async function passwordRefusal(u: Parameters<typeof matches>[0], bucket: string, password: unknown): Promise<NextResponse | null> {
  if (!(await allow(bucket, PASSWORD_TRIES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (!(await matches(u, password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await giveBack(bucket);
  return null;
}

/**
 * PATCH {currentPassword, newPassword}: the acting login changes ITS OWN password, on its person (`updatePerson`, which
 * mirrors the member record or the legacy owner's account). Both sign out only their own other devices; every account
 * the person owns loses its MCP tokens and grants (rule 2992).
 * Refused while a founder impersonates. DELETE {password}: wipe the account, owner only. Both compare the password behind
 * a wrong-try bucket of their own, `pwchange:{login}` and `acctdelete:{login}`, 10 per hour (rule 2991).
 * Rule 2301: the acting login's Google link goes with the old password, as its other devices do: a password change is
 * how a login takes back control, and a Google account someone else linked while signed in must not stay a way in.
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
  const wrong = await passwordRefusal(u, accountKey.passwordChangeBucket(a.email), b.currentPassword);
  if (wrong) return wrong;
  const hash = await bcrypt.hash(pw, 10);

  // The PERSON's password (multi-workspace M1, rule 2132): `updatePerson` writes `person:` and mirrors the legacy record
  // (the member record for a member, the account for a legacy owner) under the person lock, then the record's own.
  // Every other device of this person is signed out (`sessionsAfter`). A held person lock answers 409 `busy`: the lock
  // is taken before the first write, so nothing was written.
  let me;
  try {
    me = await updatePerson(a.pid, { passHash: hash, sessionsAfter: new Date().toISOString() });
  } catch (e) {
    if (isPersonLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
  if (!me) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 2992: the password is the PERSON's, so every account the person OWNS loses its MCP tokens and connected apps,
  // not only the workspace this session acts in (`ownedBy`, the lister the address-change revert uses). A legacy owner
  // owns exactly this account, so nothing changes for it; a member who owns nothing revokes nothing more.
  const owned = await ownedBy(me);
  if (a.kind === "member") {
    // This member's own calendar feed, booking links and Google link (rule 2301) end with the old password; the owner's
    // hash, sessions, MCP token and connected apps, and the other members' links, stay.
    await Promise.all([revokeFeed(a.email), revokeBook(a.email), unlinkGoogle(a.email), pmap(owned, (x) => revokeAllMcp(acct(x)))]);
  } else {
    // Every MCP token and connected app dies with the old password, exactly as in the reset route: a stolen bearer token
    // must not outlive the password it was obtained with. The owner's Google link goes too (rule 2301).
    const aids = [...new Set([acct(u), ...owned.map((x) => acct(x))])];
    await Promise.all([pmap(aids, (aid) => revokeAllMcp(aid)), revokeFeed(u.email), revokeBook(u.email), unlinkGoogle(u.email)]);
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
  const wrong = await passwordRefusal(u, accountKey.accountDeleteBucket(u.actor!.email), b.password);
  if (wrong) return wrong;
  // Each member left with nothing is deleted under `lock:person:{pid}` (`wipeMemberships`, multi-workspace M1): a timeout (person,
  // login or member lock) stops the wipe with a 409 before `user:{owner}` and the owner's login are touched, and the
  // owner's retry runs it again.
  try {
    await wipeAccount(acct(u));
  } catch (e) {
    if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
  await destroySession();
  return NextResponse.json({ ok: true });
}
