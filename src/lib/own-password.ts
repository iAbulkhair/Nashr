import bcrypt from "bcryptjs";
import type { User } from "./auth";
import type { Member } from "./team";
import { acct } from "./account-id";
import type { PersonId } from "./keys";
import { aidOf, getMembership, membershipHolds, roleIn } from "./membership";
import { getPerson, type Person } from "./person";

/**
 * When a LOGIN was born (rule 2990): the moment an older two-step enrolment at its address stops counting (`mfaActive`,
 * src/lib/mfa.ts). One rule for every caller, sign-in (`bornAt` in src/lib/login-finish.ts) and the session's own
 * settings (`actingLogin`): the login's own birth, never the birth of the workspace it acts in. A legacy owner: its
 * account's `createdAt` (the account IS the login). A legacy member: its member record's `acceptedAt`. Any other person
 * (a `p_` owner, a `p_` member, or a legacy person acting in a workspace that is not its home): the person's own
 * `createdAt` (which mirrors the legacy birth when a legacy record backs it, src/lib/person.ts `updatePerson`). Before
 * this, a `p_` person's birth was the account or membership sign-in picked: a second workspace created after the
 * enrolment, or one joined after it, made the enrolment look older than the login, so a password alone signed in and a
 * new setup replaced the authenticator without its code.
 */
export function loginBornAt(pid: string, person: { createdAt?: string }, legacy: { owner?: User | null; member?: Member | null } = {}): string | undefined {
  if (legacy.owner && acct(legacy.owner) === pid) return legacy.owner.createdAt;
  if (legacy.member) return legacy.member.acceptedAt;
  return person.createdAt || undefined;
}

/**
 * The acting LOGIN as a person (multi-workspace M1, rule 2132): the owner when the account's owner IS the acting person
 * (`roleIn`, which reads `ownerOf`), a member while it holds a live membership of this account (`membershipHolds`). Null
 * for any other actor (a founder impersonating, a token) and for a member no longer in this account. The credentials are
 * the PERSON's (`getPerson`): the account record's hash is never the answer for a member, so knowing the owner's password
 * never lets a member act as the owner.
 */
async function acting(u: User): Promise<{ kind: "owner" | "member"; person: Person; bornAt: string | undefined } | null> {
  const a = u.actor;
  if (a?.kind === "owner") {
    if (roleIn(u, a.pid, null) !== "owner") return null;
    const person = await getPerson(a.pid);
    // A legacy owner's birth is the account's (the person row mirrors it); a `p_` owner's is the person's own (rule 2990).
    return person ? { kind: "owner", person, bornAt: loginBornAt(a.pid, person, { owner: u }) } : null;
  }
  if (a?.kind !== "member") return null;
  const [person, m] = await Promise.all([getPerson(a.pid), getMembership(aidOf(u), a.pid)]);
  // The PERSON's birth (rule 2990), never this membership's `acceptedAt`: a workspace joined after the enrolment must not
  // make it look older than the login. A legacy member's person mirrors its record's `acceptedAt`.
  return person && m && roleIn(u, a.pid, m) && membershipHolds(u, m) ? { kind: "member", person, bornAt: loginBornAt(a.pid, person) } : null;
}

/** Does `password` match the acting login's own password? False for any actor that has none of its own. */
export const ownPasswordMatches = async (u: User, password: unknown) => {
  const hash = (await acting(u))?.person.passHash;
  return !!hash && typeof password === "string" && (await bcrypt.compare(password, hash));
};

/**
 * The acting LOGIN behind a session (rules 1930-1947): the person, its own address and when its login was born
 * (`loginBornAt`, rule 2990). Null for a founder impersonating, a token, or a member no longer in this
 * account. Every per-login setting (two-step sign-in, the device list, the address change) keys on this address, never
 * on one from the request (class B keys keep the address, plan reconciliation 8).
 */
export async function actingLogin(u: User): Promise<{ kind: "owner" | "member"; pid: PersonId; email: string; bornAt: string | undefined } | null> {
  const me = await acting(u);
  return me ? { kind: me.kind, pid: me.person.pid, email: me.person.email, bornAt: me.bornAt } : null;
}
