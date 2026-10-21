import { db } from "./db";
import { log } from "./log";
import { pmap } from "./parallel";
import { acct } from "./account-id";
import { getAccount, type Role, type User } from "./auth";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "./keys";
import { MembershipRow, parseStored, type MembershipValue } from "./stored";
import { memberPid, type Member } from "./team";
import type { Person } from "./person";

/**
 * Ownership and memberships (multi-workspace membership, docs/specs/2026-10-18-multi-org.md sections 3-4, release M1
 * expand, rules 2115, 2134, 2136).
 *
 * - The owner of an account is never a membership row: `ownerOf` is the only function that answers "who owns this
 *   account" (`u.ownerPid`, else the legacy owner `acct(u)`).
 * - A membership is `mbr:{aid}:{pid}` AND `members:{aid}` listing `pid`; else the legacy `member:{pid}` record when its
 *   `memberOf` is `aid` AND the roster lists `pid`. A row without its roster entry, or a roster entry without a row,
 *   grants nothing (today's `onRoster` rule). A row that fails `MembershipRow` (a role "owner", a missing date) reads as
 *   none and is logged without values.
 * - Stale guard (the membership side of plan reconciliation 5): a home membership is written to both records. Should the
 *   two ever disagree (a role change or a seat pause made by a rolled-back build, which writes only `member:`), the
 *   stricter value of each field is read: `member` over `admin`, paused over enabled, the later `acceptedAt`. A rollback
 *   therefore never leaves a stale privilege usable; the mismatch is logged as `membership stale` (shape only).
 * - `orgs:{pid}` is a hint for listing only (rule 2136): `listOrgs` re-reads the forward records of every entry and skips
 *   the entries they do not back.
 *
 * Read-only; the writers come with the team task (`writeMembership`, `deleteMembership`).
 */

/** A membership as read: the row's fields, the account and person it was read under, and which record it came from. */
export type Membership = MembershipValue & { aid: AccountId; pid: PersonId; source: "mbr" | "member" };

/** The person who owns the account (rule 2115): `ownerPid`, else the legacy owner, whose person id is the account id. */
export const ownerOf = (u: Pick<User, "ownerPid" | "id" | "email">): PersonId => storedPersonId(u.ownerPid ?? acct(u));
/** The account's id as an `AccountId` (`acct(u)`, rule 2137): a `User` this app loaded from a pointer or a session. */
export const aidOf = (u: Pick<User, "id" | "email">): AccountId => storedAccountId(acct(u));

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const time = (v: string) => Date.parse(v);
/** The later of two dates; a malformed one wins, so `membershipHolds` refuses it (fails closed). */
const laterDate = (a: string, b: string): string => (!Number.isFinite(time(a)) ? a : !Number.isFinite(time(b)) ? b : time(b) > time(a) ? b : a);

/** Step 1: the `mbr:{aid}:{pid}` row, when it parses and names the account and person it is stored under. */
function fromRow(aid: AccountId, pid: PersonId, raw: unknown): MembershipValue | null {
  const row = parseStored("membership", MembershipRow, raw, null);
  if (row && (row.aid !== aid || row.pid !== pid)) {
    log.warn("membership row names another key", { shape: "membership" });
    return null;
  }
  return row;
}

/** Step 2: the legacy `member:{pid}` record, when it is this person's (`memberPid`) and its `memberOf` is `aid`. */
function fromLegacy(aid: AccountId, pid: PersonId, raw: unknown): MembershipValue | null {
  if (!isRecord(raw) || typeof raw.email !== "string") return null;
  const m = raw as Partial<Member> & { email: string };
  if (memberPid({ id: m.id, email: m.email }) !== pid || m.memberOf !== aid) return null;
  const legacy: Record<string, unknown> = { aid, pid, role: m.role, acceptedAt: m.acceptedAt, invitedBy: m.invitedBy };
  if (m.disabled !== undefined) legacy.disabled = m.disabled;
  return parseStored("membership.member", MembershipRow, legacy, null);
}

/**
 * The precedence of `getMembership`, pure, over the raw values of `mbr:{aid}:{pid}` and `member:{pid}` and whether
 * `members:{aid}` lists `pid`, so a caller that reads them inside its own round (`resolveSession`) gets the same answer.
 */
export function membershipFromRaw(aid: AccountId, pid: PersonId, rawRow: unknown, rawMember: unknown, listed: boolean): Membership | null {
  if (!listed) return null;
  const row = fromRow(aid, pid, rawRow);
  const legacy = fromLegacy(aid, pid, rawMember);
  if (row && legacy) {
    const role = row.role === "admin" && legacy.role === "admin" ? "admin" : "member";
    const disabled = row.disabled ?? legacy.disabled;
    const acceptedAt = laterDate(row.acceptedAt, legacy.acceptedAt);
    if (role !== row.role || disabled !== row.disabled || acceptedAt !== row.acceptedAt) log.warn("membership stale", { shape: "membership" });
    const merged: Membership = { ...row, role, acceptedAt, aid, pid, source: "mbr" };
    if (disabled) merged.disabled = disabled;
    else delete merged.disabled;
    return merged;
  }
  if (row) return { ...row, aid, pid, source: "mbr" };
  if (legacy) return { ...legacy, aid, pid, source: "member" };
  return null;
}

/** One person's membership in one account (rule 2134): `mbr:`, `member:` and the roster in ONE round. */
export async function getMembership(aid: AccountId, pid: PersonId): Promise<Membership | null> {
  const [row, m, listed] = await Promise.all([db.get(accountKey.membership(aid, pid)), db.get(accountKey.member(pid)), db.sismember(accountKey.members(aid), pid)]);
  return membershipFromRaw(aid, pid, row, m, listed);
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
 * `listOrgs` plus the person's legacy home (multi-workspace M2, the workspaces list and the create cap): a person from
 * before the R2 conversion has no `orgs:` entry for the account their legacy record names. ONE round (`orgs:` and the
 * legacy record), then ONE `pmap` round of the account and the membership of every candidate; a candidate the forward
 * records do not back grants nothing. Owned first, then oldest membership first.
 */
export async function heldAccounts(p: Person): Promise<{ aid: AccountId; role: Role }[]> {
  const [entries, home] = await Promise.all([db.smembers(personKey.orgs(p.pid)), legacyHomeOf(p)]);
  const pool = [...new Set<AccountId>([...entries.map(storedAccountId), ...(home ? [home] : [])])];
  const rows = await pmap(pool, async (aid) => holding(aid, p.pid));
  return rows
    .filter((r): r is Held => !!r)
    .sort(byPick)
    .map(({ aid, role }) => ({ aid, role }));
}

/** The `memberOf` of a legacy member record that is this person's, or null. */
function legacyHome(pid: PersonId, raw: unknown): AccountId | null {
  if (!isRecord(raw) || typeof raw.email !== "string") return null;
  const m = raw as Partial<Member> & { email: string };
  if (memberPid({ id: m.id, email: m.email }) !== pid || typeof m.memberOf !== "string" || !m.memberOf) return null;
  return storedAccountId(m.memberOf);
}

/**
 * The home account a LEGACY record names for this person, without the reverse index: a legacy owner's own account, a
 * legacy member's `memberOf`, and for a person read from `person:` the legacy record that still backs them. Null for a
 * person no legacy record backs (a `p_` person). A pointer only, never checked here.
 */
async function legacyHomeOf(p: Person): Promise<AccountId | null> {
  if (p.source === "owner") return storedAccountId(p.pid);
  if (p.source === "member") return legacyHome(p.pid, await db.get(accountKey.member(p.pid)));
  const [u, m] = await Promise.all([db.get<User>(accountKey.user(p.pid)), db.get(accountKey.member(p.pid))]);
  return legacyHomeFrom(p.pid, u, m);
}

/**
 * The same answer, pure, over the raw `user:{pid}` and `member:{pid}` values a caller already read in its own round
 * (`resolveSession`): the legacy owner's own account when `user:{pid}` is owned by `pid` (`ownerOf`), else the legacy
 * member record's `memberOf`, else null (a `p_` person). A pointer only: it says which account the legacy per-login keys
 * (`activebrand:{login}` and the feed and booking pointers) belong to, never that the person holds it.
 */
export function legacyHomeFrom(pid: PersonId, rawUser: unknown, rawMember: unknown): AccountId | null {
  if (isRecord(rawUser) && typeof rawUser.email === "string") {
    const u = rawUser as Partial<User> & { email: string };
    if (ownerOf({ ownerPid: u.ownerPid, id: u.id === undefined ? undefined : pid, email: u.email }) === pid) return storedAccountId(pid);
  }
  return legacyHome(pid, rawMember);
}

/**
 * The person's HOME account: the one the legacy per-login keys (`activebrand:{login}`, `sec:feedof:{login}`,
 * `sec:bookof:{login}:{prov}`) belong to, and the one sign-in picks after an owned account. A legacy owner: their own
 * account (`pid`). A legacy member: the record's `memberOf`. A person read from `person:`: the legacy home when a legacy
 * record still backs them (a legacy owner or member whose credentials M1 mirrored; no `orgs:` entry exists for them
 * before the conversion script), else the first of `listOrgs` (owned, else the oldest membership). A pointer only: every
 * caller re-checks the forward records (`getMembership`, `roleIn`) before granting anything.
 */
export async function homeAccountOf(p: Person): Promise<AccountId | null> {
  const home = await legacyHomeOf(p);
  if (home || p.source !== "person") return home;
  return (await listOrgs(p.pid))[0]?.aid ?? null;
}

/**
 * The account a new session of this person opens (spec section 7, rules 2132, 2136): `prefer`, then `lastorg:{pid}`,
 * each only while it still holds on the forward records (owner, or a live membership); else the account the person
 * owns; else the oldest live membership. A legacy person (read from `user:` or `member:`) gets its home account
 * (`homeAccountOf`), exactly the account release R1 wrote into the session. A person read from `person:` whose accounts
 * all fail the check gets its legacy home as a pointer (as R1 did for a paused member), or null (no workspace).
 *
 * With `MULTI_ORG` false nothing writes `lastorg:` (the M2 switch route does) and no route passes `prefer`, so the pick
 * is always the home account. Rounds: `lastorg:`, `orgs:` and the legacy record together, then ONE `pmap` round of the
 * candidates (none for a legacy person without `lastorg:`). The answer is a pointer: `resolveSession` re-checks it on
 * every request (rule 2111).
 */
export async function pickAccount(p: Person, opts: { prefer?: AccountId } = {}): Promise<AccountId | null> {
  const legacy = p.source !== "person";
  const [last, entries, home] = await Promise.all([
    db.get<unknown>(personKey.lastOrg(p.pid)),
    legacy ? Promise.resolve([] as string[]) : db.smembers(personKey.orgs(p.pid)),
    legacyHomeOf(p),
  ]);
  const asked = [...new Set([opts.prefer, typeof last === "string" && last ? storedAccountId(last) : undefined].filter((a): a is AccountId => !!a))];
  const pool = [...new Set<AccountId>([...asked, ...entries.map(storedAccountId), ...(legacy || !home ? [] : [home])])];
  const held = (pool.length ? await pmap(pool, async (aid) => holding(aid, p.pid)) : []).filter((h): h is Held => !!h);
  const chosen = asked.find((aid) => held.some((h) => h.aid === aid));
  if (chosen) return chosen;
  if (legacy) return home;
  return held.sort(byPick)[0]?.aid ?? home;
}
