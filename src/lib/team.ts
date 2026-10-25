import bcrypt from "bcryptjs";
import { isPersonSuspended, isSuspended } from "./suspension";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { log } from "./log";
import { pmap } from "./parallel";
import { withNamedLock } from "./locks";
import { revokeBook } from "./booking-token";
import { revokeFeed, type LinkOwner } from "./feed-token";
import { claimLogin, getAccount, getLogin, normalizeEmail, releaseLogin, saveUser, seatLimit, strongPassword, validEmail, type Actor, type User } from "./auth";
import { billableExtraSeats, EXTRA_SEAT_MONTHLY_SAR, extraSeatsSold, includedSeats, MAX_SEAT_OVERRIDE, paidExtraSeats } from "./pricing";
import { billingLocked } from "./billing-state";
import type { SeatBlock, SeatCharge, SeatChargeError } from "./billing";
import { acct, LoginIndex, OPAQUE_IDS } from "./account-id";
import { can } from "./roles";
import { personSpendFor } from "./credits";
import { teamApprovals } from "./approver-stats";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "./keys";
import { parseStored, type MembershipValue } from "./stored";
import { aidOf, getMembership, legacyHomeFrom, membershipFromRaw, ownerOf, type Membership } from "./membership";
import { createPersonRecord, getPerson, withMovePersonLock, withPersonLock, type Person } from "./person";
import { logTeam } from "./teamlog";
import { MULTI_ORG, newPersonId, PERSON_ID } from "./multi-org";
import { mfaKeys } from "./mfa";
import { movePasskeys, passkeyKeys } from "./passkeys";
import { revokeAllDevices } from "./devices";
import { addressBlocked } from "./email-hold";
import { workspaceLabel } from "./workspace-name";
import { avatarUrls, forgetAvatar } from "./avatar";

/**
 * Teams (seats): memberships, invites and seat accounting (docs/superpowers/specs/2026-09-29-teams-design.md;
 * multi-workspace membership, docs/specs/2026-10-18-multi-org.md, release M1 expand, rules 2118, 2124, 2125, 2129, 2139).
 *
 * The ACCOUNT stays the owner's `User` at `user:{aid}`. A member is a PERSON (src/lib/person.ts) holding a MEMBERSHIP in
 * the account (src/lib/membership.ts `getMembership`): it is never written with `saveUser` / `createUser`, never enters
 * `users:all`, never gets trial credits, a referral code or signup tracking. `currentUser()` (src/lib/auth.ts) resolves a
 * member session to the OWNER record with `actor` set.
 *
 * Keys:
 *   mbr:{aid}:{pid}    MembershipRow (M1 writes it beside the legacy record)
 *   members:{aid}      set of person ids (a legacy member's is its address, so R1's values already are)
 *   orgs:{pid}         set of account ids: a hint for listing only (rule 2136)
 *   member:{email}     the legacy member record, still written for the person's HOME membership (a rollback reads it)
 *   teamlog:{aid}      capped list of membership events (src/lib/teamlog.ts, rule 2129)
 *   invite:{sha256}    Invite, TTL 7 days (the token itself is never stored)
 *   invites:{aid}      set of invite hashes
 *   invitesfor:{email} set of invite hashes for one address, TTL 7 days (M3 inbox, written while `MULTI_ORG` is on)
 *   inviteuse:{hash}   single use at accept
 *
 * Every membership event writes the new shape and the legacy one in the same locked step, and one team log row under the
 * same `lock:team:{aid}`. Lock order (rule 2139), always outer to inner:
 *   inviteuse → lock:team:{aid} → lock:login:{email} → lock:person:{pid} → lock:member:{email} → lock:user:{aid}.
 * No lock is reentrant: a function called under a held lock says so (`teamLocked`, `locked`).
 */

/** The roles a membership can hold (rule 3750): "member" is the Editor (its stored name until the contract release). */
export type TeamRole = "admin" | "member" | "viewer";
export type Member = {
  /**
   * The member's person id (multi-org forced change 2): its address when the record was first written, frozen from then
   * on (in R1 a move still writes a new record, so it is the current address). Optional (expand): a record written
   * before R1 has none and reads as its `email` (`memberPid`). The login index names it.
   */
  id?: string;
  email: string;
  name: string;
  lang: "ar" | "en";
  passHash: string;
  /** The account id (`acct(owner)`): in R1 the owner's first address, as before. */
  memberOf: string;
  role: TeamRole;
  invitedBy: string;
  acceptedAt: string;
  /** Sessions issued before it are dead (own password change or reset). Set to `acceptedAt` on creation. */
  sessionsAfter?: string;
  /** The member's last "sign out other devices" (rule 1170): browser sessions only, never feed or booking links. Optional (expand). */
  devicesAfter?: string;
  /** Set by `enforceSeats` when the plan shrinks; the member is kept, never deleted for it. */
  disabled?: "seats";
};
/**
 * One member of an account as the roster shows it (`listMembers`): the membership (`getMembership`: role, date, inviter,
 * pause) and the person (`getPerson`: address, name, language). Never a password hash.
 */
export type MemberView = {
  pid: PersonId;
  email: string;
  name: string;
  lang: "ar" | "en";
  role: TeamRole;
  acceptedAt: string;
  invitedBy: string;
  disabled?: "seats";
  /** Rules 3756, 3760, 3770: the brand scope (absent = every brand), the approve toggle and the monthly credit cap. */
  brands?: string[];
  approves?: true;
  creditCap?: number;
};
export type Invite = {
  email: string;
  role: TeamRole;
  owner: string;
  /**
   * The account the invite is for (multi-workspace membership, release M1 expand): the same value as `owner`, written
   * beside it. Read as `inv.aid ?? inv.owner`, so an invite written before M1 still works.
   */
  aid?: string;
  invitedBy: string;
  /** The inviter's person id, beside `invitedBy` (their address). Absent on an invite written before M1. */
  invitedByPid?: string;
  createdAt: string;
  expiresAt: string;
  lang: "ar" | "en";
  /** Rule 3756 (expand): the brands the membership will be scoped to; absent = every brand. A build before M3 ignores it. */
  brands?: string[];
  /** Rule 3760 (expand): the membership will approve. A build before M3 ignores it. */
  approves?: true;
};
/** A pending invite with its id (the SHA-256 of the token, which is what DELETE /api/team/invite takes). */
export type PendingInvite = Invite & { id: string };

/**
 * `already_member` and `signin_required` exist only while `MULTI_ORG` is on (multi-workspace M2, rule 2116): the
 * address is the owner or a member of THIS account (nothing outside the inviter's own team is revealed), and an invite
 * for an address that already signs in is accepted by signing in, never with a new password.
 */
export type TeamError = "invalid_email" | "invalid_role" | "forbidden" | "unavailable" | "not_found" | "invalid" | "weak_password" | "invalid_name" | "already_member" | "signin_required" | "seats_full" | "busy" | SeatChargeError;
/** What a seat bought now costs on a yearly subscription (rule 4040): the months left of the paid year, halalas. */
export type SeatChargeView = { months: number; baseHalalas: number; totalHalalas: number };
/**
 * Over the seat limit. `included`, `extra`, `unitSar` and `canBuy` (paid seats, rule 3369) are present only on the
 * answer of `createInvite`: what the owner's confirm step shows; the accept paths answer `used` and `limit` alone.
 * On a yearly subscription `charge` is what the confirm charges now (rule 4040), and `blocked` why no seat is sold
 * online (rule 4049, `canBuy` false then). Older pages ignore both (expand).
 */
export type SeatsError = { ok: false; error: "seats"; used: number; limit: number; included?: number; extra?: number; unitSar?: number; canBuy?: boolean; charge?: SeatChargeView; blocked?: SeatBlock };
/** `refunded`: a seat charged in this request was refunded because the invite could not be made after all (rule 4047). */
export type TeamFail = ({ ok: false; error: TeamError } | SeatsError) & { refunded?: true };

export const INVITE_TTL_SECONDS = 7 * 24 * 3600;
const TOKEN_RE = /^[a-f0-9]{64}$/;

const memberKey = (email: string) => accountKey.member(email);
export const membersKey = (owner: string) => accountKey.members(owner);
const inviteKey = (id: string) => globalKey.invite(id);
const invitesKey = (owner: string) => accountKey.invites(owner);
const fail = (error: TeamError): TeamFail => ({ ok: false, error });

/**
 * The account id a caller of this module passes (`acct(u)`, an invite's `aid ?? owner`, a member record's `memberOf`):
 * always read back from a record this app wrote, never from a request (rule 2137).
 */
const aidFrom = (owner: string): AccountId => storedAccountId(owner);
/**
 * A person id read back from a record this app wrote: a roster entry, a legacy member record's `memberPid`, an invite's
 * `invitedByPid` or `invitedBy` (in R1 a legacy person's id is its address), a session's actor.
 */
export const pidFrom = (s: string): PersonId => storedPersonId(s);

export const isTeamRole = (v: unknown): v is TeamRole => v === "admin" || v === "member" || v === "viewer";
/**
 * A role named in a request (rule 3751): "editor" is the product's name for the stored "member", accepted as an alias so
 * the API speaks the new names before the contract release. Anything else that is not a team role is null.
 */
export const teamRoleFrom = (v: unknown): TeamRole | null => (v === "editor" ? "member" : isTeamRole(v) ? v : null);

/** Viewers that take no seat, per workspace (rule 3753): the fourth viewer takes a paid seat like an editor. */
export const FREE_VIEWERS = 3;
type Seated = { role?: unknown; disabled?: unknown };
/**
 * THE seat count (rules 2118, 3753): the owner, every membership not paused and every unexpired invite, except that the
 * first `FREE_VIEWERS` viewers (members and viewer invites together) take no seat. Every seat check, the Members page,
 * billing and the console count through this one pure function, over what the caller read under its lock. When the paid
 * seats work (rules 3360-3379) lands, its `settleExtraSeats` bills this count, so free viewers are never billed.
 */
export function seatCount(members: readonly Seated[], invites: readonly Seated[]): number {
  const active = members.filter((m) => !m.disabled);
  const viewers = active.filter((m) => m.role === "viewer").length + invites.filter((i) => i.role === "viewer").length;
  const paid = active.filter((m) => m.role !== "viewer").length + invites.filter((i) => i.role !== "viewer").length;
  return 1 + paid + Math.max(0, viewers - FREE_VIEWERS);
}
/** Free viewer places left (rule 3753), for the Members page. */
export function freeViewersLeft(members: readonly Seated[], invites: readonly Seated[]): number {
  const viewers = members.filter((m) => !m.disabled && m.role === "viewer").length + invites.filter((i) => i.role === "viewer").length;
  return Math.max(0, FREE_VIEWERS - viewers);
}
/** The invite id: SHA-256 of the token. The token travels only in the link's fragment and is never stored. */
export const inviteId = (token: string) => createHash("sha256").update(token).digest("hex");
const expired = (inv: Pick<Invite, "expiresAt">, now = Date.now()) => !(new Date(inv.expiresAt).getTime() > now);
/** The account an invite is for: `aid`, else `owner` (an invite written before M1). */
const inviteAccount = (inv: Pick<Invite, "aid" | "owner">): string => inv.aid ?? inv.owner;
/** A display name: control characters removed, trimmed, at most 80 characters. Null when nothing is left. */
const cleanName = (v: unknown) => {
  if (typeof v !== "string") return null;
  const n = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return n || null;
};
const byAge = <T,>(at: (x: T) => string, tie: (x: T) => string) => (a: T, b: T) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : tie(a) < tie(b) ? -1 : 1);

/** Run `fn` under a Redis lock, waiting up to ~3 s for it (`withNamedLock`, src/lib/locks.ts). Always released. */
const withLock = <T,>(key: string, fn: () => Promise<T>): Promise<T> => withNamedLock(key, fn, TEAM_LOCK_TIMEOUT);
/** The error a team, login or member lock throws when still held after the wait (taken before any write: a 409 `busy`). */
export const TEAM_LOCK_TIMEOUT = "team_lock_timeout";
export const isTeamLockTimeout = (e: unknown): boolean => e instanceof Error && e.message === TEAM_LOCK_TIMEOUT;
/** `lock:team:{aid}`: every seat count and every membership event of the account. */
const withTeamLock = <T,>(aid: AccountId, fn: () => Promise<T>): Promise<T> => withLock(accountKey.teamLock(aid), fn);
/**
 * `lock:team:{aid}` for a caller outside this file that must hold it across its own writes (POST /api/admin/plan: team
 * before user, rule 2139). A timeout throws `team_lock_timeout` before `fn` runs, so nothing is written.
 */
export const withAccountTeamLock = <T,>(aid: AccountId, fn: () => Promise<T>): Promise<T> => withTeamLock(aid, fn);
/**
 * How long the owner address move's `lock:team` lives (src/lib/verify-email.ts `moveOwnerLogin`). The move holds it from
 * before its first write until the old account is wiped: about 30-50 Redis round trips, longer than the 10 s every other
 * holder gets on a slow day. The lock has no renewal, so this holder alone asks a longer expiry. It is always released
 * when the move ends; the expiry only bounds a crashed process (accepts and invites of that account wait up to 60 s).
 */
export const MOVE_TEAM_LOCK_TTL_SECONDS = 60;
/** `lock:team` of the account an owner address move copies and wipes; a timeout throws `team_lock_timeout`. */
export const withMoveTeamLock = <T,>(owner: string, fn: () => Promise<T>): Promise<T> =>
  withNamedLock(accountKey.teamLock(aidFrom(owner)), fn, TEAM_LOCK_TIMEOUT, MOVE_TEAM_LOCK_TTL_SECONDS);
/** Login uniqueness across `user:` and `member:`. Signup and accept both create logins under this lock. */
export const withLoginLock = <T,>(email: string, fn: () => Promise<T>) => withLock(accountKey.loginLock(normalizeEmail(email)), fn);
/** Read-modify-write of one member record (password, name, role, disabled). Null when the member does not exist. */
export async function withMemberLock<T>(email: string, fn: (m: Member) => Promise<T>): Promise<T | null> {
  const e = normalizeEmail(email);
  return withLock(accountKey.memberLock(e), async () => {
    const m = await getMember(e);
    return m ? fn(m) : null;
  });
}

/**
 * A member's person id: the frozen `id`, or the address of a record written before R1. While `OPAQUE_IDS` is off (R1)
 * every member's person id IS its address: a stored `id` that differs was copied by a rolled-back build's move
 * (`{id: old, email: new}` at `member:{new}`, with no `login:{new}`) and is ignored, so the member still signs in and
 * holds the address (security review M1, 2026-10-18).
 */
export const memberPid = (m: Pick<Member, "id" | "email">): string => (OPAQUE_IDS ? (m.id ?? normalizeEmail(m.email)) : normalizeEmail(m.email));

export async function getMember(email: string): Promise<Member | null> {
  const m = await db.get<Member>(memberKey(normalizeEmail(email)));
  // The same stale id, corrected in memory so the next save writes the address (as `getAccount` does for owners).
  if (m && !OPAQUE_IDS && m.id !== undefined && m.id !== normalizeEmail(m.email)) {
    log.warn("member id differs from its address", { shape: "member.id" });
    m.id = normalizeEmail(m.email);
  }
  return m;
}
/** Writes the member record only: never `users:all`, never the roster index. Callers hold `lock:member:{email}`. */
export async function saveMember(m: Member) {
  await db.set(memberKey(m.email), m);
}

/** The legacy member record is this person's HOME membership in `aid`: its person id is `pid` and its `memberOf` is `aid`. */
const isHome = (m: Member | null, aid: AccountId, pid: PersonId): m is Member => !!m && memberPid(m) === pid && m.memberOf === aid;

/**
 * One membership read for a change, in ONE round: the `mbr:` row, the legacy record and the roster entry (the
 * precedence of `getMembership`, src/lib/membership.ts), and whether the legacy record is this membership's (`home`).
 */
async function readMembership(aid: AccountId, pid: PersonId): Promise<{ ms: Membership | null; home: boolean }> {
  const [row, legacy, listed] = await Promise.all([db.get(accountKey.membership(aid, pid)), getMember(pid), db.sismember(accountKey.members(aid), pid)]);
  return { ms: membershipFromRaw(aid, pid, row, legacy, listed), home: isHome(legacy, aid, pid) };
}

/** The row a membership is written as: exactly the `MembershipRow` fields, `disabled` only when set. */
const rowOf = (m: MembershipValue): MembershipValue => ({
  aid: m.aid,
  pid: m.pid,
  role: m.role,
  acceptedAt: m.acceptedAt,
  invitedBy: m.invitedBy,
  ...(m.disabled ? { disabled: m.disabled } : {}),
  // Customer roles M3 (expand): scope, approve toggle and cap, only when set. A build before M3 drops them on its next write.
  ...(Array.isArray(m.brands) ? { brands: m.brands } : {}),
  ...(m.approves === true ? { approves: true as const } : {}),
  ...(typeof m.creditCap === "number" ? { creditCap: m.creditCap } : {}),
});

/** The new shape of a membership, in one round: the row, the roster entry and the person's `orgs:` entry. */
async function putRow(aid: AccountId, pid: PersonId, row: MembershipValue): Promise<void> {
  await Promise.all([db.set(accountKey.membership(aid, pid), rowOf({ ...row, aid, pid })), db.sadd(accountKey.members(aid), pid), db.sadd(personKey.orgs(pid), aid)]);
}

/**
 * Write one membership (rule 2132): `SET mbr:{aid}:{pid}`, the roster entry and `orgs:{pid}`, and for the person's HOME
 * membership the legacy `member:{email}` fields (`role`, `acceptedAt`, `disabled`), so a build rolled back to R1 reads
 * the same membership. For a home membership both writes run in ONE round under `lock:member`: a lock timeout throws
 * before either is written, so the row and the mirror never disagree (a pause on the row only would come back unpaused
 * after a rollback). Without a legacy record (a `p_` person, or one already gone) the row is written alone, after the
 * lock. The legacy record is changed in place (`Object.assign` keeps its field order, a resume deletes `disabled` as R1
 * did) and only when a field differs, so a home record stays exactly what R1 wrote; `invitedBy` and `memberOf` never
 * change after an accept and are left as R1 wrote them (the row's `invitedBy` is the inviter's person id, the legacy
 * record's their address). The caller holds `lock:team:{aid}` (`teamLocked`); `lock:member` comes after `lock:team`,
 * `lock:login` and `lock:person` in rule 2139's order.
 */
export async function writeMembership(aid: AccountId, pid: PersonId, row: MembershipValue, opts: { home: boolean; teamLocked: true }): Promise<void> {
  if (!opts.home) return putRow(aid, pid, row);
  const done = await withMemberLock(pid, async (m) => {
    const mirror = isHome(m, aid, pid) && !(m.role === row.role && m.acceptedAt === row.acceptedAt && m.disabled === row.disabled);
    if (mirror) {
      Object.assign(m, { role: row.role, acceptedAt: row.acceptedAt });
      if (row.disabled) m.disabled = row.disabled;
      else delete m.disabled;
    }
    await Promise.all([putRow(aid, pid, row), mirror ? saveMember(m) : null]);
    return true;
  });
  // No legacy record: nothing to mirror.
  if (done === null) await putRow(aid, pid, row);
}

/**
 * Does the person still hold anything outside `aid`: an account they own, or a membership (paused ones count: the person
 * is kept for them)? Read from `orgs:{pid}` AND the legacy records (a legacy member accepted before M1 has no `orgs:`
 * entry), each re-checked on the forward records (`ownerOf`, `getMembership`). Two rounds. Also asked by `wipeAccount`
 * (src/lib/account.ts) for the deleted account's OWNER, under the owner's `lock:login`.
 */
export async function holdsElsewhere(pid: PersonId, aid: AccountId): Promise<boolean> {
  const [entries, rawUser, rawMember] = await Promise.all([db.smembers(personKey.orgs(pid)), db.get(accountKey.user(pid)), db.get(accountKey.member(pid))]);
  const home = legacyHomeFrom(pid, rawUser, rawMember);
  const pool = [...new Set<AccountId>([...entries.map(aidFrom), ...(home ? [home] : [])])].filter((a) => a !== aid);
  const held = await pmap(pool, async (a) => {
    const [u, m] = await Promise.all([getAccount(a), getMembership(a, pid)]);
    return (!!u && acct(u) === a && ownerOf(u) === pid) || !!m;
  });
  return held.some(Boolean);
}

/**
 * Every account the person owns or has a membership row in, paused ones included (the read of `holdsElsewhere`, listed):
 * the M3 delete-person flow (rule 2754) leaves each, and refuses while any is owned. Two rounds.
 */
export async function heldAnywhere(pid: PersonId): Promise<{ aid: AccountId; owner: boolean }[]> {
  const [entries, rawUser, rawMember] = await Promise.all([db.smembers(personKey.orgs(pid)), db.get(accountKey.user(pid)), db.get(accountKey.member(pid))]);
  const home = legacyHomeFrom(pid, rawUser, rawMember);
  const pool = [...new Set<AccountId>([...entries.map(aidFrom), ...(home ? [home] : [])])];
  const rows = await pmap(pool, async (a) => {
    const [u, m] = await Promise.all([getAccount(a), getMembership(a, pid)]);
    const owner = !!u && acct(u) === a && ownerOf(u) === pid;
    return owner || m ? { aid: a, owner } : null;
  });
  return rows.filter((r): r is { aid: AccountId; owner: boolean } => !!r);
}

/**
 * Plan reconciliation 7: with `MULTI_ORG` off, a person with no owned account and no other membership left is deleted as
 * R1 deleted a removed member's login: `person:{pid}`, its account list and last pick, and, while the login index still
 * names this person (an address taken by someone else since keeps everything), the login index, two-step sign-in, the
 * waiting address change, the Google link both ways and every device session; its passkeys (set, reverse entries naming
 * it, open registration) go in every case. The caller holds `lock:login:{email}` →
 * `lock:person:{pid}` (rule 2139: `deleteMembership` takes them before its first write), so an accept or a credential
 * write of the same person waits for it.
 */
async function forgetPersonIfAlone(pid: PersonId, email: string, aid: AccountId, opts: { loginLocked: true; personLocked: true }): Promise<void> {
  if (MULTI_ORG) return;
  if (await holdsElsewhere(pid, aid)) return;
  await forgetPerson(pid, email, opts);
}

/**
 * Delete a person who holds nothing (the key list of plan reconciliation 7, shared by `forgetPersonIfAlone` and the M3
 * delete-person flow, rule 2754): `person:{pid}`, its account list and last pick, its passkeys, and, while the login index
 * still names this person (an address taken by someone else since keeps everything), the login index, two-step sign-in,
 * the waiting address change, the Google link both ways, the invitations inbox (`invitesfor:`) and every device session.
 * One round. The caller holds `lock:login:{email}` → `lock:person:{pid}` and has checked that nothing is held.
 */
export async function forgetPerson(pid: PersonId, email: string, opts: { loginLocked: true; personLocked: true }): Promise<void> {
  void opts;
  const [rawIdx, sub, passkeys] = await Promise.all([db.get<unknown>(accountKey.login(email)), db.get<unknown>(accountKey.googleSub(email)), passkeyKeys(pid)]);
  const idx = parseStored("login", LoginIndex, rawIdx, null);
  const own = !idx || idx.pid === pid;
  const google = typeof sub === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(sub) ? [globalKey.googleAccount(sub)] : [];
  // The person's passkeys go with the person whoever holds the address now (rule 2425, pre-flight ruling 6): they are
  // keyed by pid, and `passkeyKeys` lists only reverse entries that still name this pid.
  const keys = [personKey.person(pid), personKey.orgs(pid), personKey.lastOrg(pid), ...passkeys, ...(own ? [...mfaKeys(email), accountKey.emailChange(email), accountKey.emailChangeTries(email), accountKey.googleSub(email), accountKey.invitesFor(email), ...google] : [])];
  await Promise.all([...keys.map((k) => db.del(k)), own ? revokeAllDevices(email) : null, releaseLogin(email, pid, { locked: true }), forgetAvatar(pid)]);
}

/**
 * One membership of a person deleting their own login (multi-workspace M3, rule 2754): under `lock:team:{aid}` the
 * membership is read again and, while it holds, deleted with everything that is the person's in the account
 * (`deleteMembership`), and one "left" row is written. False when there was nothing to delete. Never an owner: the caller
 * refused an owned account before.
 */
export async function leaveForDeletion(aid: AccountId, pid: PersonId, email: string): Promise<boolean> {
  return withTeamLock(aid, async () => {
    const [cur, account] = await Promise.all([readMembership(aid, pid), getAccount(aid)]);
    if (!cur.ms || (account && ownerOf(account) === pid)) return false;
    await deleteMembership(aid, pid, { home: cur.home, teamLocked: true });
    await logTeam(aid, { kind: "left", actor: { pid, email }, target: { pid, email }, role: cur.ms.role, via: "web" }, { teamLocked: true });
    return true;
  });
}

/**
 * Delete one membership (rules 2124, 2132) and everything that is the person's in the account: `mbr:{aid}:{pid}`, the
 * roster entry, the `orgs:` entry, the per-(person, account) active brand and the invites the person sent in this
 * account, in one round; for the HOME membership also the legacy `member:{email}` record and `activebrand:{login}`,
 * under `lock:member` and only while the record is still this membership's (a profile or password save in flight can
 * never bring the login back behind the roster's back). Then the person's calendar feed and booking links in this account, and with
 * nothing left the person (`forgetPersonIfAlone`, plan reconciliation 7). The caller holds `lock:team:{aid}` and has
 * checked who may do it on the membership read under that lock. `lock:login:{email}` → `lock:person:{pid}` are taken
 * here BEFORE the first write (rule 2139), so a lock that cannot be had throws with nothing deleted and a retry finds the
 * membership whole.
 */
export async function deleteMembership(aid: AccountId, pid: PersonId, opts: { home: boolean; teamLocked: true }): Promise<void> {
  const person = await getPerson(pid);
  const email = person ? normalizeEmail(person.email) : opts.home ? pid : null;
  const run = async () => {
    const invites = await listInvites(aid);
    const sent = invites.filter((i) => (i.invitedByPid !== undefined ? i.invitedByPid === pid : email !== null && normalizeEmail(i.invitedBy) === email));
    const round = (legacy: Member | null) =>
      Promise.all([
        db.del(accountKey.membership(aid, pid)),
        db.srem(accountKey.members(aid), pid),
        db.srem(personKey.orgs(pid), aid),
        db.del(personKey.activeBrand(pid, aid)),
        dropInvites(aid, sent),
        legacy ? db.del(memberKey(legacy.email)) : null,
        legacy ? db.del(accountKey.activeBrand(legacy.email)) : null,
      ]);
    // The home membership's `lock:member` is taken BEFORE the first delete of the round (person → member is in the
    // order), so a stale member lock throws with nothing deleted, never a half-removed membership.
    if (opts.home) {
      await withLock(accountKey.memberLock(normalizeEmail(pid)), async () => {
        const m = await getMember(pid);
        await round(isHome(m, aid, pid) ? m : null);
      });
    } else await round(null);
    // The person's (pid, aid) feed and booking links (rule 2119), and for the home membership the legacy per-login
    // pointers and a link made before M1 (rule 2132). After the record is gone, so nothing can mint a new one for it
    // (`revokeFeed` waits out a create already running); a link that outlives a skipped revoke is refused at read time
    // anyway, since the membership no longer holds (`loginHolds`). The feed and booking locks are leaves (rule 2139):
    // taken here under lock:team, lock:login and lock:person, and they take nothing else.
    const link = { pid, aid, login: email ?? "", home: opts.home && !!email };
    await Promise.all([revokeFeed(link), revokeBook(link)]);
    if (email) await forgetPersonIfAlone(pid, email, aid, { loginLocked: true, personLocked: true });
  };
  // No address (a roster entry with no person and no legacy record): nothing signs in, so no login or person to lock.
  if (!email) return run();
  return withLoginLock(email, () => withPersonLock(pid, run));
}

/**
 * Write a new member (a person, the membership and the login index). NO checks: `acceptInvite` calls it after every
 * check under its locks (`lock:team` → `lock:login`), and tests use it to build a team. Never call it from a route.
 * Without `opts.pid` the member is a legacy one: its person id is its address, it gets the legacy `member:{email}` record
 * exactly as R1 wrote it, and the membership is its home. With `opts.pid` (a `p_` person, tests of release M1 only) the
 * person has a `person:` row and a membership row and no legacy record.
 */
export async function createMember(
  owner: string,
  input: { email: string; name: string; password: string; lang: "ar" | "en"; role: TeamRole; invitedBy: string; invitedByPid?: string },
  opts: { pid?: PersonId } = {},
): Promise<Member> {
  return insertMember(aidFrom(owner), { ...input, passHash: await bcrypt.hash(input.password, 10) }, opts);
}

async function insertMember(
  aid: AccountId,
  input: { email: string; name: string; passHash: string; lang: "ar" | "en"; role: TeamRole; invitedBy: string; invitedByPid?: string; brands?: string[]; approves?: true },
  opts: { pid?: PersonId },
): Promise<Member> {
  const now = new Date().toISOString();
  const email = normalizeEmail(input.email);
  const pid = opts.pid ?? pidFrom(email);
  const home = opts.pid === undefined;
  const member: Member = {
    id: pid,
    email,
    name: cleanName(input.name) ?? "",
    lang: input.lang === "en" ? "en" : "ar",
    passHash: input.passHash,
    memberOf: aid,
    role: input.role,
    invitedBy: input.invitedBy,
    acceptedAt: now,
    sessionsAfter: now,
  };
  // The person row fresh (plan reconciliation 6: a leftover row at this id lends nothing), born with the membership so
  // the stale guard reads the two records as one, and the legacy record exactly as R1 wrote it. Every write runs under
  // `lock:person:{pid}` (rule 2139: inviteuse → team → login → person), taken BEFORE the first one, so a person lock that
  // cannot be had throws with nothing written (no `member:`, no roster entry, no `mbr:`, no login) and a retry starts clean.
  // A home member's `lock:member:{email}` (next in the order) is taken the same way, BEFORE the first write, and the
  // membership is written with `putRow` under it, not `writeMembership` (which would take `lock:member` a second time
  // after the person row, the legacy record and the login were written: a held member lock then left a person who could
  // not sign in, an address a retry calls "unavailable", and the invite pending). The mirror needs no extra write: the
  // legacy record was just written with the row's own `role` and `acceptedAt`, byte-compatible with R1.
  const write = async () => {
    await createPersonRecord({ pid, email, name: member.name, lang: member.lang, passHash: member.passHash, createdAt: now, sessionsAfter: now }, { loginLocked: true, personLocked: true });
    if (home) await saveMember(member);
    const extras = { ...(input.brands ? { brands: input.brands } : {}), ...(input.approves ? { approves: true as const } : {}) };
    await Promise.all([putRow(aid, pid, { aid, pid, role: input.role, acceptedAt: now, invitedBy: input.invitedByPid ?? input.invitedBy, ...extras }), claimLogin(email, pid)]);
  };
  await withPersonLock(pid, () => (home ? withLock(accountKey.memberLock(email), write) : write()));
  return member;
}

/**
 * Is `pid` on `owner`'s roster? `currentUser` and `getLogin` (src/lib/auth.ts) ask this as well as reading the member
 * record, so a record that outlived its roster entry (a removal racing a write, a deleted account) never signs in. A
 * legacy person id is its address, which is why both sides are normalized (a `p_` id is lower case already).
 */
export const onRoster = (owner: string, pid: string) => db.sismember(membersKey(normalizeEmail(owner)), normalizeEmail(pid));

/**
 * Every member of the account, oldest first: the roster (`members:{aid}`), then ONE `pmap` round of the membership and
 * the person of every entry. An entry that neither backs (no membership, no person) is skipped.
 */
export async function listMembers(owner: string): Promise<MemberView[]> {
  const aid = aidFrom(owner);
  const pids = await db.smembers(membersKey(aid));
  const rows = await pmap(pids, async (p): Promise<MemberView | null> => {
    const pid = pidFrom(p);
    const [ms, person] = await Promise.all([getMembership(aid, pid), getPerson(pid)]);
    if (!ms || !person) return null;
    return {
      pid,
      email: normalizeEmail(person.email),
      name: person.name,
      lang: person.lang === "en" ? "en" : "ar",
      role: ms.role,
      acceptedAt: ms.acceptedAt,
      invitedBy: ms.invitedBy,
      ...(ms.disabled ? { disabled: ms.disabled } : {}),
      ...(Array.isArray(ms.brands) ? { brands: [...ms.brands] } : {}),
      ...(ms.approves === true ? { approves: true as const } : {}),
      ...(typeof ms.creditCap === "number" ? { creditCap: ms.creditCap } : {}),
    };
  });
  return rows.filter((m): m is MemberView => !!m).sort(byAge((m) => m.acceptedAt, (m) => m.email));
}

/** Every membership row on the account's roster (auto-assign, rule 3764): one `pmap` round; an entry with no row is skipped. */
export async function rosterMemberships(aid: AccountId): Promise<Membership[]> {
  const pids = await db.smembers(membersKey(aid));
  const rows = await pmap(pids, (p) => getMembership(aid, pidFrom(p)));
  return rows.filter((m): m is Membership => !!m);
}

/**
 * The address to show for a membership row's `invitedBy` (multi-workspace M1, 2026-10-19). The row names the inviter by person
 * id: a legacy person's id is its address and is shown as stored; a `p_` id is read back as that person's address, or
 * shown as stored when no person holds it any more. The value is always one this app wrote, never a request's.
 */
export async function inviterAddress(invitedBy: string): Promise<string> {
  if (!PERSON_ID.test(invitedBy)) return invitedBy;
  const p = await getPerson(pidFrom(invitedBy));
  return p ? normalizeEmail(p.email) : invitedBy;
}

/** The account's invite index read once: the pending, unexpired invites (oldest first) and the ids that are stale. */
async function readInvites(owner: string): Promise<{ live: PendingInvite[]; stale: string[] }> {
  const ids = await db.smembers(invitesKey(owner));
  const rows = await pmap(ids, async (id) => ({ id, inv: await db.get<Invite>(inviteKey(id)) }));
  const now = Date.now();
  const live = rows.filter((r): r is { id: string; inv: Invite } => !!r.inv && inviteAccount(r.inv) === owner && !expired(r.inv, now));
  const liveIds = new Set(live.map((r) => r.id));
  const stale = ids.filter((id) => !liveIds.has(id));
  return { live: live.map((r) => ({ ...r.inv, id: r.id })).sort(byAge((i) => i.createdAt, (i) => i.id)), stale };
}

/** Pending, unexpired invites of the account, oldest first. Index entries whose invite expired are dropped. */
export async function listInvites(owner: string): Promise<PendingInvite[]> {
  const { live, stale } = await readInvites(owner);
  if (stale.length) await pmap(stale, (id) => db.srem(invitesKey(owner), id));
  return live;
}

/** The same list, reading only: the founder console's workspace view writes nothing (rule 2079). */
export async function peekInvites(owner: string): Promise<PendingInvite[]> {
  return (await readInvites(owner)).live;
}

/** Seats in use (rule 2118, per account): `seatCount` over the roster and the live invites, read now. */
export async function seatsUsed(owner: string): Promise<number> {
  const [members, invites] = await Promise.all([listMembers(owner), listInvites(owner)]);
  return seatCount(members, invites);
}

/** The actor is still what the session said: for a member, still holding a membership of this account, enabled, with that role. */
async function actorStillHolds(owner: User, actor: Actor): Promise<boolean> {
  if (actor.kind !== "member") return actor.email === owner.email;
  const m = await getMembership(aidOf(owner), actor.pid);
  return !!m && !m.disabled && m.role === actor.role;
}

/** The inviter's person id: `invitedByPid`, else (an invite written before M1) the address, a legacy person's id. */
const inviterPid = (inv: Invite): PersonId => pidFrom(inv.invitedByPid ?? normalizeEmail(inv.invitedBy));

/**
 * An invite still stands for this owner: issued after the owner record was created (a re-registered address inherits no
 * invite), and sent by the owner (`ownerOf`, or for an invite written before M1 the owner's address or id), or by a person
 * whose membership of this account is still an enabled admin, inviting a plain member. `peekInvite` and `acceptInvite`
 * both ask this, so the join page never previews an invite that accepting would refuse.
 */
function inviteHolds(inv: Invite, owner: User, inviter: Membership | null): boolean {
  if (!(new Date(inv.createdAt).getTime() >= new Date(owner.createdAt).getTime())) return false;
  if (inv.invitedByPid !== undefined ? inv.invitedByPid === ownerOf(owner) : inv.invitedBy === owner.email || inv.invitedBy === acct(owner)) return true;
  // An admin invites editors and viewers (rule 3754), never another admin.
  return !!inviter && inviter.aid === aidOf(owner) && !inviter.disabled && inviter.role === "admin" && (inv.role === "member" || inv.role === "viewer");
}
/**
 * Delete these invites of `owner` (record and index entry). Callers hold `lock:team:{owner}`. An invite passed with its
 * address also leaves that address's inbox (`invitesfor:{email}`, multi-workspace M3); one passed by id only stays there
 * until the inbox reads it and finds it gone (`invitesWaiting` drops what no longer stands).
 */
async function dropInvites(owner: string, items: readonly (string | Pick<PendingInvite, "id" | "email">)[]) {
  await Promise.all(
    items.flatMap((x) =>
      typeof x === "string"
        ? [db.del(inviteKey(x)), db.srem(invitesKey(owner), x)]
        : [db.del(inviteKey(x.id)), db.srem(invitesKey(owner), x.id), db.srem(accountKey.invitesFor(normalizeEmail(x.email)), x.id)],
    ),
  );
}

/**
 * Who carried a team change out, for its team log row: the customer's own team page ("web", the default) or Thakeen
 * support from the founder console ("console", rules 3550-3569, src/lib/admin-workspace-edit.ts). The checks are the same.
 */
export type TeamVia = { via?: "web" | "console" };

/** The acting person as a team log row names them (rule 2129): the person id and the address of the day. */
const who =(a: Pick<Actor, "pid" | "email">) => ({ pid: a.pid as string, email: normalizeEmail(a.email) });

/**
 * Invite `email` into `owner`'s account as `role`. The owner may invite either role; an admin only plain members; a
 * founder impersonating never. The owner's own address, an existing login (owner or member anywhere) and a pending
 * invite in this team all get the same "unavailable", so the route cannot be used to probe who has an account.
 * With `MULTI_ORG` on (rule 2116) an address that signs in elsewhere is invited like a new one: only the owner, a
 * member of THIS account (paused ones too) and the inviter themself get `already_member`, and a pending invite in this
 * team "unavailable", so the answer still says nothing about other accounts.
 * The seat check runs under `lock:team:{aid}`. Returns the token ONCE: only its SHA-256 is stored. The invite names the
 * account (`aid`, beside `owner`) and the inviter's person id (`invitedByPid`, beside their address); the team log gets
 * an "invited" row.
 */
export async function createInvite(
  owner: User,
  actor: Actor,
  email: string,
  rawRole: string,
  lang: string,
  access: { brands?: unknown; approves?: unknown } = {},
  opts: TeamVia & { addSeat?: boolean; seatHalalas?: number } = {},
): Promise<{ ok: true; token: string; id: string; invite: Invite; seatAdded?: true } | TeamFail> {
  const role = teamRoleFrom(rawRole);
  if (!role) return fail("invalid_role");
  // Rules 3756, 3760: the brand scope and the approve toggle travel with the invite, checked like a later change.
  const extras = await accessFrom(owner, access);
  if (!extras) return fail("invalid");
  const e = normalizeEmail(typeof email === "string" ? email : "");
  if (!validEmail(e)) return fail("invalid_email");
  if (!can({ ...owner, actor }, role === "admin" ? "team.invite.admin" : "team.invite.member")) return fail("forbidden");
  if ((extras.brands || extras.approves) && !can({ ...owner, actor }, "team.access")) return fail("forbidden");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  if (e === owner.email || e === normalizeEmail(actor.email)) return fail(MULTI_ORG ? "already_member" : "unavailable");
  const token = randomBytes(32).toString("hex");
  const id = inviteId(token);
  const aid = aidOf(owner);
  type Made = { ok: true; token: string; id: string; invite: Invite; seatAdded?: true };
  type ChargeFirst = { chargeNow: Extract<SeatCharge, { mode: "now" }>; account: User };
  // Pass 1 checks and, when the seat is paid by the renewal, makes the invite; a yearly seat charged now (rule 4043)
  // leaves the lock with `chargeNow`, the card is charged with no lock held, and pass 2 (`charged`) re-checks everything
  // under the lock again, with the seat the payment granted now inside the limit.
  const pass = (charged: boolean) => withTeamLock(aid, async (): Promise<Made | TeamFail | ChargeFirst> => {
    // Is the address taken? Through the login resolver (rule 1982), not by reading `user:{address}` as an account.
    const [taken, m, members, invites, fresh] = await Promise.all([getLogin(e), getMember(e), listMembers(aid), listInvites(aid), getAccount(aid)]);
    // The account re-read under the lock: one deleted while this request waited (`wipeAccount` holds `lock:team` until
    // `user:{owner}` is gone) gets no invite, no index entry and no team log row.
    if (!fresh) return fail("forbidden");
    if (MULTI_ORG) {
      // Only this account's own people: the owner person's address (an address move updates it) and the roster.
      const owned = taken && taken.pid === ownerOf(fresh);
      if (owned || members.some((x) => x.email === e)) return fail("already_member");
      if (invites.some((i) => i.email === e)) return fail("unavailable");
    } else if (taken || m || invites.some((i) => i.email === e)) return fail("unavailable");
    const limit = seatLimit(fresh);
    const used = seatCount(members, invites);
    // The new invite counted with the rest: a viewer invite within the free viewers takes no seat (rule 3753).
    const needed = seatCount(members, [...invites, { role }]);
    let seatAdded = charged;
    if (needed > limit) {
      // Pass 2: the seat paid for in this request did not make room (another invite took it meanwhile): no invite.
      if (charged) return seatsError(fresh, used, false);
      // Over the limit (rules 3366-3369): refused unless the owner's own session confirmed one paid seat in this request.
      // The flag alone is never enough: who acts, the plan, the billing state and "exactly one seat short" are checked
      // here, under lock:team, and again under lock:user before `extraSeats` moves.
      const buyable = seatBuyable({ ...fresh, actor }, needed, limit);
      const how = buyable ? await (await import("./billing")).seatCharge(fresh) : null;
      const canBuy = buyable && how?.mode !== "blocked";
      if (!opts.addSeat || !canBuy) return seatsError(fresh, used, canBuy, how);
      // Rule 4050: charged only at the amount the owner's dialog showed (`seatHalalas`, incl. VAT). Any other amount (a
      // stale page, a month that turned, a page from before this rule that shows no amount) answers the seats 409 again
      // with today's `charge`, so the page asks again and nothing is charged.
      if (how?.mode === "now") return opts.seatHalalas === how.amountCents ? { chargeNow: how, account: fresh } : seatsError(fresh, used, true, how);
      const added = await addPaidSeat(fresh, needed);
      if (added === "busy") return fail("busy");
      if (!added) return seatsError(fresh, used, false);
      seatAdded = true;
    }
    const now = new Date();
    const invite: Invite = {
      email: e,
      role,
      owner: aid,
      aid,
      invitedBy: normalizeEmail(actor.email),
      invitedByPid: actor.pid,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_SECONDS * 1000).toISOString(),
      lang: lang === "en" ? "en" : "ar",
      ...(extras.brands ? { brands: extras.brands } : {}),
      ...(extras.approves ? { approves: true as const } : {}),
    };
    await Promise.all([
      db.set(inviteKey(id), invite, INVITE_TTL_SECONDS),
      db.sadd(invitesKey(aid), id),
      // The invited address's inbox (multi-workspace M3, spec section 9): the id only, read back for that address alone.
      // Its TTL is the newest invite's, so the set never outlives the invites in it. Only while `MULTI_ORG` is on, so
      // with the flag off the store is byte-for-byte M2's.
      MULTI_ORG ? db.sadd(accountKey.invitesFor(e), id).then(() => db.expire(accountKey.invitesFor(e), INVITE_TTL_SECONDS)) : null,
      logTeam(aid, { kind: "invited", actor: who(actor), target: { email: e }, role, via: opts.via ?? "web" }, { teamLocked: true }),
    ]);
    return { ok: true as const, token, id, invite, ...(seatAdded ? { seatAdded: true as const } : {}) };
  });
  const first = await pass(false);
  if (!("chargeNow" in first)) return first;
  const { chargeSeat } = await import("./billing");
  const paid = await chargeSeat(first.account, actor.email, first.chargeNow.months);
  if (!paid.ok) return fail(paid.error);
  // Rule 4047: paid, and the seat is granted (`applySeat`). Anything that now stops the invite gives the seat back and
  // refunds it, unless someone already fills it (then the payment stands for a seat in use).
  const second = (await actorStillHolds(owner, actor)) ? await pass(true).catch((err: unknown) => (isTeamLockTimeout(err) ? fail("busy") : Promise.reject(err))) : fail("forbidden");
  if ("chargeNow" in second || second.ok) return "chargeNow" in second ? fail("seat_changed") : second;
  return (await returnPaidSeat(first.account, paid.txnId, second.error)) ? { ...second, refunded: true as const } : second;
}

/**
 * Rule 4047: a seat charged now whose invite could not be made after all goes back: under `lock:team` then `lock:user`
 * (rule 2139) `extraSeats` drops by one only while the team still fits in one seat fewer, then the charge is refunded
 * in full (`refundSeatCharge`). A seat someone took meanwhile stays, paid; a lock not had in time keeps the seat and logs it.
 * An account deleted meanwhile has no seat to lower and is refunded. True when refunded.
 */
async function returnPaidSeat(account: User, txnId: number | string, why: string): Promise<boolean> {
  const aid = aidOf(account);
  const { withUserLock } = await import("./credits");
  const { refundSeatCharge } = await import("./billing");
  let lowered: boolean;
  try {
    lowered = await withTeamLock(aid, async () => {
      const [members, invites] = await Promise.all([listMembers(aid), listInvites(aid)]);
      const used = seatCount(members, invites);
      return withUserLock(acct(account), async (cur) => {
        const paid = paidExtraSeats(cur);
        if (paid < 1 || used > seatLimit(cur) - 1) return false;
        const { extraSeats: _old, ...rest } = cur;
        void _old;
        await saveUser(paid > 1 ? { ...rest, extraSeats: paid - 1 } : rest);
        return true;
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "user_not_found") lowered = true;
    else if (isTeamLockTimeout(err) || (err instanceof Error && err.message === "user_lock_timeout")) lowered = false;
    else throw err;
  }
  if (!lowered) {
    log.error("team: paid seat kept after a failed invite", { aid, txn: String(txnId), why });
    return false;
  }
  return refundSeatCharge(acct(account), txnId, why);
}

/**
 * May this actor buy the one seat this invite needs (rule 3367)? The owner's own session (`billing.seats`: never an
 * admin, the founder or a token), a plan that sells seats (`extraSeatsSold`: not a trial, not Agency), billing not
 * locked, and exactly one seat short: a team already over its limit (a downgrade) is fitted by `enforceSeats`, never by
 * buying several seats behind one click.
 */
function seatBuyable(u: User, needed: number, limit: number): boolean {
  return can(u, "billing.seats") && extraSeatsSold(u.plan) && !billingLocked(u.billing) && needed - limit === 1;
}

/**
 * The 409 seats answer, with what the confirm step shows (rule 3369). `canBuy` only for the owner who could buy now.
 * `how` (rules 4040, 4049): on a yearly subscription the amount charged now, or why no seat is sold online.
 */
function seatsError(u: User, used: number, canBuy: boolean, how?: SeatCharge | null): SeatsError {
  return { ok: false, error: "seats", used, limit: seatLimit(u), included: includedSeats(u), extra: paidExtraSeats(u), unitSar: EXTRA_SEAT_MONTHLY_SAR, canBuy, ...seatChargeView(how) };
}

/** The page's view of `seatCharge`: the amount of a seat charged now, or the reason none is sold online. */
function seatChargeView(how: SeatCharge | null | undefined): { charge?: SeatChargeView; blocked?: SeatBlock } {
  if (how?.mode === "now") return { charge: { months: how.months, baseHalalas: how.baseHalalas, totalHalalas: how.amountCents } };
  if (how?.mode === "blocked") return { blocked: how.reason };
  return {};
}

/**
 * Raise `extraSeats` by one under `lock:user` (the caller holds `lock:team:{aid}`, rule 2139 order). The account is
 * re-read under the lock: when another write already made room the seat is not bought twice (true, nothing written);
 * when the plan, billing or the count moved so that more than one seat is missing, nothing is bought (false). "busy"
 * when the user lock was not had in time. Charged from the next renewal (`chargeSavedCard`), usable now (rule 3370).
 */
async function addPaidSeat(fresh: User, needed: number): Promise<boolean | "busy"> {
  const { withUserLock } = await import("./credits");
  try {
    return await withUserLock(acct(fresh), async (cur) => {
      const limit = seatLimit(cur);
      if (needed <= limit) return true;
      if (!extraSeatsSold(cur.plan) || billingLocked(cur.billing) || needed - limit !== 1) return false;
      const next = paidExtraSeats(cur) + 1;
      if (next > MAX_SEAT_OVERRIDE) return false;
      await saveUser({ ...cur, extraSeats: next });
      log.info("team: paid seat added", { aid: acct(cur), extraSeats: next });
      return true;
    });
  } catch (e) {
    if (e instanceof Error && e.message === "user_lock_timeout") return "busy";
    throw e;
  }
}

/**
 * At renewal (rule 3371): lower the paid extra seats to what the team uses now, never raise them. extraSeats becomes
 * min(stored, max(0, used − included)), used = `seatCount` (free viewers, rule 3753, never billed). A member who left or an
 * invite cancelled during the period stops being charged here, at the next renewal; nothing is refunded mid-period.
 * Takes lock:team:{aid} then lock:user (rule 2139). Returns the seats to charge for. Old records (no `extraSeats`) and
 * plans that sell no seats return 0 and write nothing.
 */
export async function settleExtraSeats(owner: User | string): Promise<number> {
  const aid = typeof owner === "string" ? aidFrom(normalizeEmail(owner)) : aidOf(owner);
  return withTeamLock(aid, async () => {
    const [o, members, invites] = await Promise.all([getAccount(aid), listMembers(aid), listInvites(aid)]);
    if (!o || paidExtraSeats(o) === 0) return 0;
    const used = seatCount(members, invites);
    const { withUserLock } = await import("./credits");
    return withUserLock(acct(o), async (cur) => {
      const paid = paidExtraSeats(cur);
      const keep = Math.min(paid, billableExtraSeats(used, includedSeats(cur)));
      if (keep !== paid || (cur.extraSeats !== undefined && keep === 0)) {
        const { extraSeats: _old, ...rest } = cur;
        void _old;
        await saveUser(keep > 0 ? { ...rest, extraSeats: keep } : rest);
        log.info("team: paid seats settled at renewal", { aid: acct(cur), from: paid, to: keep });
      }
      return keep;
    });
  });
}

/**
 * What the join page shows before anything is consumed. Null for an unknown, expired or orphaned invite, or one
 * `acceptInvite` would refuse for its inviter. With `MULTI_ORG` on, `signIn` says the invited address already signs in,
 * so the page asks for a sign-in instead of a password (rule 2116); only the token's holder, the invitee, sees it.
 */
export async function peekInvite(token: string): Promise<{ team: string; inviter: string; email: string; role: TeamRole; expiresAt: string; signIn?: boolean } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const inv = await db.get<Invite>(inviteKey(inviteId(token)));
  if (!inv || expired(inv)) return null;
  const aid = aidFrom(inviteAccount(inv));
  const { getBrand } = await import("./brand");
  const [owner, inviter, brand] = await Promise.all([getAccount(aid), getMembership(aid, inviterPid(inv)), getBrand(aid)]);
  if (!owner || isSuspended(owner) || !inviteHolds(inv, owner, inviter)) return null;
  const [by, login] = await Promise.all([inviter ? getPerson(inviter.pid) : null, MULTI_ORG ? getLogin(inv.email) : null]);
  // `team`: the workspace's name as everywhere else (`workspaceLabel`, rule 3116), so a renamed workspace invites by its new name.
  return { team: workspaceLabel(owner, brand), inviter: by?.name || owner.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, ...(MULTI_ORG ? { signIn: !!login } : {}) };
}

/**
 * Accept an invite: creates the member's person, membership and login. Single use under `inviteuse:{hash}`. Re-reads
 * under `lock:team:{aid}` the invite (still stored AND still in the index: a cancelled one is refused, never counted as
 * a new seat), the owner (exists, not suspended, not a newer account at the same address, and its seat limit as it is
 * now), the inviter (still the owner or an enabled admin of this account, and only the owner may have invited an admin)
 * and the seats; then, under `lock:login`, that the address is still free across `user:` and `member:` (with
 * `MULTI_ORG` off an address that already signs in is refused, as in R1). `insertMember` takes `lock:person` and
 * `lock:member` inside (rule 2139). Never runs createUser, a referral code, a referral bonus or signup tracking. The
 * caller signs the new member in with `createSession(member.email)`. One "joined" team log row.
 * With `MULTI_ORG` on (rule 2117) the new member is a `p_` person with a membership row and no legacy record: no
 * account, no credits, not in `users:all`. An address that already signs in gets `signin_required` and the invite
 * stays: an existing person joins through `acceptInviteAsPerson`, never with a new password (rule 2116).
 */
export async function acceptInvite(token: string, input: { name: unknown; password: unknown; lang?: unknown }): Promise<{ ok: true; member: Member } | TeamFail> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return fail("invalid");
  const id = inviteId(token);
  const first = await db.get<Invite>(inviteKey(id));
  if (!first || expired(first)) return fail("invalid");
  const name = cleanName(input.name);
  if (!name) return fail("invalid_name");
  if (typeof input.password !== "string" || !strongPassword(input.password)) return fail("weak_password");
  // Hash before taking any lock: bcrypt is the slow part.
  const passHash = await bcrypt.hash(input.password, 10);
  const use = globalKey.inviteUse(id);
  if (!(await db.lock(use, 30))) return fail("invalid"); // being accepted right now
  try {
    const inv = await db.get<Invite>(inviteKey(id));
    if (!inv || expired(inv) || !isTeamRole(inv.role)) return fail("invalid");
    const aid = aidFrom(inviteAccount(inv));
    // Everything that decides the answer is read again under the team lock: a plan change, a cancel, a demotion or an
    // account deletion that finished while this request waited for the lock must be seen, never a copy read before it.
    return await withTeamLock(aid, async () => {
      const [owner, inviter, live, members, invites] = await Promise.all([getAccount(aid), getMembership(aid, inviterPid(inv)), db.get<Invite>(inviteKey(id)), listMembers(aid), listInvites(aid)]);
      // A cancelled, seat-cancelled or already-used invite is gone from the record and the index: refused, not counted.
      if (!live || expired(live) || !invites.some((i) => i.id === id)) return fail("invalid");
      if (!owner || isSuspended(owner) || !inviteHolds(inv, owner, inviter)) return fail("invalid");
      const limit = seatLimit(owner);
      // This invite already holds a seat (it is in the index); accepting turns it into a member, same count.
      const used = seatCount(members, invites);
      if (used > limit) return { ok: false, error: "seats", used, limit } as SeatsError;
      return withLoginLock(inv.email, async () => {
        const [taken, m, blocked] = await Promise.all([getLogin(inv.email), getMember(inv.email), addressBlocked(inv.email)]);
        if (taken || m) return fail(MULTI_ORG ? "signin_required" : "unavailable");
        // Account-id R2 (rules 2740, 2743; nothing to find before any account moved in place): an address another person
        // moved away from is held, and with `MULTI_ORG` off the new member's person id would be the address, which an account that moved in
        // place still holds as its key (L3).
        if (blocked === "held" || (blocked === "moved" && !MULTI_ORG)) return fail("unavailable");
        const lang = input.lang === "en" || input.lang === "ar" ? input.lang : inv.lang;
        const member = await insertMember(aid, { email: inv.email, name, passHash, lang, role: inv.role, invitedBy: inv.invitedBy, invitedByPid: inv.invitedByPid, ...inviteExtras(inv) }, MULTI_ORG ? { pid: pidFrom(newPersonId()) } : {});
        const pid = pidFrom(memberPid(member));
        await Promise.all([
          dropInvites(aid, [{ id, email: inv.email }]),
          logTeam(aid, { kind: "joined", actor: { pid, email: member.email }, target: { pid, email: member.email }, role: member.role, via: "web" }, { teamLocked: true }),
        ]);
        return { ok: true as const, member };
      });
    });
  } finally {
    await db.unlock(use);
  }
}

/**
 * Accept an invite as the signed-in person (multi-workspace M2, spec section 9, rule 2116). `person` is the one
 * `currentPerson()` resolved from the session, never an address or an id from the request, and the invite must be for
 * that person's VERIFIED address: no membership is ever created by address alone, and no password is asked or written.
 * Under `inviteuse` → `lock:team:{aid}` → `lock:person:{pid}` (rule 2139) the invite (record and index), the account,
 * the inviter, the seats and the person are read again; a person already holding this account (owner or member, paused
 * too) gets `already_member` and the invite stays. Then the membership row, the roster entry and `orgs:{pid}`
 * (`writeMembership`; never the legacy record, which is the person's home elsewhere), the invite dropped and one
 * "joined" team log row. The role comes from the invite only (decision 5). The caller, `acceptInviteAsPerson` in
 * src/lib/workspaces.ts, then moves this device's session (this file reaches no session or cookie). Off while
 * `MULTI_ORG` is off.
 */
export async function joinInviteAsPerson(token: string, person: Person): Promise<{ ok: true; member: { name: string; email: string; role: TeamRole; memberOf: AccountId } } | TeamFail> {
  if (!MULTI_ORG) return fail("invalid");
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return fail("invalid");
  const id = inviteId(token);
  const first = await db.get<Invite>(inviteKey(id));
  if (!first || expired(first)) return fail("invalid");
  if (!person.emailVerifiedAt || normalizeEmail(person.email) !== normalizeEmail(first.email)) return fail("invalid");
  const pid = pidFrom(person.pid);
  const use = globalKey.inviteUse(id);
  if (!(await db.lock(use, 30))) return fail("invalid"); // being accepted right now
  let done: { aid: AccountId; role: TeamRole; name: string; email: string } | TeamFail;
  try {
    const inv = await db.get<Invite>(inviteKey(id));
    if (!inv || expired(inv) || !isTeamRole(inv.role)) return fail("invalid");
    const aid = aidFrom(inviteAccount(inv));
    done = await withTeamLock(aid, async () => {
      const [owner, inviter, live, members, invites] = await Promise.all([getAccount(aid), getMembership(aid, inviterPid(inv)), db.get<Invite>(inviteKey(id)), listMembers(aid), listInvites(aid)]);
      if (!live || expired(live) || !invites.some((i) => i.id === id)) return fail("invalid");
      if (!owner || isSuspended(owner) || !inviteHolds(inv, owner, inviter)) return fail("invalid");
      const limit = seatLimit(owner);
      const used = seatCount(members, invites);
      if (used > limit) return { ok: false, error: "seats", used, limit } as SeatsError;
      return withPersonLock(pid, async () => {
        // The person as it is now: the same address, still verified, not suspended (a change since the request began).
        const [fresh, held] = await Promise.all([getPerson(pid), getMembership(aid, pid)]);
        if (!fresh || !fresh.emailVerifiedAt || isPersonSuspended(fresh) || normalizeEmail(fresh.email) !== normalizeEmail(inv.email)) return fail("invalid");
        if (held || ownerOf(owner) === pid) return fail("already_member");
        const now = new Date().toISOString();
        await writeMembership(aid, pid, { aid, pid, role: inv.role, acceptedAt: now, invitedBy: inv.invitedByPid ?? inv.invitedBy, ...inviteExtras(inv) }, { home: false, teamLocked: true });
        await Promise.all([
          dropInvites(aid, [{ id, email: inv.email }]),
          logTeam(aid, { kind: "joined", actor: { pid, email: fresh.email }, target: { pid, email: fresh.email }, role: inv.role, via: "web" }, { teamLocked: true }),
        ]);
        return { aid, role: inv.role, name: fresh.name, email: normalizeEmail(fresh.email) };
      });
    });
  } finally {
    await db.unlock(use);
  }
  if ("ok" in done) return done;
  return { ok: true, member: { name: done.name, email: done.email, role: done.role, memberOf: done.aid } };
}

/**
 * Decline an invite (rules 3119-3122): the holder of the mailed link says no, signed in or not. The invite is found from
 * the token only (its SHA-256, as accept does), never from an account, an owner, an address or an id in the request, and
 * the token is checked for shape first. Under `inviteuse:{hash}` (so an accept and a decline of the same invite never
 * both run) and then `lock:team:{aid}`, the invite is read again and must still be stored, unexpired, in its account's
 * index and for an account that still exists; otherwise `invalid` and nothing changes. Then the record, the index entry
 * and the invitee's inbox entry go (`dropInvites`: the link stops working at once and the seat it held is free) and the
 * team log gets one `invite_declined` row naming the invited address only (no person id: the invitee may have no login).
 * The answer carries the account and the address for the route to tell the owner; it never reaches the browser.
 */
export async function declineInvite(token: string): Promise<{ ok: true; declined: { aid: AccountId; email: string; role: TeamRole } } | TeamFail> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return fail("invalid");
  const id = inviteId(token);
  const first = await db.get<Invite>(inviteKey(id));
  if (!first || expired(first)) return fail("invalid");
  const use = globalKey.inviteUse(id);
  if (!(await db.lock(use, 30))) return fail("invalid"); // being accepted or declined right now
  try {
    const aid = aidFrom(inviteAccount(first));
    const done = await withTeamLock(aid, async () => {
      const [live, indexed, owner] = await Promise.all([db.get<Invite>(inviteKey(id)), db.sismember(invitesKey(aid), id), getAccount(aid)]);
      if (!live || expired(live) || inviteAccount(live) !== aid || !isTeamRole(live.role) || !indexed || !owner) return null;
      const email = normalizeEmail(live.email);
      await Promise.all([
        dropInvites(aid, [{ id, email }]),
        logTeam(aid, { kind: "invite_declined", actor: { email }, target: { email }, role: live.role, via: "web" }, { teamLocked: true }),
      ]);
      return { aid, email, role: live.role };
    });
    return done ? { ok: true, declined: done } : fail("invalid");
  } finally {
    await db.unlock(use);
  }
}

/** One row of the invitations inbox: what the person may see of an invite to their own address, never its id or token. */
export type WaitingInvite = { workspace: string; inviter: string; role: TeamRole; expiresAt: string };

/**
 * The invitations inbox (multi-workspace M3, spec section 9; rule 2753): the open invites to the signed-in person's OWN
 * verified address. `p` is the person `currentPerson()` resolved, never an address from the request; an unverified
 * address reads nothing (whoever typed it has not proved it is theirs). The ids in `invitesfor:{email}` are re-read in
 * one round and kept only while the invite is for this address, unexpired, still in its account's index and still
 * standing (`inviteHolds`, the same check accept makes); the account, its inviter and its brand name come in one more
 * round. What no longer stands leaves the set. Show only: the answer has no id and no token, so accepting stays on the
 * mailed link. Empty while `MULTI_ORG` is off.
 */
export async function invitesWaiting(p: Person): Promise<WaitingInvite[]> {
  if (!MULTI_ORG || !p.emailVerifiedAt) return [];
  const e = normalizeEmail(p.email);
  const ids = (await db.smembers(accountKey.invitesFor(e))).filter((id) => TOKEN_RE.test(id));
  if (!ids.length) return [];
  const now = Date.now();
  const rows = await pmap(ids, async (id) => {
    const inv = await db.get<Invite>(inviteKey(id));
    if (!inv || expired(inv, now) || !isTeamRole(inv.role) || normalizeEmail(inv.email) !== e) return null;
    const aid = aidFrom(inviteAccount(inv));
    const [owner, inviter, indexed] = await Promise.all([getAccount(aid), getMembership(aid, inviterPid(inv)), db.sismember(invitesKey(aid), id)]);
    if (!owner || isSuspended(owner) || !indexed || !inviteHolds(inv, owner, inviter)) return null;
    const { getBrand } = await import("./brand");
    const [brand, by] = await Promise.all([getBrand(aid), inviter ? getPerson(inviter.pid) : null]);
    const workspace = workspaceLabel(owner, brand);
    return { id, row: { workspace, inviter: by?.name || owner.name, role: inv.role, expiresAt: inv.expiresAt } };
  });
  const gone = ids.filter((_, i) => !rows[i]);
  if (gone.length) await Promise.all(gone.map((id) => db.srem(accountKey.invitesFor(e), id)));
  return rows.filter((r): r is NonNullable<typeof r> => !!r).map((r) => r.row).sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1));
}

/**
 * Undo an invite this request just created, under the team lock (POST /api/team/invite, when mail is configured and the
 * email could not be sent). No role check: it is the creating request's own rollback, never exposed to a caller's id.
 * The team log gets an "invite_cancelled" row (via "system", naming the inviter), so its "invited" row is not left open.
 */
export async function discardInvite(owner: string, id: string) {
  const aid = aidFrom(owner);
  await withTeamLock(aid, async () => {
    const inv = await db.get<Invite>(inviteKey(id));
    await dropInvites(aid, [inv && typeof inv.email === "string" ? { id, email: inv.email } : id]);
    if (inv && inviteAccount(inv) === aid) {
      await logTeam(aid, { kind: "invite_cancelled", actor: { pid: inviterPid(inv), email: normalizeEmail(inv.invitedBy) }, target: { email: inv.email }, role: inv.role, via: "system" }, { teamLocked: true });
    }
  });
}

/** Cancel a pending invite of this account. An admin may cancel only editor and viewer invites. One "invite_cancelled" row. */
export async function cancelInvite(owner: User, actor: Actor, id: string, opts: TeamVia = {}): Promise<{ ok: true } | TeamFail> {
  const acting = { ...owner, actor };
  if (!can(acting, "team.invite.cancel")) return fail("forbidden");
  if (typeof id !== "string" || !TOKEN_RE.test(id)) return fail("not_found");
  const aid = aidOf(owner);
  const inv = await db.get<Invite>(inviteKey(id));
  if (!inv || inviteAccount(inv) !== aid) return fail("not_found");
  if (inv.role === "admin" && !can(acting, "team.invite.admin")) return fail("forbidden");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  // Under the team lock, like every other seat change: an accept holding it either finishes first (and this invite is
  // gone: the person joined) or runs after and finds the invite cancelled. Never both "cancelled" and "joined".
  const done = await withTeamLock(aid, async () => {
    const cur = await db.get<Invite>(inviteKey(id));
    if (!cur || inviteAccount(cur) !== aid) return false;
    await Promise.all([
      dropInvites(aid, [{ id, email: cur.email }]),
      logTeam(aid, { kind: "invite_cancelled", actor: who(actor), target: { email: cur.email }, role: cur.role, via: opts.via ?? "web" }, { teamLocked: true }),
    ]);
    return true;
  });
  return done ? { ok: true } : fail("not_found");
}

/** The member of the account whose address is `email`, from the roster (its person id comes from the roster, never the request). */
async function memberByEmail(aid: AccountId, email: string): Promise<MemberView | null> {
  const e = normalizeEmail(typeof email === "string" ? email : "");
  if (!e) return null;
  return (await listMembers(aid)).find((m) => m.email === e) ?? null;
}

/**
 * A member moves its own login to a new address it has proved (rules 1942-1945, src/lib/email-change.ts). R1's copy
 * semantics: the record is written again at the new address, so its person id is the new address. Locks in the
 * documented order (rule 2139): `lock:team:{aid}`, both login locks (the smaller address first, as in
 * `moveUnverifiedAccount`), both person locks (the same order; 60 s expiry, `withMovePersonLock`, as they span the whole
 * move), then the old member record's lock. Inside: the target
 * must hold no owner or member record at all, the record is written at the new address with a fresh session window
 * (every device signs in again, an old session issued for the target address never resolves to it), the membership row,
 * the roster, `orgs:` and the active brand follow the new person id, `carry` moves what other modules keep per login
 * (two-step sign-in), the passkeys move to the new person id (`movePasskeys`, rule 2424: same user handle, every reverse
 * entry rewritten), and only then the old record, its membership row, roster and `orgs:` entries, its passkey keys, its `person:` row
 * (and any leftover row at the new address: the person is read from the new legacy record until its next credential
 * write), its pending invites and its feed and booking links go. No team log row: the membership is the same.
 */
export async function moveMemberLogin(owner: string, from: string, target: string, carry?: (from: string, to: string) => Promise<void>): Promise<"ok" | "exists" | "not_found"> {
  const old = normalizeEmail(from);
  const to = normalizeEmail(target);
  if (to === old) return "exists";
  const aid = aidFrom(owner);
  const [oldPid, toPid] = [pidFrom(old), pidFrom(to)];
  const [first, second] = old < to ? [old, to] : [to, old];
  return withTeamLock(aid, () => withLoginLock(first, () => withLoginLock(second, () => withMovePersonLock(pidFrom(first), () => withMovePersonLock(pidFrom(second), async () => {
    const res = await withMemberLock(old, async (cur) => {
      if (cur.memberOf !== aid) return "not_found" as const;
      const [taken, m, read, blocked] = await Promise.all([getLogin(to), getMember(to), readMembership(aid, oldPid), addressBlocked(to, oldPid)]);
      // Account-id R2 (rules 2740, 2743): a held address, or one whose `user:`/`person:` key an account that moved in place
      // still holds (L3: this copy writes `person:{to}`), is taken too. Both are never there while `OPAQUE_IDS` is off.
      if (taken || m || blocked) return "exists" as const;
      const [sent, brand, brandIn] = await Promise.all([listInvites(aid), db.get<string>(accountKey.activeBrand(old)), db.get<string>(personKey.activeBrand(oldPid, aid))]);
      const { devicesAfter: _d, ...rest } = cur;
      // R1: the record is written again at the new address, so its person id is the new address (the roster and the
      // other per-login keys name the address). The move in place that keeps the id comes with R2 (spec section 6).
      const moved: Member = { ...rest, id: to, email: to, sessionsAfter: new Date().toISOString() };
      await saveMember(moved);
      const row = read.ms ?? { aid, pid: oldPid, role: moved.role, acceptedAt: moved.acceptedAt, invitedBy: moved.invitedBy, ...(moved.disabled ? { disabled: moved.disabled } : {}) };
      await Promise.all([
        putRow(aid, toPid, { ...row, aid, pid: toPid }),
        db.del(personKey.person(toPid)),
        brand ? db.set(accountKey.activeBrand(to), brand) : null,
        brandIn ? db.set(personKey.activeBrand(toPid, aid), brandIn) : null,
        claimLogin(to, to),
      ]);
      if (carry) await carry(old, to);
      // The passkeys follow the person (rule 2424): both person locks are held here. Then whatever passkey key the old pid
      // still has (an open registration, an entry still naming it) goes with it, unless the move could not run (a person
      // unreadable: the keys stay, inert under rules 2402 and 2405, and the reason is logged).
      const pk = await movePasskeys(oldPid, toPid, { personLocked: true });
      if (pk === "skipped") log.warn("member move kept passkeys", { reason: "passkey_move_skipped" });
      const oldPasskeys = pk === "skipped" ? [] : await passkeyKeys(oldPid);
      const mine = sent.filter((i) => (i.invitedByPid !== undefined ? i.invitedByPid === oldPid : normalizeEmail(i.invitedBy) === old)).map((i) => i.id);
      await Promise.all([
        ...oldPasskeys.map((k) => db.del(k)),
        db.del(memberKey(old)),
        db.del(accountKey.activeBrand(old)),
        db.del(accountKey.membership(aid, oldPid)),
        db.del(personKey.activeBrand(oldPid, aid)),
        db.srem(membersKey(aid), old),
        db.srem(personKey.orgs(oldPid), aid),
        db.del(personKey.person(oldPid)),
        db.del(personKey.lastOrg(oldPid)),
        dropInvites(aid, mine),
        releaseLogin(old, memberPid(cur), { locked: true }),
      ]);
      // The old person id's links in this account, its home (`cur.memberOf` is `aid`): the (pid, aid) pointers, the legacy
      // per-login ones and a link made before M1. Leaf locks, taken under lock:member (rule 2139).
      const was = { pid: oldPid, aid, login: old, home: true };
      await Promise.all([revokeFeed(was), revokeBook(was)]);
      return "ok" as const;
    });
    return res ?? "not_found";
  })))));
}

/**
 * Remove a member (rules 2124, 2125). The owner may remove anyone; an admin only plain members of this account. The owner
 * itself is no membership and cannot be removed. Checked again on the membership read under `lock:team:{aid}`; one
 * "removed" team log row.
 */
export async function removeMember(owner: User, actor: Actor, email: string, opts: TeamVia = {}): Promise<{ ok: true } | TeamFail> {
  const acting = { ...owner, actor };
  if (!can(acting, "team.remove.member")) return fail("forbidden");
  const aid = aidOf(owner);
  const m = await memberByEmail(aid, email);
  if (!m) return fail("not_found");
  if (m.role === "admin" && !can(acting, "team.remove.admin")) return fail("forbidden");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  const res = await withTeamLock(aid, async () => {
    const cur = await readMembership(aid, m.pid);
    if (!cur.ms) return "not_found" as const;
    if (cur.ms.role === "admin" && !can(acting, "team.remove.admin")) return "forbidden" as const;
    await deleteMembership(aid, m.pid, { home: cur.home, teamLocked: true });
    await logTeam(aid, { kind: "removed", actor: who(actor), target: { pid: m.pid, email: m.email }, role: cur.ms.role, via: opts.via ?? "web" }, { teamLocked: true });
    return "ok" as const;
  });
  return res === "ok" ? { ok: true } : fail(res);
}

/**
 * Founder console: delete a member login whatever state it is in (an address taken through a hand-passed invite link, a
 * record whose owner is gone, a record off its roster), under the same locks as any removal. Members never enter
 * `users:all`, so without this nothing but a hand edit of the store could free such an address. False when there is no
 * member login at `email`. The team log row (when the account still exists) says `via: "console"` and names the
 * account's owner as the actor: staff are never named (rule 2129).
 *
 * A person with no member record (a `p_` person, multi-workspace M1 rule 2130) is found through the login: the
 * membership sign-in opens (`getLogin`, the one the console's GET shows), read in the same round as the legacy record.
 * Only that membership goes; a person who still holds another workspace keeps the address (`forgetPersonIfAlone`).
 */
export async function forceRemoveMember(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const [m, login] = await Promise.all([getMember(e), getLogin(e)]);
  const p = !m && login?.kind === "member" && !login.member && login.acct && PERSON_ID.test(login.pid) ? { aid: login.acct, pid: login.pid } : null;
  if (!m && !p) return false;
  const aid = m ? aidFrom(m.memberOf) : p!.aid;
  const pid = m ? pidFrom(memberPid(m)) : p!.pid;
  return withTeamLock(aid, async () => {
    const [cur, account] = await Promise.all([readMembership(aid, pid), getAccount(aid)]);
    // A legacy member: only its home membership (the record); a `p_` person: the membership row on the roster.
    if (m ? !cur.home : !cur.ms) return false;
    await deleteMembership(aid, pid, { home: cur.home, teamLocked: true });
    if (account && acct(account) === aid) {
      await logTeam(aid, { kind: "removed", actor: { pid: ownerOf(account), email: normalizeEmail(account.email) }, target: { pid, email: e }, role: cur.ms?.role ?? m?.role ?? "member", via: "console" }, { teamLocked: true });
    }
    return true;
  });
}

/**
 * Change a member's role (owner only, rule 2125). The owner role is never assignable, removable or transferable in v1.
 * A demoted admin's pending invites go (they could never be accepted). One "role_changed" row when the role changes.
 */
export async function setRole(owner: User, actor: Actor, email: string, rawRole: string): Promise<{ ok: true } | TeamFail> {
  const role = teamRoleFrom(rawRole);
  if (!role) return fail("invalid_role");
  if (!can({ ...owner, actor }, "team.role")) return fail("forbidden");
  const aid = aidOf(owner);
  const m = await memberByEmail(aid, email);
  if (!m) return fail("not_found");
  const done = await withTeamLock(aid, async () => {
    const [cur, o, members, invites] = await Promise.all([readMembership(aid, m.pid), getAccount(aid), listMembers(aid), listInvites(aid)]);
    if (!cur.ms) return false;
    // A viewer made editor or admin may need a seat the free viewers did not (rule 3753): refused when none is left.
    const after = members.map((x) => (x.pid === m.pid ? { ...x, role } : x));
    if (o && !cur.ms.disabled && seatCount(after, invites) > seatLimit(o) && seatCount(after, invites) > seatCount(members, invites)) return "seats" as const;
    const demoted = cur.ms.role === "admin" && role !== "admin";
    const changed = cur.ms.role !== role;
    await writeMembership(aid, m.pid, { ...cur.ms, role }, { home: cur.home, teamLocked: true });
    // An admin's invites could never be accepted once the admin is a plain member (`inviteHolds`), yet each would
    // keep holding a seat for up to seven days. They go with the role, as they go with the membership in `deleteMembership`.
    const sent = demoted ? (await listInvites(aid)).filter((i) => (i.invitedByPid !== undefined ? i.invitedByPid === m.pid : normalizeEmail(i.invitedBy) === m.email)) : [];
    await Promise.all([
      dropInvites(aid, sent),
      changed ? logTeam(aid, { kind: "role_changed", actor: who(actor), target: { pid: m.pid, email: m.email }, role, via: "web" }, { teamLocked: true }) : null,
    ]);
    return true;
  });
  if (done === "seats") return fail("seats_full");
  return done ? { ok: true } : fail("not_found");
}

/**
 * Change a member's brand scope, approve toggle or monthly credit cap (rules 3756, 3760, 3770; PATCH /api/team/member).
 * Scope and approving need `team.access` (owner and admin, never a scoped admin), and an admin never changes another
 * admin's; the cap needs `team.cap` (the owner). `brands` null means every brand. One "access_changed" team log row.
 */
export async function setAccess(
  owner: User,
  actor: Actor,
  email: string,
  change: { brands?: unknown; approves?: unknown; creditCap?: unknown },
): Promise<{ ok: true } | TeamFail> {
  const acting = { ...owner, actor };
  const wantsAccess = change.brands !== undefined || change.approves !== undefined;
  const wantsCap = change.creditCap !== undefined;
  if (!wantsAccess && !wantsCap) return fail("invalid");
  if (wantsAccess && !can(acting, "team.access")) return fail("forbidden");
  if (wantsCap && !can(acting, "team.cap")) return fail("forbidden");
  const extras = await accessFrom(owner, { brands: change.brands, approves: change.approves });
  if (!extras) return fail("invalid");
  let cap: number | null | undefined;
  if (wantsCap) {
    if (change.creditCap === null) cap = null;
    else if (typeof change.creditCap === "number" && Number.isInteger(change.creditCap) && change.creditCap >= 0 && change.creditCap <= 10_000_000) cap = change.creditCap;
    else return fail("invalid");
  }
  const aid = aidOf(owner);
  const m = await memberByEmail(aid, email);
  if (!m) return fail("not_found");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  const done = await withTeamLock(aid, async () => {
    const cur = await readMembership(aid, m.pid);
    if (!cur.ms) return "not_found" as const;
    if (wantsAccess && cur.ms.role === "admin" && !can(acting, "team.role")) return "forbidden" as const;
    const next: MembershipValue = { ...cur.ms };
    if (change.brands !== undefined) {
      if (extras.brands) next.brands = extras.brands;
      else delete next.brands;
    }
    if (change.approves !== undefined) {
      if (extras.approves) next.approves = true;
      else delete next.approves;
    }
    if (wantsCap) {
      if (cap === null) delete next.creditCap;
      else next.creditCap = cap;
    }
    await Promise.all([
      writeMembership(aid, m.pid, next, { home: cur.home, teamLocked: true }),
      logTeam(aid, { kind: "access_changed", actor: who(actor), target: { pid: m.pid, email: m.email }, role: cur.ms.role, via: "web" }, { teamLocked: true }),
    ]);
    return "ok" as const;
  });
  return done === "ok" ? { ok: true } : fail(done);
}

/**
 * The brand scope and approve toggle a request asks for (rules 3756, 3760), checked: `brands` is null/absent (every
 * brand) or a list of this account's own ACTIVE brand ids, read from the account's stored list (an id the account does
 * not have refuses the whole change); `approves` a boolean. Null when malformed.
 */
async function accessFrom(owner: User, input: { brands?: unknown; approves?: unknown }): Promise<{ brands?: string[]; approves?: true } | null> {
  const out: { brands?: string[]; approves?: true } = {};
  if (input.approves !== undefined && typeof input.approves !== "boolean") return null;
  if (input.approves === true) out.approves = true;
  if (input.brands === undefined || input.brands === null) return out;
  if (!Array.isArray(input.brands) || input.brands.length > 200 || !input.brands.every((b) => typeof b === "string")) return null;
  const { listBrands } = await import("./brands");
  const own = new Set((await listBrands(acct(owner))).filter((b) => b.status === "active").map((b) => b.id));
  const want = [...new Set(input.brands as string[])];
  if (!want.length || !want.every((b) => own.has(b))) return null;
  // The stored ids are the account's own, in its list's order: nothing from the request is kept as given.
  out.brands = [...own].filter((b) => want.includes(b));
  return out;
}

/** What an accepted invite gives its membership row (rules 3756, 3760): the scope and toggle, only when well formed. */
const inviteExtras = (inv: Invite): { brands?: string[]; approves?: true } => ({
  // A malformed scope is no brand at all, never every brand.
  ...(inv.brands !== undefined ? { brands: Array.isArray(inv.brands) && inv.brands.every((b) => typeof b === "string") ? [...inv.brands] : [] } : {}),
  ...(inv.approves === true ? { approves: true as const } : {}),
});

/** A member leaves the account. The caller clears the session cookie. The owner cannot leave. One "left" row. */
export async function leaveTeam(u: User): Promise<{ ok: true } | TeamFail> {
  const a = u.actor;
  if (!a || a.kind !== "member" || !can(u, "team.leave")) return fail("forbidden");
  const aid = aidOf(u);
  if (a.pid === ownerOf(u)) return fail("forbidden");
  if (!(await getMembership(aid, a.pid))) return fail("not_found");
  const res = await withTeamLock(aid, async () => {
    const cur = await readMembership(aid, a.pid);
    if (!cur.ms) return "not_found" as const;
    const person = await getPerson(a.pid);
    const email = normalizeEmail(person?.email ?? a.email);
    await deleteMembership(aid, a.pid, { home: cur.home, teamLocked: true });
    await logTeam(aid, { kind: "left", actor: { pid: a.pid, email }, target: { pid: a.pid, email }, role: cur.ms.role, via: "web" }, { teamLocked: true });
    return "ok" as const;
  });
  return res === "ok" ? { ok: true } : fail(res);
}

/**
 * Fit the account's memberships to its seat limit (run on every plan or seat change, rule 2118: seats are per account),
 * relative to who is active NOW. Over the limit, the newest ENABLED memberships get `disabled: "seats"` (kept, never
 * deleted). Under it, paused ones come back oldest-first, but only into seats nobody holds: pending invites keep theirs.
 * Pending invites that no longer fit are cancelled, newest first. Re-applying the same limit changes nothing: the whole
 * team is never re-ranked, so a member the owner brought in after a downgrade is not swapped for one the plan paused
 * earlier. Only this account's memberships change: the same person's membership elsewhere is untouched. Each pause or
 * resume writes one "paused_for_seats" / "resumed" row (via "system", the owner as the actor).
 *
 * `teamLocked`: the caller holds `lock:team:{aid}` already (the founder's plan change, POST /api/admin/plan, takes it
 * before `lock:user` so a busy team refuses the change before anything is written): the lock is not reentrant.
 */
export async function enforceSeats(owner: User | string, opts: { teamLocked?: boolean } = {}): Promise<{ limit: number; disabled: string[]; enabled: string[]; cancelled: string[] }> {
  const aid = typeof owner === "string" ? aidFrom(normalizeEmail(owner)) : aidOf(owner);
  const locked = <T,>(fn: () => Promise<T>) => (opts.teamLocked ? fn() : withTeamLock(aid, fn));
  return locked(async () => {
    const [o, members, invites] = await Promise.all([getAccount(aid), listMembers(aid), listInvites(aid)]);
    const limit = o ? seatLimit(o) : 1;
    // Rule 3753: the oldest `FREE_VIEWERS` viewers (members first, then viewer invites) take no seat; everyone else fills
    // the `limit - 1` paid places oldest first. Without viewers this is the count of rule 2118, unchanged.
    let paidLeft = Math.max(0, limit - 1);
    let freeLeft = FREE_VIEWERS;
    const place = (role: unknown): boolean => {
      if (role === "viewer" && freeLeft > 0) { freeLeft--; return true; }
      if (paidLeft > 0) { paidLeft--; return true; }
      return false;
    };
    const pause = members.filter((m) => !m.disabled).filter((m) => !place(m.role));
    const cancel = invites.filter((i) => !place(i.role));
    const resume = members.filter((m) => m.disabled).filter((m) => place(m.role));
    const change = [...pause.map((m) => ({ m, off: true })), ...resume.map((m) => ({ m, off: false }))];
    const system = o ? { pid: ownerOf(o) as string, email: normalizeEmail(o.email) } : { pid: aid as string, email: "" };
    const applied = await Promise.all([
      pmap(change, async ({ m, off }) => {
        const cur = await readMembership(aid, m.pid);
        if (!cur.ms) return null;
        const { disabled: _was, ...base } = cur.ms;
        void _was;
        await Promise.all([
          writeMembership(aid, m.pid, off ? { ...base, disabled: "seats" } : base, { home: cur.home, teamLocked: true }),
          logTeam(aid, { kind: off ? "paused_for_seats" : "resumed", actor: system, target: { pid: m.pid, email: m.email }, role: cur.ms.role, via: "system" }, { teamLocked: true }),
        ]);
        return { email: m.email, off };
      }),
      dropInvites(aid, cancel),
    ]).then(([rows]) => rows.filter((r): r is { email: string; off: boolean } => !!r));
    return {
      limit,
      disabled: applied.filter((r) => r.off).map((r) => r.email),
      enabled: applied.filter((r) => !r.off).map((r) => r.email),
      cancelled: cancel.map((i) => i.id),
    };
  });
}

/**
 * The calendar feed and booking link owner of every roster entry of `aid` (`roster`: `members:{aid}` as the caller read
 * it), in ONE `pmap` round of the person and the legacy record: exactly what `deleteMembership` revokes, the (person,
 * account) pointers and, for a HOME membership only, the legacy per-login ones. A membership in an account that is not
 * the person's home never reaches the legacy pointers, which belong to that home. `wipeAccount` revokes these first, before
 * anything slow can fail (rule 598); `deleteMembership` revokes them again under its locks.
 */
export async function rosterLinks(aid: AccountId, roster: readonly string[]): Promise<LinkOwner[]> {
  return pmap(roster, async (p) => {
    const pid = pidFrom(p);
    const [person, m] = await Promise.all([getPerson(pid), getMember(pid)]);
    const home = isHome(m, aid, pid);
    const email = person ? normalizeEmail(person.email) : home ? pid : null;
    return { pid, aid, login: email ?? "", home: home && !!email };
  });
}

/**
 * Account deletion (src/lib/account.ts `wipeAccount`, plan reconciliation 7, rule 2126): every membership of the account
 * (`deleteMembership`: the row, the roster and `orgs:` entries, the per-(person, account) active brand and links, for a
 * home membership the legacy member record and its per-login keys, and the person only when nothing else is left), then
 * every invite, both indexes and the team log (`teamlog:{aid}`: its rows hold member addresses), then `finish` (the account's own records, `user:{owner}` among them), then the owner's
 * `orgs:` entry, all under `lock:team:{aid}`: an accept already holding it finishes first and its member is deleted here,
 * and one that takes it afterwards re-reads the owner and finds none. A person who belongs elsewhere keeps every key of
 * the other accounts and keeps signing in there.
 *
 * Order: the members go FIRST (one `pmap` round; each `home` is read from the legacy record in the same round): a login,
 * person or member lock that cannot be had throws before any invite, index or `finish` write, so the owner's account is
 * still whole and a retry runs the wipe again (the 409 of DELETE /api/account and the console's delete is true). The
 * owner's `orgs:` entry goes after `finish`, so a `finish` that throws leaves a `p_` owner (signed in through `orgs:`
 * only) able to sign in to the account that is still there.
 *
 * `teamLocked`: the caller holds `lock:team:{aid}` already (the owner address move, `withMoveTeamLock`): the lock is not
 * reentrant. No `userLocked`: nothing here takes `lock:user` (the account record is read, never written).
 */
export async function wipeMemberships(aid: AccountId, opts: { teamLocked?: boolean; finish?: () => Promise<void> } = {}): Promise<void> {
  const locked = <T,>(fn: () => Promise<T>) => (opts.teamLocked ? fn() : withTeamLock(aid, fn));
  await locked(async () => {
    const [pids, ids, account] = await Promise.all([db.smembers(membersKey(aid)), db.smembers(invitesKey(aid)), getAccount(aid)]);
    await pmap(pids, async (p) => {
      const pid = pidFrom(p);
      await deleteMembership(aid, pid, { home: isHome(await getMember(pid), aid, pid), teamLocked: true });
    });
    await pmap([...ids.map(inviteKey), membersKey(aid), invitesKey(aid), accountKey.teamLog(aid)], (k) => db.del(k));
    if (opts.finish) await opts.finish();
    // The owner is no membership row (rule 2115): its `orgs:` entry for this account is the last trace of it here.
    if (account && acct(account) === aid) await db.srem(personKey.orgs(ownerOf(account)), aid);
  });
}

/**
 * The team as GET /api/team returns it: the acting person, seats, the roster (owner first) and, for admin and owner,
 * pending invites. Never a password hash or an invite token. Null without an actor. For admin and owner also
 * `approvals`: each person's approvals, rejections, edits and approval rate over the last 30 days (rule 1480).
 */
export async function teamView(u: User) {
  const a = u.actor;
  if (!a) return null;
  const manage = can(u, "team.access") || can(u, "team.cap");
  const { listBrands } = await import("./brands");
  const [members, invites, approvals, brands] = await Promise.all([
    listMembers(acct(u)),
    listInvites(acct(u)),
    can(u, "team.approvals.view") ? teamApprovals(u) : null,
    manage ? listBrands(acct(u)) : null,
  ]);
  // This month's credits per member (rule 3771), read from the account record: for the owner, who sets the caps.
  const seesSpend = can(u, "team.cap");
  // Scope, approve toggle and cap (rules 3756-3770) are shown to those who may change them; to the rest only roles.
  const access = (m: MemberView) => (manage ? { ...(m.brands ? { brands: m.brands } : {}), ...(m.approves ? { approves: true as const } : {}), ...(typeof m.creditCap === "number" ? { creditCap: m.creditCap } : {}), ...(seesSpend ? { spent: personSpendFor(u, m.pid) } : {}) } : {});
  // Rule 3502: every listed person's picture in ONE mget (`avatarUrls`); a person without one shows an initial.
  const ownerPid = ownerOf(u);
  const faces = await avatarUrls([ownerPid, ...members.map((m) => m.pid)]);
  const face = (pid: PersonId) => (faces.has(pid) ? { avatar: faces.get(pid)! } : {});
  const used = seatCount(members, invites);
  const limit = seatLimit(u);
  const mayBuy = can(u, "billing.seats") && extraSeatsSold(u.plan) && !billingLocked(u.billing) && used <= limit;
  // Rules 4040, 4049: on a yearly subscription the price of a seat bought now, or why none is sold online.
  const how = mayBuy ? await (await import("./billing")).seatCharge(u) : null;
  return {
    you: { email: a.email, name: a.name, role: a.role },
    // Paid seats (rule 3369): the included seats, the paid extras, the unit price, and whether this person may buy one.
    // `canBuy` also needs the team at most full (`seatBuyable`'s "exactly one seat short" for the next invite).
    seats: {
      used,
      limit,
      freeViewers: FREE_VIEWERS,
      freeViewersLeft: freeViewersLeft(members, invites),
      included: includedSeats(u),
      extra: paidExtraSeats(u),
      unitSar: EXTRA_SEAT_MONTHLY_SAR,
      canBuy: mayBuy && how?.mode !== "blocked",
      ...seatChargeView(how),
    },
    members: [
      { email: u.email, name: u.name, role: "owner" as const, ...face(ownerPid) },
      ...members.map((m) => ({ email: m.email, name: m.name, role: m.role, acceptedAt: m.acceptedAt, ...(m.disabled ? { disabled: m.disabled } : {}), ...access(m), ...face(m.pid) })),
    ],
    invites: can(u, "team.invites.view")
      ? invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, invitedBy: i.invitedBy, ...(manage && i.brands ? { brands: i.brands } : {}), ...(manage && i.approves ? { approves: true as const } : {}) }))
      : [],
    ...(approvals ? { approvals } : {}),
    // The account's own active brands, for the scope picker, and the approval policy (rule 3762): managers only.
    ...(brands ? { brands: brands.filter((b) => b.status === "active").map((b) => ({ id: b.id, name: b.name })), approvalRequired: u.approvalRequired === true } : {}),
  };
}
