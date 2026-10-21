import { db } from "./db";
import { log } from "./log";
import { pmap } from "./parallel";
import { acct } from "./account-id";
import { getAccount, type Role, type User } from "./auth";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "./keys";
import { MembershipRow, parseStored, type MembershipValue } from "./stored";
import type { Person } from "./person";

/**
 * Ownership and memberships (multi-workspace membership, docs/specs/2026-10-18-multi-org.md sections 3-4, release M1
 * expand, rules 2115, 2134, 2136; release M4 contract, rule 2138).
 *
 * - The owner of an account is never a membership row: `ownerOf` is the only function that answers "who owns this
 *   account" (`u.ownerPid`, else the legacy owner `acct(u)`).
 * - A membership is `mbr:{aid}:{pid}` AND `members:{aid}` listing `pid`. A row without its roster entry, or a roster
 *   entry without a row, grants nothing (today's `onRoster` rule). A row that fails `MembershipRow` (a role "owner", a
 *   missing date) reads as none and is logged without values. From M4 the legacy `member:{pid}` record is never read:
 *   M1 to M3 read it as a fallback and through a stale guard; Script S2 deletes it where its `mbr:` twin matches.
 * - `orgs:{pid}` is a hint for listing only (rule 2136): `listOrgs` re-reads the forward records of every entry and skips
 *   the entries they do not back.
 *
 * Read-only; the writers are in src/lib/team.ts (`writeMembership`, `deleteMembership`).
 */

/** A membership as read: the row's fields and the account and person it was read under. */
export type Membership = MembershipValue & { aid: AccountId; pid: PersonId; source: "mbr" };

/** The person who owns the account (rule 2115): `ownerPid`, else the legacy owner, whose person id is the account id. */
export const ownerOf = (u: Pick<User, "ownerPid" | "id" | "email">): PersonId => storedPersonId(u.ownerPid ?? acct(u));
/** The account's id as an `AccountId` (`acct(u)`, rule 2137): a `User` this app loaded from a pointer or a session. */
export const aidOf = (u: Pick<User, "id" | "email">): AccountId => storedAccountId(acct(u));

/** The `mbr:{aid}:{pid}` row, when it parses and names the account and person it is stored under. */
function fromRow(aid: AccountId, pid: PersonId, raw: unknown): MembershipValue | null {
  const row = parseStored("membership", MembershipRow, raw, null);
  if (row && (row.aid !== aid || row.pid !== pid)) {
    log.warn("membership row names another key", { shape: "membership" });
    return null;
  }
  return row;
}

/**
 * The precedence of `getMembership`, pure, over the raw value of `mbr:{aid}:{pid}` and whether `members:{aid}` lists
 * `pid`, so a caller that reads them inside its own round (`resolveSession`) gets the same answer.
 */
export function membershipFromRaw(aid: AccountId, pid: PersonId, rawRow: unknown, listed: boolean): Membership | null {
  if (!listed) return null;
  const row = fromRow(aid, pid, rawRow);
  return row ? { ...row, aid, pid, source: "mbr" } : null;
}

/** One person's membership in one account (rules 2134, 2138): `mbr:` and the roster in ONE round. */
export async function getMembership(aid: AccountId, pid: PersonId): Promise<Membership | null> {
  const [row, listed] = await Promise.all([db.get(accountKey.membership(aid, pid)), db.sismember(accountKey.members(aid), pid)]);
  return membershipFromRaw(aid, pid, row, listed);
}

/**
 * The person's role in the account `u` (rules 2115, 2131): "owner" only from `ownerOf`; else the membership's role when
 * `m` is this person's membership in THIS account and is not paused; else null. Admin in A is nothing in B.
 */
export function roleIn(u: User, pid: PersonId, m: Membership | null): Role | null {
  if (ownerOf(u) === pid) return "owner";
  if (!m || m.pid !== pid || m.aid !== acct(u) || m.disabled) return null;
  return m.role === "admin" || m.role === "member" ? m.role : null;
}

/**
 * Today's member guards (src/lib/auth.ts `resolveSession`), moved here unchanged: the role is admin or member, the
 * membership is this account's, it is not paused for seats, and it was accepted no earlier than the account was created
 * (a re-registered owner address never inherits an old team; NaN on either side refuses).
 */
export function membershipHolds(u: User, m: Membership): boolean {
  if (m.role !== "admin" && m.role !== "member") return false;
  if (m.disabled || m.aid !== acct(u)) return false;
  return new Date(m.acceptedAt).getTime() >= new Date(u.createdAt).getTime();
}

/** An account the person holds now: the owner, or a live membership (`roleIn` and `membershipHolds`), with its date. */
type Held = { aid: AccountId; role: Role; at: string };

/** Whether `pid` holds `aid` now, on the forward records read in ONE round (the account and the membership). */
async function holding(aid: AccountId, pid: PersonId): Promise<Held | null> {
  const [u, m] = await Promise.all([getAccount(aid), getMembership(aid, pid)]);
  if (!u || acct(u) !== aid) return null;
  const role = roleIn(u, pid, m);
  if (!role) return null;
  if (role === "owner") return { aid, role, at: "" };
  return m && membershipHolds(u, m) ? { aid, role, at: m.acceptedAt } : null;
}

/** Owned first, then the oldest membership, then the account id (a stable order for equal dates). */
const byPick = (a: Held, b: Held): number =>
  (a.role === "owner") !== (b.role === "owner") ? (a.role === "owner" ? -1 : 1) : a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.aid < b.aid ? -1 : a.aid > b.aid ? 1 : 0;

/**
 * The accounts the person owns or holds a live membership in (rule 2136): `orgs:{pid}`, then ONE `pmap` round of the
 * account and the membership of every entry. An entry that neither `ownerOf` nor a holding membership backs (forged,
 * stale, paused, or an account that is gone) is skipped and grants nothing. Owned first, then oldest membership first.
 */
export async function listOrgs(pid: PersonId): Promise<{ aid: AccountId; role: Role }[]> {
  const entries = await db.smembers(personKey.orgs(pid));
  const rows = await pmap(entries, async (entry) => holding(storedAccountId(entry), pid));
  return rows
    .filter((r): r is Held => !!r)
    .sort(byPick)
    .map(({ aid, role }) => ({ aid, role }));
}

/**
 * The person's paused memberships (rule 2138): every account `orgs:{pid}` names where the person has a membership row
 * on the roster that is paused for seats (`disabled`) and would otherwise hold (`membershipHolds` but for the pause),
 * oldest first. ONE `pmap` round after `orgs:`. Only sign-in asks it, and only when `listOrgs` is empty, so the form
 * can still say "disabled" (the answer a legacy member record gave before M4) instead of "invalid".
 */
export async function pausedMemberships(pid: PersonId): Promise<{ membership: Membership; owner: User }[]> {
  const entries = await db.smembers(personKey.orgs(pid));
  const rows = await pmap(entries, async (entry) => {
    const aid = storedAccountId(entry);
    const [u, m] = await Promise.all([getAccount(aid), getMembership(aid, pid)]);
    if (!u || acct(u) !== aid || !m || !m.disabled || ownerOf(u) === pid) return null;
    return membershipHolds(u, { ...m, disabled: undefined }) ? { membership: m, owner: u } : null;
  });
  return rows.filter((r): r is { membership: Membership; owner: User } => !!r).sort((a, b) => (a.membership.acceptedAt < b.membership.acceptedAt ? -1 : a.membership.acceptedAt > b.membership.acceptedAt ? 1 : 0));
}

/**
 * The accounts the person holds, for the workspaces list and the create cap (multi-workspace M2): `listOrgs` of the
 * person. M2 also added the legacy home (a person from before Script S1 had no `orgs:` entry for it); from M4 (rule
 * 2138) S1 has filled `orgs:` for every person, so the hint alone is read.
 */
export async function heldAccounts(p: Person): Promise<{ aid: AccountId; role: Role }[]> {
  return listOrgs(p.pid);
}

/**
 * The person's HOME account, the one sign-in picks: the first of `listOrgs` (owned, else the oldest live membership).
 * From M4 there is no legacy home (rule 2138): the legacy per-login keys it named are no longer read. A pointer only:
 * every caller re-checks the forward records (`getMembership`, `roleIn`) before granting anything.
 */
export async function homeAccountOf(p: Person): Promise<AccountId | null> {
  return (await listOrgs(p.pid))[0]?.aid ?? null;
}

/**
 * The account a new session of this person opens (spec section 7, rules 2132, 2136, 2138): `prefer`, then
 * `lastorg:{pid}`, each only while it still holds on the forward records (owner, or a live membership); else the account
 * the person owns; else the oldest live membership; else null (no workspace). From M4 every person is read from
 * `person:` and found through `orgs:` only: the legacy home pointer M1 to M3 fell back to is gone.
 *
 * With `MULTI_ORG` false nothing writes `lastorg:` (the M2 switch route does) and no route passes `prefer`. Rounds:
 * `lastorg:` and `orgs:` together, then ONE `pmap` round of the candidates. The answer is a pointer: `resolveSession`
 * re-checks it on every request (rule 2111).
 */
export async function pickAccount(p: Person, opts: { prefer?: AccountId } = {}): Promise<AccountId | null> {
  const [last, entries] = await Promise.all([db.get<unknown>(personKey.lastOrg(p.pid)), db.smembers(personKey.orgs(p.pid))]);
  const asked = [...new Set([opts.prefer, typeof last === "string" && last ? storedAccountId(last) : undefined].filter((a): a is AccountId => !!a))];
  const pool = [...new Set<AccountId>([...asked, ...entries.map(storedAccountId)])];
  const held = (pool.length ? await pmap(pool, async (aid) => holding(aid, p.pid)) : []).filter((h): h is Held => !!h);
  const chosen = asked.find((aid) => held.some((h) => h.aid === aid));
  if (chosen) return chosen;
  return held.sort(byPick)[0]?.aid ?? null;
}
