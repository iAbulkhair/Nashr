import { NextResponse } from "next/server";
import { createSession, emailVerified, type Login } from "./auth";
import { mfaActive, openChallenge } from "./mfa";
import { track } from "./track";
import { isSuspended, suspensionEnd, suspensionExpired } from "./suspension";
import { endExpiredSuspension } from "./suspension-server";

/**
 * What every sign-in path shares once the person has proved who they are (a password in POST /api/auth/login, a
 * Google sign-in in /api/auth/google/callback, a code in POST /api/auth/login/mfa): the account checks, then the
 * two-step challenge, then the session. One place, so a new way in can never skip a refusal (rule 1934).
 */

/** When the login record was created: the moment an older two-step enrolment stops counting (src/lib/mfa.ts). */
export const bornAt = (l: Login): string | undefined => (l.kind === "owner" ? l.user.createdAt : l.member.acceptedAt);

/** The account owning this login (the owner itself, or the member's owner). */
export const accountOf = (l: Login) => (l.kind === "owner" ? l.user : l.owner);
export const loginEmail = (l: Login) => (l.kind === "owner" ? l.user.email : l.member.email);

/**
 * Why this login may not sign in now, as the answer the form reads, or null. The same checks `currentUser` makes on
 * every request, answered here so the form can say why: a suspended account, a member whose owner is gone or is a newer
 * account at the same address, an owner who has not proved the address (rule 767), a member paused by the seat limit.
 */
export function loginRefusal(l: Login): NextResponse | null {
  if (l.kind === "owner") return isSuspended(l.user) ? suspendedAnswer(l.user) : null;
  const { member, owner } = l;
  if (!owner || member.memberOf !== owner.email || !(new Date(member.acceptedAt).getTime() >= new Date(owner.createdAt).getTime())) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  }
  if (isSuspended(owner)) return suspendedAnswer(owner);
  if (!emailVerified(owner)) return NextResponse.json({ ok: false, error: "owner_unverified" }, { status: 403 });
  if (member.disabled) return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
  return null;
}

/**
 * The 403 for a suspended account: `until` (rule 2075) when the suspension has an end date, so the form can say when the
 * account opens again. The date is the account's own; nothing else about the account is in the answer.
 */
export function suspendedAnswer(u: { suspended?: unknown }): NextResponse {
  const until = suspensionEnd(u);
  return NextResponse.json(until ? { ok: false, error: "suspended", until } : { ok: false, error: "suspended" }, { status: 403 });
}

export type Finish =
  | { kind: "refused"; res: NextResponse }
  | { kind: "mfa" }
  | { kind: "signed_in"; /** Owners only: whether the address still needs its code. */ verify?: boolean };

/**
 * After the proof: refuse, or (two-step sign-in on and `codeDone` false) open the challenge and issue NO session, or
 * create the session. `codeDone` is true only on POST /api/auth/login/mfa after the code matched.
 */
export async function finishLogin(l: Login, { via, next, codeDone = false }: { via: "password" | "google"; next?: string; codeDone?: boolean }): Promise<Finish> {
  // An account whose suspension ended is let in by `isSuspended` already; this clears it and logs the expiry (rule 2073).
  const account = accountOf(l);
  if (account && suspensionExpired(account)) await endExpiredSuspension(account.email);
  const refused = loginRefusal(l);
  if (refused) return { kind: "refused", res: refused };
  const email = loginEmail(l);
  if (!codeDone && (await mfaActive(email, bornAt(l)))) {
    await openChallenge(email, via, next);
    return { kind: "mfa" };
  }
  await createSession(email);
  // Product analytics count ACCOUNTS: a member's activity is the owner's account being active.
  await track(accountOf(l)!.email, "login");
  return l.kind === "owner" ? { kind: "signed_in", verify: !emailVerified(l.user) } : { kind: "signed_in" };
}

/** The JSON answer the log-in form reads for a finish. */
export function finishAnswer(f: Finish): NextResponse {
  if (f.kind === "refused") return f.res;
  // Not a failure: the password was right and a code is due. No session exists yet (rule 1934).
  if (f.kind === "mfa") return NextResponse.json({ ok: false, error: "mfa_required", mfa: true }, { status: 401 });
  return NextResponse.json(f.verify === undefined ? { ok: true } : { ok: true, verify: f.verify });
}
