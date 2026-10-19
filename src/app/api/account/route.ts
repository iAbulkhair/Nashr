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

/**
 * PATCH {currentPassword, newPassword}: the acting login changes ITS OWN password, on its person (`updatePerson`, which
 * mirrors the member record or the legacy owner's account). Both sign out only their own other devices; the owner also
 * loses every MCP token and grant.
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
  if (a.kind === "member") {
    // This member's own calendar feed and booking links end with the old password; the owner's hash, sessions, MCP
    // token and connected apps, and the other members' links, stay.
    await Promise.all([revokeFeed(a.email), revokeBook(a.email)]);
  } else {
    // Every MCP token and connected app dies with the old password, exactly as in the reset route: a stolen bearer token
    // must not outlive the password it was obtained with.
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
