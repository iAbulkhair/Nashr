import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createSession, currentUser, destroySession, strongPassword } from "@/lib/auth";
import { isPersonLockTimeout, updatePerson } from "@/lib/person";
import { wipeAccount } from "@/lib/account";
import { revokeAllMcp } from "@/lib/mcp";
import { revokeBooks } from "@/lib/booking-token";
import { linksOfPerson, revokeFeeds } from "@/lib/feed-token";
import { forbid } from "@/lib/roles";
import { ownPasswordMatches as matches } from "@/lib/own-password";
import { acct } from "@/lib/account-id";
import { isTeamLockTimeout } from "@/lib/team";
import { unlinkGoogle } from "@/lib/google-signin";

/**
 * PATCH {currentPassword, newPassword}: the acting login changes ITS OWN password, on its person (`updatePerson`: from M4,
 * rule 2138, the `person:` row only). Both sign out only their own other devices; the owner also
 * loses every MCP token and grant.
 * Refused while a founder impersonates. DELETE {password}: wipe the account, owner only.
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
  if (!(await matches(u, b.currentPassword))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  const hash = await bcrypt.hash(pw, 10);

  // The PERSON's password (multi-workspace M1, rule 2132): `updatePerson` writes `person:` under the person lock (from
  // M4, rule 2138, no legacy record is mirrored). Every other device of this person is signed out (`sessionsAfter`). A held person lock answers 409 `busy`: the lock
  // is taken before the first write, so nothing was written.
  let me;
  try {
    me = await updatePerson(a.pid, { passHash: hash, sessionsAfter: new Date().toISOString() });
  } catch (e) {
    if (isPersonLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
  if (!me) return NextResponse.json({ ok: false }, { status: 401 });
  // The person's own calendar feed and booking links, in every account it holds (rule 2138: by `(pid, aid)`, read from
  // `orgs:{pid}`, never by address), end with the old password, with its Google link (rule 2301).
  const links = await linksOfPerson(a.pid);
  if (a.kind === "member") {
    // The owner's hash, sessions, MCP token and connected apps, and the other members' links, stay.
    await Promise.all([revokeFeeds(links), revokeBooks(links), unlinkGoogle(a.email)]);
  } else {
    // Every MCP token and connected app dies with the old password, exactly as in the reset route: a stolen bearer token
    // must not outlive the password it was obtained with. The owner's Google link goes too (rule 2301).
    await Promise.all([revokeAllMcp(acct(u)), revokeFeeds(links), revokeBooks(links), unlinkGoogle(u.email)]);
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
