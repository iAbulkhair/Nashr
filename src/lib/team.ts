import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { pmap } from "./parallel";
import { revokeBook } from "./booking-token";
import { revokeFeed } from "./feed-token";
import { getUser, normalizeEmail, seatLimit, strongPassword, validEmail, type Actor, type User } from "./auth";
import { can } from "./roles";
import { teamApprovals } from "./approver-stats";

/**
 * Teams (seats): member logins, invites and seat accounting (docs/superpowers/specs/2026-09-29-teams-design.md).
 *
 * The ACCOUNT stays the owner's `User` at `user:{owner}`. A member is a separate login at `member:{email}`: it is never
 * written with `saveUser` / `createUser`, never enters `users:all`, never gets trial credits, a referral code or signup
 * tracking. `currentUser()` (src/lib/auth.ts) resolves a member session to the OWNER record with `actor` set.
 *
 * Keys:
 *   member:{email}     Member
 *   members:{owner}    set of member emails
 *   invite:{sha256}    Invite, TTL 7 days (the token itself is never stored)
 *   invites:{owner}    set of invite hashes
 *   lock:team:{owner}  seat count: invite, accept, cancel, role change, removal, plan change, account deletion
 *   lock:login:{email} login uniqueness across user: and member: (signup, accept)
 *   lock:member:{email} member record writes AND deletes (password, name, role, disabled, removal)
 *   inviteuse:{hash}   single use at accept
 *
 * Lock order, always outer to inner: inviteuse → lock:team → lock:login, and lock:team → lock:member. Nothing takes
 * lock:team while holding lock:member or lock:login, so no two paths can wait on each other.
 */

export type TeamRole = "admin" | "member";
export type Member = {
  email: string;
  name: string;
  lang: "ar" | "en";
  passHash: string;
  /** The owner email. */
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
export type Invite = {
  email: string;
  role: TeamRole;
  owner: string;
  invitedBy: string;
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
const LOCK_TTL_SECONDS = 10;
const TOKEN_RE = /^[a-f0-9]{64}$/;

const memberKey = (email: string) => `member:${email}`;
export const membersKey = (owner: string) => `members:${owner}`;
const inviteKey = (id: string) => `invite:${id}`;
const invitesKey = (owner: string) => `invites:${owner}`;
const fail = (error: TeamError): TeamFail => ({ ok: false, error });

export const isTeamRole = (v: unknown): v is TeamRole => v === "admin" || v === "member";
/** The invite id: SHA-256 of the token. The token travels only in the link's fragment and is never stored. */
export const inviteId = (token: string) => createHash("sha256").update(token).digest("hex");
const expired = (inv: Pick<Invite, "expiresAt">, now = Date.now()) => !(new Date(inv.expiresAt).getTime() > now);
/** A display name: control characters removed, trimmed, at most 80 characters. Null when nothing is left. */
const cleanName = (v: unknown) => {
  if (typeof v !== "string") return null;
  const n = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return n || null;
};
const byAge = <T,>(at: (x: T) => string, tie: (x: T) => string) => (a: T, b: T) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : tie(a) < tie(b) ? -1 : 1);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Run `fn` under a Redis lock, waiting up to ~3 s for it (the pattern of `withUserLock`). Always released. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, LOCK_TTL_SECONDS);
    if (!got) await sleep(50);
  }
  if (!got) throw new Error("team_lock_timeout");
  try {
    return await fn();
  } finally {
    await db.unlock(key);
  }
}
/** Login uniqueness across `user:` and `member:`. Signup and accept both create logins under this lock. */
export const withLoginLock = <T,>(email: string, fn: () => Promise<T>) => withLock(`lock:login:${normalizeEmail(email)}`, fn);
/** Read-modify-write of one member record (password, name, role, disabled). Null when the member does not exist. */
export async function withMemberLock<T>(email: string, fn: (m: Member) => Promise<T>): Promise<T | null> {
  const e = normalizeEmail(email);
  return withLock(`lock:member:${e}`, async () => {
    const m = await getMember(e);
    return m ? fn(m) : null;
  });
}

export async function getMember(email: string): Promise<Member | null> {
  return db.get<Member>(memberKey(normalizeEmail(email)));
}
/** Writes the member record only: never `users:all`, never the roster index. Callers hold `lock:member:{email}`. */
export async function saveMember(m: Member) {
  await db.set(memberKey(m.email), m);
}

/**
 * Write a new member and add it to the roster. NO checks: `acceptInvite` calls it after every check under its locks,
 * and tests use it to build a team. Never call it from a route.
 */
export async function createMember(owner: string, input: { email: string; name: string; password: string; lang: "ar" | "en"; role: TeamRole; invitedBy: string }): Promise<Member> {
  const now = new Date().toISOString();
  const m: Member = {
    email: normalizeEmail(input.email),
    name: cleanName(input.name) ?? "",
    lang: input.lang === "en" ? "en" : "ar",
    passHash: await bcrypt.hash(input.password, 10),
    memberOf: owner,
    role: input.role,
    invitedBy: input.invitedBy,
    acceptedAt: now,
    sessionsAfter: now,
  };
  await insertMember(m);
  return m;
}
async function insertMember(m: Member) {
  await Promise.all([saveMember(m), db.sadd(membersKey(m.memberOf), m.email)]);
}

/**
 * Is `email` on `owner`'s roster? `currentUser` and `getLogin` (src/lib/auth.ts) ask this as well as reading the member
 * record, so a record that outlived its roster entry (a removal racing a write, a deleted account) never signs in.
 */
export const onRoster = (owner: string, email: string) => db.sismember(membersKey(normalizeEmail(owner)), normalizeEmail(email));

/** Every member of the account, oldest first. */
export async function listMembers(owner: string): Promise<Member[]> {
  const emails = await db.smembers(membersKey(owner));
  const rows = await pmap(emails, (e) => getMember(e));
  return rows.filter((m): m is Member => !!m && m.memberOf === owner).sort(byAge((m) => m.acceptedAt, (m) => m.email));
}

/** Pending, unexpired invites of the account, oldest first. Index entries whose invite expired are dropped. */
export async function listInvites(owner: string): Promise<PendingInvite[]> {
  const ids = await db.smembers(invitesKey(owner));
  const rows = await pmap(ids, async (id) => ({ id, inv: await db.get<Invite>(inviteKey(id)) }));
  const now = Date.now();
  const live = rows.filter((r): r is { id: string; inv: Invite } => !!r.inv && r.inv.owner === owner && !expired(r.inv, now));
  const liveIds = new Set(live.map((r) => r.id));
  const stale = ids.filter((id) => !liveIds.has(id));
  if (stale.length) await pmap(stale, (id) => db.srem(invitesKey(owner), id));
  return live.map((r) => ({ ...r.inv, id: r.id })).sort(byAge((i) => i.createdAt, (i) => i.id));
}

/** Seats in use: the owner, every member not disabled, and every unexpired invite. */
export async function seatsUsed(owner: string): Promise<number> {
  const [members, invites] = await Promise.all([listMembers(owner), listInvites(owner)]);
  return 1 + members.filter((m) => !m.disabled).length + invites.length;
}

/** The actor is still what the session said: for a member, still in this team, enabled, with that role. */
async function actorStillHolds(owner: User, actor: Actor): Promise<boolean> {
  if (actor.kind !== "member") return actor.email === owner.email;
  const m = await getMember(actor.email);
  return !!m && m.memberOf === owner.email && !m.disabled && m.role === actor.role;
}

/**
 * An invite still stands for this owner: issued after the owner record was created (a re-registered address inherits no
 * invite), and sent by the owner, or by a member who is still an enabled admin of this team inviting a plain member.
 * `peekInvite` and `acceptInvite` both ask this, so the join page never previews an invite that accepting would refuse.
 */
function inviteHolds(inv: Invite, owner: User, inviter: Member | null): boolean {
  if (!(new Date(inv.createdAt).getTime() >= new Date(owner.createdAt).getTime())) return false;
  if (inv.invitedBy === owner.email) return true;
  return !!inviter && inviter.memberOf === owner.email && !inviter.disabled && inviter.role === "admin" && inv.role === "member";
}
/** Delete these invites of `owner` (record and index entry). Callers hold `lock:team:{owner}`. */
async function dropInvites(owner: string, ids: string[]) {
  await Promise.all(ids.flatMap((id) => [db.del(inviteKey(id)), db.srem(invitesKey(owner), id)]));
}

/**
 * Invite `email` into `owner`'s account as `role`. The owner may invite either role; an admin only plain members; a
 * founder impersonating never. The owner's own address, an existing login (owner or member anywhere) and a pending
 * invite in this team all get the same "unavailable", so the route cannot be used to probe who has an account.
 * The seat check runs under `lock:team:{owner}`. Returns the token ONCE: only its SHA-256 is stored.
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
  return withLock(`lock:team:${owner.email}`, async () => {
    const [u, m, members, invites, fresh] = await Promise.all([getUser(e), getMember(e), listMembers(owner.email), listInvites(owner.email), getUser(owner.email)]);
    if (u || m || invites.some((i) => i.email === e)) return fail("unavailable");
    const limit = seatLimit(fresh ?? owner);
    const used = 1 + members.filter((x) => !x.disabled).length + invites.length;
    if (used + 1 > limit) return { ok: false, error: "seats", used, limit } as SeatsError;
    const now = new Date();
    const invite: Invite = {
      email: e,
      role,
      owner: owner.email,
      invitedBy: normalizeEmail(actor.email),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_SECONDS * 1000).toISOString(),
      lang: lang === "en" ? "en" : "ar",
    };
    await Promise.all([db.set(inviteKey(id), invite, INVITE_TTL_SECONDS), db.sadd(invitesKey(owner.email), id)]);
    return { ok: true as const, token, id, invite };
  });
}

/** What the join page shows before anything is consumed. Null for an unknown, expired or orphaned invite, or one `acceptInvite` would refuse for its inviter. */
export async function peekInvite(token: string): Promise<{ team: string; inviter: string; email: string; role: TeamRole; expiresAt: string } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const inv = await db.get<Invite>(inviteKey(inviteId(token)));
  if (!inv || expired(inv)) return null;
  const { getBrand } = await import("./brand");
  const [owner, inviter, brand] = await Promise.all([getUser(inv.owner), inv.invitedBy === inv.owner ? null : getMember(inv.invitedBy), getBrand(inv.owner)]);
  if (!owner || owner.suspended || !inviteHolds(inv, owner, inviter)) return null;
  return { team: brand?.name || owner.name, inviter: inviter?.name || owner.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
}

/**
 * Accept an invite: creates the member login. Single use under `inviteuse:{hash}`. Re-reads under `lock:team:{owner}`
 * the invite (still stored AND still in the index: a cancelled one is refused, never counted as a new seat), the owner
 * (exists, not suspended, not a newer account at the same address, and its seat limit as it is now), the inviter (still
 * the owner or an enabled admin of this team, and only the owner may have invited an admin) and the seats; then, under
 * `lock:login`, that the address is still free across `user:` and `member:`. Never runs createUser, a referral code, a
 * referral bonus or signup tracking. The caller signs the new member in with `createSession(member.email)`.
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
  const use = `inviteuse:${id}`;
  if (!(await db.lock(use, 30))) return fail("invalid"); // being accepted right now
  try {
    const inv = await db.get<Invite>(inviteKey(id));
    if (!inv || expired(inv) || !isTeamRole(inv.role)) return fail("invalid");
    // Everything that decides the answer is read again under the team lock: a plan change, a cancel, a demotion or an
    // account deletion that finished while this request waited for the lock must be seen, never a copy read before it.
    return await withLock(`lock:team:${inv.owner}`, async () => {
      const [owner, inviter, live, members, invites] = await Promise.all([
        getUser(inv.owner),
        inv.invitedBy === inv.owner ? null : getMember(inv.invitedBy),
        db.get<Invite>(inviteKey(id)),
        listMembers(inv.owner),
        listInvites(inv.owner),
      ]);
      // A cancelled, seat-cancelled or already-used invite is gone from the record and the index: refused, not counted.
      if (!live || expired(live) || !invites.some((i) => i.id === id)) return fail("invalid");
      if (!owner || owner.suspended || !inviteHolds(inv, owner, inviter)) return fail("invalid");
      const limit = seatLimit(owner);
      // This invite already holds a seat (it is in the index); accepting turns it into a member, same count.
      const used = 1 + members.filter((m) => !m.disabled).length + invites.length;
      if (used > limit) return { ok: false, error: "seats", used, limit } as SeatsError;
      return withLoginLock(inv.email, async () => {
        const [u, m] = await Promise.all([getUser(inv.email), getMember(inv.email)]);
        if (u || m) return fail("unavailable");
        const now = new Date().toISOString();
        const member: Member = {
          email: normalizeEmail(inv.email),
          name,
          lang: input.lang === "en" || input.lang === "ar" ? input.lang : inv.lang,
          passHash,
          memberOf: owner.email,
          role: inv.role,
          invitedBy: inv.invitedBy,
          acceptedAt: now,
          sessionsAfter: now,
        };
        await insertMember(member);
        await dropInvites(owner.email, [id]);
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
 */
export async function discardInvite(owner: string, id: string) {
  await withLock(`lock:team:${owner}`, () => dropInvites(owner, [id]));
}

/** Cancel a pending invite of this account. An admin may cancel only invites for role "member". */
export async function cancelInvite(owner: User, actor: Actor, id: string): Promise<{ ok: true } | TeamFail> {
  const acting = { ...owner, actor };
  if (!can(acting, "team.invite.cancel")) return fail("forbidden");
  if (typeof id !== "string" || !TOKEN_RE.test(id)) return fail("not_found");
  const inv = await db.get<Invite>(inviteKey(id));
  if (!inv || inv.owner !== owner.email) return fail("not_found");
  if (inv.role === "admin" && !can(acting, "team.invite.admin")) return fail("forbidden");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  // Under the team lock, like every other seat change: an accept holding it either finishes first (and this invite is
  // gone: the person joined) or runs after and finds the invite cancelled. Never both "cancelled" and "joined".
  const done = await withLock(`lock:team:${owner.email}`, async () => {
    const cur = await db.get<Invite>(inviteKey(id));
    if (!cur || cur.owner !== owner.email) return false;
    await dropInvites(owner.email, [id]);
    return true;
  });
  return done ? { ok: true } : fail("not_found");
}

/**
 * Delete a member login and everything that is theirs: record, per-login active brand, roster entry, invites they sent.
 * Callers hold `lock:team:{owner}`; this takes `lock:member:{email}` inside it (the team-then-member order of `setRole`
 * and `enforceSeats`), re-reads the record under that lock and deletes it only while it still belongs to this owner.
 * The member-record writers (profile, account, reset) read and save under `lock:member` alone: without it here, a save
 * in flight could land after the delete and bring the login back with no roster entry, off the owner's Members page and
 * still signing in. `may` is re-checked on the record as it is under the lock.
 */
async function dropMember(owner: string, email: string, may: (m: Member) => boolean = () => true): Promise<"ok" | "not_found" | "forbidden"> {
  const res = await withMemberLock(email, async (cur) => {
    if (cur.memberOf !== owner) return "not_found" as const;
    if (!may(cur)) return "forbidden" as const;
    const sent = (await listInvites(owner)).filter((i) => i.invitedBy === cur.email).map((i) => i.id);
    await Promise.all([db.del(memberKey(cur.email)), db.del(`activebrand:${cur.email}`), db.srem(membersKey(owner), cur.email), dropInvites(owner, sent)]);
    // The login is gone, so its calendar feed and booking links go too (their records and pointers; the booking claims
    // belong to the brand scope and go with the account). After the record is deleted, so nothing can mint a new one for
    // it any more (`revokeFeed` waits out a create already running). A failed revoke is retried by nothing: the removal
    // is already done and the call answers 500. The link is refused at read time while the login is gone (`feedHolds`)
    // and, once the address is invited again, because the record is older than the new `acceptedAt` (`feedHolds`).
    await Promise.all([revokeFeed(cur.email), revokeBook(cur.email)]);
    return "ok" as const;
  });
  return res ?? "not_found";
}

/** Remove a member. The owner may remove anyone; an admin only plain members. The owner itself cannot be removed. */
export async function removeMember(owner: User, actor: Actor, email: string): Promise<{ ok: true } | TeamFail> {
  const e = normalizeEmail(typeof email === "string" ? email : "");
  const acting = { ...owner, actor };
  if (!can(acting, "team.remove.member")) return fail("forbidden");
  const m = await getMember(e);
  if (!m || m.memberOf !== owner.email) return fail("not_found");
  if (m.role === "admin" && !can(acting, "team.remove.admin")) return fail("forbidden");
  if (!(await actorStillHolds(owner, actor))) return fail("forbidden");
  const res = await withLock(`lock:team:${owner.email}`, () => dropMember(owner.email, e, (cur) => cur.role !== "admin" || can(acting, "team.remove.admin")));
  return res === "ok" ? { ok: true } : fail(res);
}

/**
 * Founder console: delete a member login whatever state it is in (an address taken through a hand-passed invite link, a
 * record whose owner is gone), under the same locks as any removal. Members never enter `users:all`, so without this
 * nothing but a hand edit of the store could free such an address. False when there is no member login at `email`.
 */
export async function forceRemoveMember(email: string): Promise<boolean> {
  const m = await getMember(email);
  if (!m) return false;
  return (await withLock(`lock:team:${m.memberOf}`, () => dropMember(m.memberOf, m.email))) === "ok";
}

/** Change a member's role (owner only). The owner role is never assignable, removable or transferable in v1. */
export async function setRole(owner: User, actor: Actor, email: string, role: string): Promise<{ ok: true } | TeamFail> {
  if (!isTeamRole(role)) return fail("invalid_role");
  if (!can({ ...owner, actor }, "team.role")) return fail("forbidden");
  const e = normalizeEmail(typeof email === "string" ? email : "");
  const m = await getMember(e);
  if (!m || m.memberOf !== owner.email) return fail("not_found");
  const done = await withLock(`lock:team:${owner.email}`, () =>
    withMemberLock(e, async (cur) => {
      if (cur.memberOf !== owner.email) return false;
      const demoted = cur.role === "admin" && role !== "admin";
      cur.role = role;
      await saveMember(cur);
      // An admin's invites could never be accepted once the admin is a plain member (`inviteHolds`), yet each would
      // keep holding a seat for up to seven days. They go with the role, as they go with the login in `dropMember`.
      if (demoted) await dropInvites(owner.email, (await listInvites(owner.email)).filter((i) => i.invitedBy === cur.email).map((i) => i.id));
      return true;
    }),
  );
  return done ? { ok: true } : fail("not_found");
}

/** A member leaves the team. The caller clears the session cookie. The owner cannot leave. */
export async function leaveTeam(u: User): Promise<{ ok: true } | TeamFail> {
  const a = u.actor;
  if (!a || a.kind !== "member" || !can(u, "team.leave")) return fail("forbidden");
  const m = await getMember(a.email);
  if (!m || m.memberOf !== u.email) return fail("not_found");
  const res = await withLock(`lock:team:${u.email}`, () => dropMember(u.email, m.email));
  return res === "ok" ? { ok: true } : fail(res);
}

/**
 * Fit the team to the seat limit (run on every plan or seat change), relative to who is active NOW. Over the limit, the
 * newest ENABLED members get `disabled: "seats"` (kept, never deleted). Under it, paused members come back oldest-first,
 * but only into seats nobody holds: pending invites keep theirs. Pending invites that no longer fit are cancelled,
 * newest first. Re-applying the same limit changes nothing: the whole team is never re-ranked, so a member the owner
 * brought in after a downgrade is not swapped for one the plan paused earlier.
 */
export async function enforceSeats(owner: User | string): Promise<{ limit: number; disabled: string[]; enabled: string[]; cancelled: string[] }> {
  const email = typeof owner === "string" ? normalizeEmail(owner) : owner.email;
  return withLock(`lock:team:${email}`, async () => {
    const [o, members, invites] = await Promise.all([getUser(email), listMembers(email), listInvites(email)]);
    const limit = o ? seatLimit(o) : 1;
    const slots = Math.max(0, limit - 1);
    const active = members.filter((m) => !m.disabled);
    const pause = active.slice(slots);
    const kept = active.length - pause.length;
    const cancel = invites.slice(Math.max(0, slots - kept));
    const free = Math.max(0, slots - kept - (invites.length - cancel.length));
    const resume = members.filter((m) => m.disabled).slice(0, free);
    const change = [...pause.map((m) => ({ m, off: true })), ...resume.map((m) => ({ m, off: false }))];
    const applied = await Promise.all([
      pmap(change, ({ m, off }) =>
        withMemberLock(m.email, async (cur) => {
          if (cur.memberOf !== email) return null;
          if (off) cur.disabled = "seats";
          else delete cur.disabled;
          await saveMember(cur);
          return { email: cur.email, off };
        }),
      ),
      dropInvites(email, cancel.map((i) => i.id)),
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
 * Account deletion (src/lib/account.ts `wipeAccount`, which deletes `user:{owner}` BEFORE calling this): every member
 * login, member active brand, invite and both indexes. Under `lock:team`, so an accept already holding it finishes first
 * and its member is deleted here, and one that takes it afterwards re-reads the owner and finds none. Each login is
 * deleted under its own `lock:member` (as in `dropMember`), so a profile or password save in flight cannot restore it.
 */
export async function wipeTeam(owner: string) {
  await withLock(`lock:team:${owner}`, async () => {
    const [emails, ids] = await Promise.all([db.smembers(membersKey(owner)), db.smembers(invitesKey(owner))]);
    await Promise.all([
      pmap(emails, (e) =>
        withMemberLock(e, async (cur) => {
          if (cur.memberOf === owner) await Promise.all([db.del(memberKey(cur.email)), db.del(`activebrand:${cur.email}`), revokeFeed(cur.email), revokeBook(cur.email)]);
        }),
      ),
      pmap([...ids.map(inviteKey), membersKey(owner), invitesKey(owner)], (k) => db.del(k)),
    ]);
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
  const [members, invites, approvals] = await Promise.all([listMembers(u.email), listInvites(u.email), can(u, "team.approvals.view") ? teamApprovals(u.email) : null]);
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
