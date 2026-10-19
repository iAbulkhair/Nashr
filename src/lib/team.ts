import bcrypt from "bcryptjs";
import { isSuspended } from "./suspension";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { log } from "./log";
import { pmap } from "./parallel";
import { withNamedLock } from "./locks";
import { revokeBook } from "./booking-token";
import { revokeFeed } from "./feed-token";
import { claimLogin, getAccount, getLogin, normalizeEmail, releaseLogin, seatLimit, strongPassword, validEmail, type Actor, type User } from "./auth";
import { acct, LoginIndex, OPAQUE_IDS } from "./account-id";
import { can } from "./roles";
import { teamApprovals } from "./approver-stats";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "./keys";
import { parseStored, type MembershipValue } from "./stored";
import { aidOf, getMembership, legacyHomeFrom, membershipFromRaw, ownerOf, type Membership } from "./membership";
import { createPersonRecord, getPerson, withPersonLock } from "./person";
import { logTeam } from "./teamlog";
import { MULTI_ORG } from "./multi-org";
import { mfaKeys } from "./mfa";
import { revokeAllDevices } from "./devices";

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
 *   inviteuse:{hash}   single use at accept
 *
 * Every membership event writes the new shape and the legacy one in the same locked step, and one team log row under the
 * same `lock:team:{aid}`. Lock order (rule 2139), always outer to inner:
 *   inviteuse → lock:team:{aid} → lock:login:{email} → lock:person:{pid} → lock:member:{email} → lock:user:{aid}.
 * No lock is reentrant: a function called under a held lock says so (`teamLocked`, `locked`).
 */

export type TeamRole = "admin" | "member";
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
export type MemberView = { pid: PersonId; email: string; name: string; lang: "ar" | "en"; role: TeamRole; acceptedAt: string; invitedBy: string; disabled?: "seats" };
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
};
/** A pending invite with its id (the SHA-256 of the token, which is what DELETE /api/team/invite takes). */
export type PendingInvite = Invite & { id: string };

export type TeamError = "invalid_email" | "invalid_role" | "forbidden" | "unavailable" | "not_found" | "invalid" | "weak_password" | "invalid_name";
export type SeatsError = { ok: false; error: "seats"; used: number; limit: number };
export type TeamFail = { ok: false; error: TeamError } | SeatsError;

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
const pidFrom = (s: string): PersonId => storedPersonId(s);

export const isTeamRole = (v: unknown): v is TeamRole => v === "admin" || v === "member";
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
const rowOf = (m: MembershipValue): MembershipValue => ({ aid: m.aid, pid: m.pid, role: m.role, acceptedAt: m.acceptedAt, invitedBy: m.invitedBy, ...(m.disabled ? { disabled: m.disabled } : {}) });

/** The new shape of a membership, in one round: the row, the roster entry and the person's `orgs:` entry. */
async function putRow(aid: AccountId, pid: PersonId, row: MembershipValue): Promise<void> {
  await Promise.all([db.set(accountKey.membership(aid, pid), rowOf({ ...row, aid, pid })), db.sadd(accountKey.members(aid), pid), db.sadd(personKey.orgs(pid), aid)]);
}

/**
 * Write one membership (rule 2132): `SET mbr:{aid}:{pid}`, the roster entry and `orgs:{pid}` in one round, and for the
 * person's HOME membership the legacy `member:{email}` fields (`role`, `acceptedAt`, `disabled`) under `lock:member`, so
 * a build rolled back to R1 reads the same membership. The legacy record is changed in place (`Object.assign` keeps its
 * field order, a resume deletes `disabled` as R1 did) and only when a field differs, so a home record stays exactly what
 * R1 wrote; `invitedBy` and `memberOf` never change after an accept and are left as R1 wrote them (the row's `invitedBy`
 * is the inviter's person id, the legacy record's their address). The caller holds `lock:team:{aid}` (`teamLocked`).
 */
export async function writeMembership(aid: AccountId, pid: PersonId, row: MembershipValue, opts: { home: boolean; teamLocked: true }): Promise<void> {
  await Promise.all([
    putRow(aid, pid, row),
    opts.home
      ? withMemberLock(pid, async (m) => {
          if (!isHome(m, aid, pid)) return;
          if (m.role === row.role && m.acceptedAt === row.acceptedAt && m.disabled === row.disabled) return;
          Object.assign(m, { role: row.role, acceptedAt: row.acceptedAt });
          if (row.disabled) m.disabled = row.disabled;
          else delete m.disabled;
          await saveMember(m);
        })
      : null,
  ]);
}

/**
 * Does the person still hold anything outside `aid`: an account they own, or a membership (paused ones count: the person
 * is kept for them)? Read from `orgs:{pid}` AND the legacy records (a legacy member accepted before M1 has no `orgs:`
 * entry), each re-checked on the forward records (`ownerOf`, `getMembership`). Two rounds.
 */
async function holdsElsewhere(pid: PersonId, aid: AccountId): Promise<boolean> {
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
 * Plan reconciliation 7: with `MULTI_ORG` off, a person with no owned account and no other membership left is deleted as
 * R1 deleted a removed member's login: `person:{pid}`, its account list and last pick, and, while the login index still
 * names this person (an address taken by someone else since keeps everything), the login index, two-step sign-in, the
 * waiting address change, the Google link both ways and every device session. The caller holds `lock:login:{email}` →
 * `lock:person:{pid}` (rule 2139: `deleteMembership` takes them before its first write), so an accept or a credential
 * write of the same person waits for it.
 */
async function forgetPersonIfAlone(pid: PersonId, email: string, aid: AccountId, opts: { loginLocked: true; personLocked: true }): Promise<void> {
  void opts;
  if (MULTI_ORG) return;
  if (await holdsElsewhere(pid, aid)) return;
  const [rawIdx, sub] = await Promise.all([db.get<unknown>(accountKey.login(email)), db.get<unknown>(accountKey.googleSub(email))]);
  const idx = parseStored("login", LoginIndex, rawIdx, null);
  const own = !idx || idx.pid === pid;
  const google = typeof sub === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(sub) ? [globalKey.googleAccount(sub)] : [];
  const keys = [personKey.person(pid), personKey.orgs(pid), personKey.lastOrg(pid), ...(own ? [...mfaKeys(email), accountKey.emailChange(email), accountKey.emailChangeTries(email), accountKey.googleSub(email), ...google] : [])];
  await Promise.all([...keys.map((k) => db.del(k)), own ? revokeAllDevices(email) : null, releaseLogin(email, pid, { locked: true })]);
}

/**
 * Delete one membership (rules 2124, 2132) and everything that is the person's in the account: `mbr:{aid}:{pid}`, the
 * roster entry, the `orgs:` entry, the per-(person, account) active brand and the invites the person sent in this
 * account, in one round; for the HOME membership also the legacy `member:{email}` record and `activebrand:{login}`,
 * under `lock:member` and only while the record is still this membership's (a profile or password save in flight can
 * never bring the login back behind the roster's back). Then the person's calendar feed and booking links, and with
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
    const sent = invites.filter((i) => (i.invitedByPid !== undefined ? i.invitedByPid === pid : email !== null && normalizeEmail(i.invitedBy) === email)).map((i) => i.id);
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
    // Task 7: revoke the person's (pid, aid) feed and booking links here. Until then the legacy per-login links, which
    // belong to the home account only. After the record is gone, so nothing can mint a new one for it (`revokeFeed` waits
    // out a create already running); the link is refused at read time while the login is gone (`feedHolds`).
    if (opts.home && email) await Promise.all([revokeFeed(email), revokeBook(email)]);
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
  input: { email: string; name: string; passHash: string; lang: "ar" | "en"; role: TeamRole; invitedBy: string; invitedByPid?: string },
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
  await withPersonLock(pid, async () => {
    await createPersonRecord({ pid, email, name: member.name, lang: member.lang, passHash: member.passHash, createdAt: now, sessionsAfter: now }, { loginLocked: true, personLocked: true });
    if (home) await saveMember(member);
    await Promise.all([
      writeMembership(aid, pid, { aid, pid, role: input.role, acceptedAt: now, invitedBy: input.invitedByPid ?? input.invitedBy }, { home, teamLocked: true }),
      claimLogin(email, pid),
    ]);
  });
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
    };
  });
  return rows.filter((m): m is MemberView => !!m).sort(byAge((m) => m.acceptedAt, (m) => m.email));
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

/** Seats in use (rule 2118, per account): the owner, every membership not paused, and every unexpired invite. */
export async function seatsUsed(owner: string): Promise<number> {
  const [members, invites] = await Promise.all([listMembers(owner), listInvites(owner)]);
  return 1 + members.filter((m) => !m.disabled).length + invites.length;
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
  return !!inviter && inviter.aid === aidOf(owner) && !inviter.disabled && inviter.role === "admin" && inv.role === "member";
}
/** Delete these invites of `owner` (record and index entry). Callers hold `lock:team:{owner}`. */
async function dropInvites(owner: string, ids: string[]) {
  await Promise.all(ids.flatMap((id) => [db.del(inviteKey(id)), db.srem(invitesKey(owner), id)]));
}

/** The acting person as a team log row names them (rule 2129): the person id and the address of the day. */
const who = (a: Pick<Actor, "pid" | "email">) => ({ pid: a.pid as string, email: normalizeEmail(a.email) });

/**
 * Invite `email` into `owner`'s account as `role`. The owner may invite either role; an admin only plain members; a
 * founder impersonating never. The owner's own address, an existing login (owner or member anywhere) and a pending
 * invite in this team all get the same "unavailable", so the route cannot be used to probe who has an account.
 * The seat check runs under `lock:team:{aid}`. Returns the token ONCE: only its SHA-256 is stored. The invite names the
 * account (`aid`, beside `owner`) and the inviter's person id (`invitedByPid`, beside their address); the team log gets
 * an "invited" row.
 */
export async function createInvite(owner: User, actor: Actor, email: string, role: string, lang: string): Promise<{ ok: true; token: string; id: string; invite: Invite } | TeamFail> {
  if (!isTeamRole(role)) return fail("invalid_role");
  const e = normalizeEmail(typeof email === "string" ? email : "");
  if (!validEmail(e)) return fail("invalid_email");
  if (!can({ ...owner, actor }, role === "admin" ? "team.invite.admin" : "team.invite.member")) return fail("forbidden");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  if (e === owner.email || e === normalizeEmail(actor.email)) return fail("unavailable");
  const token = randomBytes(32).toString("hex");
  const id = inviteId(token);
  const aid = aidOf(owner);
  return withTeamLock(aid, async () => {
    // Is the address taken? Through the login resolver (rule 1982), not by reading `user:{address}` as an account.
    const [taken, m, members, invites, fresh] = await Promise.all([getLogin(e), getMember(e), listMembers(aid), listInvites(aid), getAccount(aid)]);
    if (taken || m || invites.some((i) => i.email === e)) return fail("unavailable");
    const limit = seatLimit(fresh ?? owner);
    const used = 1 + members.filter((x) => !x.disabled).length + invites.length;
    if (used + 1 > limit) return { ok: false, error: "seats", used, limit } as SeatsError;
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
    };
    await Promise.all([
      db.set(inviteKey(id), invite, INVITE_TTL_SECONDS),
      db.sadd(invitesKey(aid), id),
      logTeam(aid, { kind: "invited", actor: who(actor), target: { email: e }, role, via: "web" }, { teamLocked: true }),
    ]);
    return { ok: true as const, token, id, invite };
  });
}

/** What the join page shows before anything is consumed. Null for an unknown, expired or orphaned invite, or one `acceptInvite` would refuse for its inviter. */
export async function peekInvite(token: string): Promise<{ team: string; inviter: string; email: string; role: TeamRole; expiresAt: string } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const inv = await db.get<Invite>(inviteKey(inviteId(token)));
  if (!inv || expired(inv)) return null;
  const aid = aidFrom(inviteAccount(inv));
  const { getBrand } = await import("./brand");
  const [owner, inviter, brand] = await Promise.all([getAccount(aid), getMembership(aid, inviterPid(inv)), getBrand(aid)]);
  if (!owner || isSuspended(owner) || !inviteHolds(inv, owner, inviter)) return null;
  const by = inviter ? await getPerson(inviter.pid) : null;
  return { team: brand?.name || owner.name, inviter: by?.name || owner.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
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
      const used = 1 + members.filter((m) => !m.disabled).length + invites.length;
      if (used > limit) return { ok: false, error: "seats", used, limit } as SeatsError;
      return withLoginLock(inv.email, async () => {
        const [taken, m] = await Promise.all([getLogin(inv.email), getMember(inv.email)]);
        if (taken || m) return fail("unavailable");
        const lang = input.lang === "en" || input.lang === "ar" ? input.lang : inv.lang;
        const member = await insertMember(aid, { email: inv.email, name, passHash, lang, role: inv.role, invitedBy: inv.invitedBy, invitedByPid: inv.invitedByPid }, {});
        const pid = pidFrom(memberPid(member));
        await Promise.all([
          dropInvites(aid, [id]),
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
 * Undo an invite this request just created, under the team lock (POST /api/team/invite, when mail is configured and the
 * email could not be sent). No role check: it is the creating request's own rollback, never exposed to a caller's id.
 * The team log gets an "invite_cancelled" row (via "system", naming the inviter), so its "invited" row is not left open.
 */
export async function discardInvite(owner: string, id: string) {
  const aid = aidFrom(owner);
  await withTeamLock(aid, async () => {
    const inv = await db.get<Invite>(inviteKey(id));
    await dropInvites(aid, [id]);
    if (inv && inviteAccount(inv) === aid) {
      await logTeam(aid, { kind: "invite_cancelled", actor: { pid: inviterPid(inv), email: normalizeEmail(inv.invitedBy) }, target: { email: inv.email }, role: inv.role, via: "system" }, { teamLocked: true });
    }
  });
}

/** Cancel a pending invite of this account. An admin may cancel only invites for role "member". One "invite_cancelled" row. */
export async function cancelInvite(owner: User, actor: Actor, id: string): Promise<{ ok: true } | TeamFail> {
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
      dropInvites(aid, [id]),
      logTeam(aid, { kind: "invite_cancelled", actor: who(actor), target: { email: cur.email }, role: cur.role, via: "web" }, { teamLocked: true }),
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
 * `moveUnverifiedAccount`), both person locks (the same order), then the old member record's lock. Inside: the target
 * must hold no owner or member record at all, the record is written at the new address with a fresh session window
 * (every device signs in again, an old session issued for the target address never resolves to it), the membership row,
 * the roster, `orgs:` and the active brand follow the new person id, `carry` moves what other modules keep per login
 * (two-step sign-in), and only then the old record, its membership row, roster and `orgs:` entries, its `person:` row
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
  return withTeamLock(aid, () => withLoginLock(first, () => withLoginLock(second, () => withPersonLock(pidFrom(first), () => withPersonLock(pidFrom(second), async () => {
    const res = await withMemberLock(old, async (cur) => {
      if (cur.memberOf !== aid) return "not_found" as const;
      const [taken, m, read] = await Promise.all([getLogin(to), getMember(to), readMembership(aid, oldPid)]);
      if (taken || m) return "exists" as const;
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
      const mine = sent.filter((i) => (i.invitedByPid !== undefined ? i.invitedByPid === oldPid : normalizeEmail(i.invitedBy) === old)).map((i) => i.id);
      await Promise.all([
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
      // Task 7: the (pid, aid) feed and booking links of the old person id go here too.
      await Promise.all([revokeFeed(old), revokeBook(old)]);
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
export async function removeMember(owner: User, actor: Actor, email: string): Promise<{ ok: true } | TeamFail> {
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
    await logTeam(aid, { kind: "removed", actor: who(actor), target: { pid: m.pid, email: m.email }, role: cur.ms.role, via: "web" }, { teamLocked: true });
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
 */
export async function forceRemoveMember(email: string): Promise<boolean> {
  const m = await getMember(email);
  if (!m) return false;
  const aid = aidFrom(m.memberOf);
  const pid = pidFrom(memberPid(m));
  return withTeamLock(aid, async () => {
    const [cur, account] = await Promise.all([readMembership(aid, pid), getAccount(aid)]);
    if (!cur.home) return false;
    await deleteMembership(aid, pid, { home: true, teamLocked: true });
    if (account && acct(account) === aid) {
      await logTeam(aid, { kind: "removed", actor: { pid: ownerOf(account), email: normalizeEmail(account.email) }, target: { pid, email: normalizeEmail(m.email) }, role: cur.ms?.role ?? m.role, via: "console" }, { teamLocked: true });
    }
    return true;
  });
}

/**
 * Change a member's role (owner only, rule 2125). The owner role is never assignable, removable or transferable in v1.
 * A demoted admin's pending invites go (they could never be accepted). One "role_changed" row when the role changes.
 */
export async function setRole(owner: User, actor: Actor, email: string, role: string): Promise<{ ok: true } | TeamFail> {
  if (!isTeamRole(role)) return fail("invalid_role");
  if (!can({ ...owner, actor }, "team.role")) return fail("forbidden");
  const aid = aidOf(owner);
  const m = await memberByEmail(aid, email);
  if (!m) return fail("not_found");
  const done = await withTeamLock(aid, async () => {
    const cur = await readMembership(aid, m.pid);
    if (!cur.ms) return false;
    const demoted = cur.ms.role === "admin" && role !== "admin";
    const changed = cur.ms.role !== role;
    await writeMembership(aid, m.pid, { ...cur.ms, role }, { home: cur.home, teamLocked: true });
    // An admin's invites could never be accepted once the admin is a plain member (`inviteHolds`), yet each would
    // keep holding a seat for up to seven days. They go with the role, as they go with the membership in `deleteMembership`.
    const sent = demoted ? (await listInvites(aid)).filter((i) => (i.invitedByPid !== undefined ? i.invitedByPid === m.pid : normalizeEmail(i.invitedBy) === m.email)).map((i) => i.id) : [];
    await Promise.all([
      dropInvites(aid, sent),
      changed ? logTeam(aid, { kind: "role_changed", actor: who(actor), target: { pid: m.pid, email: m.email }, role, via: "web" }, { teamLocked: true }) : null,
    ]);
    return true;
  });
  return done ? { ok: true } : fail("not_found");
}

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
 */
export async function enforceSeats(owner: User | string): Promise<{ limit: number; disabled: string[]; enabled: string[]; cancelled: string[] }> {
  const aid = typeof owner === "string" ? aidFrom(normalizeEmail(owner)) : aidOf(owner);
  return withTeamLock(aid, async () => {
    const [o, members, invites] = await Promise.all([getAccount(aid), listMembers(aid), listInvites(aid)]);
    const limit = o ? seatLimit(o) : 1;
    const slots = Math.max(0, limit - 1);
    const active = members.filter((m) => !m.disabled);
    const pause = active.slice(slots);
    const kept = active.length - pause.length;
    const cancel = invites.slice(Math.max(0, slots - kept));
    const free = Math.max(0, slots - kept - (invites.length - cancel.length));
    const resume = members.filter((m) => m.disabled).slice(0, free);
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
      dropInvites(aid, cancel.map((i) => i.id)),
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
 * Account deletion (src/lib/account.ts `wipeAccount`): every membership (`deleteMembership`: the row, the roster and
 * `orgs:` entries, the legacy member record and both active brands, the links, and the person when nothing else is
 * left), then every invite and both indexes, then `finish` (the account's own records, `user:{owner}` among them), all
 * under `lock:team`: an accept already holding it finishes first and its member is deleted here, and one that takes it
 * afterwards re-reads the owner and finds none. The members go FIRST: a member lock that cannot be had throws before any
 * invite, index or `finish` write, so the owner's account is still whole and a retry runs the wipe again. Each legacy
 * record is deleted under its own `lock:member`, so a profile or password save in flight cannot restore it. (Task 8
 * renames it `wipeMemberships` and drops the owner's `orgs:` entry.)
 */
export async function wipeTeam(owner: string, finish?: () => Promise<void>, opts: { teamLocked?: boolean } = {}) {
  const aid = aidFrom(owner);
  // The owner address move holds `lock:team` already (`withMoveTeamLock`): the lock is not reentrant.
  const locked = <T,>(fn: () => Promise<T>) => (opts.teamLocked ? fn() : withTeamLock(aid, fn));
  await locked(async () => {
    const [pids, ids] = await Promise.all([db.smembers(membersKey(aid)), db.smembers(invitesKey(aid))]);
    await pmap(pids, async (p) => {
      const pid = pidFrom(p);
      await deleteMembership(aid, pid, { home: isHome(await getMember(pid), aid, pid), teamLocked: true });
    });
    await pmap([...ids.map(inviteKey), membersKey(aid), invitesKey(aid)], (k) => db.del(k));
    if (finish) await finish();
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
  const [members, invites, approvals] = await Promise.all([listMembers(acct(u)), listInvites(acct(u)), can(u, "team.approvals.view") ? teamApprovals(u) : null]);
  return {
    you: { email: a.email, name: a.name, role: a.role },
    seats: { used: 1 + members.filter((m) => !m.disabled).length + invites.length, limit: seatLimit(u) },
    members: [
      { email: u.email, name: u.name, role: "owner" as const },
      ...members.map((m) => ({ email: m.email, name: m.name, role: m.role, acceptedAt: m.acceptedAt, ...(m.disabled ? { disabled: m.disabled } : {}) })),
    ],
    invites: can(u, "team.invites.view") ? invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, invitedBy: i.invitedBy })) : [],
    ...(approvals ? { approvals } : {}),
  };
}
