import { NextResponse } from "next/server";
import { createSession, emailVerified, type Login } from "./auth";
import { mfaActive, openChallenge } from "./mfa";
import { track } from "./track";
import { isPersonSuspended, isSuspended, suspensionEnd, suspensionExpired } from "./suspension";
import { endExpiredSuspension } from "./suspension-server";
import { acct } from "./account-id";
import { MULTI_ORG } from "./multi-org";
import { loginBornAt } from "./own-password";

/**
 * What every sign-in path shares once the person has proved who they are (a password in POST /api/auth/login, a
 * Google sign-in in /api/auth/google/callback, a code in POST /api/auth/login/mfa): the account checks, then the
 * two-step challenge, then the session. One place, so a new way in can never skip a refusal (rule 1934).
 */

/**
 * When the login was born: the moment an older two-step enrolment stops counting (src/lib/mfa.ts). The one rule the
 * session's settings use too (`loginBornAt`, rule 2990): a legacy owner's account, a legacy member's record, else the
 * person's own `createdAt`, never the account `getLogin` picked (a `p_` owner's second workspace is younger than the
 * enrolment, and a password alone must not sign in through it).
 */
export const bornAt = (l: Login): string | undefined => loginBornAt(l.pid, l.person, l.kind === "owner" ? { owner: l.user } : { member: l.member });

/** The account owning this login (the owner itself, or the member's owner). */
export const accountOf = (l: Login) => (l.kind === "owner" ? l.user : l.owner);
/**
 * The address the session is issued for: the legacy record's own address as before; for a person no legacy record
 * backs, the person's address (the one `getLogin` checked against the login index).
 */
export const loginEmail = (l: Login) => (l.kind === "owner" ? (l.pid === acct(l.user) ? l.user.email : l.person.email) : l.member ? l.member.email : l.person.email);

/** A refusal as data: the status and body the form reads. `loginRefusal` turns it into the answer; the better-auth gate throws it (rule 3411). */
export type Refusal = { status: 401 | 403; body: { ok: false; error: string; until?: string } };

/**
 * Why this login may not sign in now, as the answer the form reads, or null. The same checks `currentUser` makes on
 * every request, answered here so the form can say why: a suspended account, a member whose owner is gone or is a newer
 * account at the same address, an owner who has not proved the address (rule 767), a member paused by the seat limit.
 * One function for both engines (rule 3411): `loginRefusal` answers it, the better-auth session gate throws it.
 */
export function loginRefusalCode(l: Login): Refusal | null {
  if (l.kind === "owner") return isSuspended(l.user) ? suspendedRefusal(l.user) : personRefusal(l);
  const { member, owner } = l;
  // A person with no workspace (multi-workspace M2, `getLogin`): only the person's own checks; the session it gets has
  // no account, and the app sends it to the workspaces page.
  if (MULTI_ORG && !member && !owner && l.acct === null) return personRefusal(l);
  // A legacy member: its record names this account and was accepted after it was created. A person known only through
  // membership rows: `getLogin` took the account from a live membership (`listOrgs`, which checks the same dates).
  const named = member ? !!owner && member.memberOf === acct(owner) && new Date(member.acceptedAt).getTime() >= new Date(owner.createdAt).getTime() : !!owner && l.acct === acct(owner);
  if (!owner || !named) return { status: 401, body: { ok: false, error: "invalid" } };
  if (isSuspended(owner)) return suspendedRefusal(owner);
  if (!emailVerified(owner)) return { status: 403, body: { ok: false, error: "owner_unverified" } };
  if (member?.disabled) return { status: 403, body: { ok: false, error: "disabled" } };
  return personRefusal(l);
}

/** `loginRefusalCode` as the answer the form reads, or null. */
export function loginRefusal(l: Login): NextResponse | null {
  const r = loginRefusalCode(l);
  return r ? NextResponse.json(r.body, { status: r.status }) : null;
}

/**
 * A suspended PERSON (rule 2131, the `suspended` field of `person:{pid}`): the same answer as a suspended account. A legacy person has
 * no person-level suspension (the field lives on the account), so this never refuses anyone it did not refuse before.
 */
function personRefusal(l: Login): Refusal | null {
  return isPersonSuspended(l.person) ? suspendedRefusal(l.person) : null;
}

/** The refusal for a suspended account: `until` (rule 2075) when the suspension has an end date. */
function suspendedRefusal(u: { suspended?: unknown }): Refusal {
  const until = suspensionEnd(u);
  return { status: 403, body: until ? { ok: false, error: "suspended", until } : { ok: false, error: "suspended" } };
}

/**
 * The 403 for a suspended account: `until` (rule 2075) when the suspension has an end date, so the form can say when the
 * account opens again. The date is the account's own; nothing else about the account is in the answer.
 */
export function suspendedAnswer(u: { suspended?: unknown }): NextResponse {
  const r = suspendedRefusal(u);
  return NextResponse.json(r.body, { status: r.status });
}

export type Finish =
  | { kind: "refused"; res: NextResponse }
  | { kind: "mfa" }
  | { kind: "signed_in"; /** Owners only: whether the address still needs its code. */ verify?: boolean };

/**
 * How the person proved who they are. A password or a Google sign-in may still owe the two-step code; a passkey never
 * does (user verification is required, so it counts as both factors: rules 2409, 2420), and the type makes every passkey
 * caller say `codeDone: true`. `Challenge["via"]` (src/lib/mfa.ts) stays password or Google: no challenge is ever opened
 * for a passkey.
 */
export type FinishVia = { via: "password" | "google"; next?: string; codeDone?: boolean } | { via: "passkey"; next?: undefined; codeDone: true };

/**
 * What a proof admits, before any session exists: a refusal, a two-step challenge (opened here, so NO session may follow),
 * or the address to issue the session for. `finishLogin` creates that session itself; the better-auth session gate
 * (src/lib/better-auth/gate.ts, rule 3411) hands it to better-auth, which writes it through the same `issueSession`.
 */
export type Admission = { kind: "refused"; refusal: Refusal } | { kind: "mfa" } | { kind: "admit"; email: string };

export async function admitLogin(l: Login, opts: FinishVia): Promise<Admission> {
  // An account whose suspension ended is let in by `isSuspended` already; this clears it and logs the expiry (rule 2073).
  const account = accountOf(l);
  if (account && suspensionExpired(account)) await endExpiredSuspension(acct(account));
  const refusal = loginRefusalCode(l);
  if (refusal) return { kind: "refused", refusal };
  const email = loginEmail(l);
  if (opts.via !== "passkey" && !opts.codeDone && (await mfaActive(email, bornAt(l)))) {
    await openChallenge(email, opts.via, opts.next);
    return { kind: "mfa" };
  }
  return { kind: "admit", email };
}

/** Product analytics count ACCOUNTS: a member's activity is the owner's account being active. */
export async function trackLogin(l: Login): Promise<void> {
  const counted = accountOf(l);
  if (counted) await track(counted.email, "login");
}

/** What the answer adds for an owner: whether the address still needs its code (rule 754). Members get nothing. */
export const verifyOwed = (l: Login): boolean | undefined => (l.kind === "owner" ? !emailVerified(l.user) : undefined);

/**
 * After the proof: refuse, or (two-step sign-in on and `codeDone` false) open the challenge and issue NO session, or
 * create the session. `codeDone` is true on POST /api/auth/login/mfa after the code matched, and always for a passkey.
 */
export async function finishLogin(l: Login, opts: FinishVia): Promise<Finish> {
  const a = await admitLogin(l, opts);
  if (a.kind === "refused") return { kind: "refused", res: NextResponse.json(a.refusal.body, { status: a.refusal.status }) };
  if (a.kind === "mfa") return { kind: "mfa" };
  await createSession(a.email);
  await trackLogin(l);
  const verify = verifyOwed(l);
  return verify === undefined ? { kind: "signed_in" } : { kind: "signed_in", verify };
}

/** The JSON answer the log-in form reads for a finish. */
export function finishAnswer(f: Finish): NextResponse {
  if (f.kind === "refused") return f.res;
  // Not a failure: the password was right and a code is due. No session exists yet (rule 1934).
  if (f.kind === "mfa") return NextResponse.json({ ok: false, error: "mfa_required", mfa: true }, { status: 401 });
  return NextResponse.json(f.verify === undefined ? { ok: true } : { ok: true, verify: f.verify });
}
