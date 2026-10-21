import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { OPAQUE_IDS } from "./account-id";
import { acct, claimLogin, getAccount, getLogin, normalizeEmail, releaseLogin, saveUser, type User } from "./auth";
import { carryBookLogin } from "./booking-token";
import { withUserLock } from "./credits";
import { revokeAllDevices } from "./devices";
import { addressBlocked, dropOwnHold, holdOldAddress, stampRevert, takeRevert } from "./email-hold";
import { carryFeedLogin } from "./feed-token";
import { dropGoogleLinkLocked, moveGoogleLink } from "./google-signin";
import { accountKey, globalKey, storedPersonId, type PersonId } from "./keys";
import { revokeAllMcp } from "./mcp";
import { heldAccounts, ownerOf } from "./membership";
import { mfaKey, mfaKeys } from "./mfa";
import { pmap } from "./parallel";
import { getPartner } from "./partners";
import { listPasskeys, removePasskey } from "./passkeys";
import { forgetPassword, getPerson, movePersonRow, withMovePersonLock, type Person } from "./person";
import { carryCalendarLogin } from "./secretary-gcal";
import { getMember, withLoginLock } from "./team";
import { dropVerifyCode, VERIFY } from "./verify-email";

/**
 * Account-id R2 (rules 2741-2744; spec docs/specs/2026-10-17-account-id.md section 6 and decision D1): a person's
 * sign-in address changes IN PLACE. Nothing is copied and nothing is wiped: the person id, every account id, every
 * scope, `users:all`, the referral and partner keys and the passkeys (keyed by the person id) stay where they are. Only
 * what is keyed by the sign-in address follows it: the login index, two-step sign-in, the Google link, the active brand
 * pointer, the legacy feed and booking pointers and the linked calendars' `login`. Runs only while `OPAQUE_IDS` is on;
 * with it off the callers keep R1's copy (`moveOwnerLogin`, `moveMemberLogin`).
 *
 * Who moves this way: an owner (legacy, whose id stays the old address, or opaque) and a `p_` person. A person whose
 * login is a LEGACY member record (`member:{login}`, keyed by the address) keeps R1's copy (spec: "Members unchanged").
 * A partner's address is refused (`partner`): the partner programme is keyed by the address, and support moves it.
 *
 * Locks (rule 2139): both `lock:login` (the alphabetically smaller first), then `lock:person:{pid}` (60 s, as the R1
 * move), then each owned account's `lock:user` in turn while its record is written. Write order, so a stop anywhere
 * leaves a state a retry finishes: the new login index first (a retry finds it naming this person and goes on), then
 * every owned account (`email`, a fresh `sessionsAfter`, the day's count, the proof), then the person row with the same
 * stamp (the stale guard reads the account first, so both must agree), the per-login carry, the target's leftovers
 * dropped, the hold and revert token, and last the old address's state and its index. A stop before the last step can
 * leave `login:{old}` naming the person; the person's address is already the new one, so it signs nothing in
 * (`getLogin` checks the person's address) and the retry drops it.
 */
export type InPlaceResult = { result: "ok"; revert?: string } | { result: "exists" | "not_allowed" | "limit" | "partner" };

export type InPlaceOpts = {
  /** Re-checked under the locks on the person and the accounts it owns. */
  may: (p: Person, owned: User[]) => boolean | Promise<boolean>;
  /** The new address was proved by a code (stamps `emailVerifiedAt` now). */
  proved: boolean;
  /** Three moves per person per UTC day (`VERIFY.movesPerDay`); the revert is not counted against it. */
  limited: boolean;
  /** Write the D1 hold on the old address and a revert token (a proved move only). */
  hold: boolean;
  /** Runs last under both login locks and the person lock (the revert's security steps). */
  extra?: (p: Person, owned: User[]) => Promise<void>;
};

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const movesToday = (v: unknown, today: string): number => {
  const m = v as { day?: unknown; n?: unknown } | undefined;
  return m && m.day === today && typeof m.n === "number" ? m.n : 0;
};

/** The accounts this person OWNS (the forward records agree), read in one `pmap` round. */
async function ownedBy(p: Person): Promise<User[]> {
  const held = (await heldAccounts(p)).filter((h) => h.role === "owner");
  const rows = await pmap(held, (h) => getAccount(h.aid));
  return rows.filter((x): x is User => !!x && ownerOf(x) === p.pid);
}

/** What other modules keep per sign-in address, moved from `old` to `to` (both login locks held). */
async function carry(owned: User[], old: string, to: string): Promise<void> {
  const [enr, brand] = await Promise.all([db.get<unknown>(mfaKey(old)), db.get<unknown>(accountKey.activeBrand(old))]);
  // A leftover enrolment, setup or Google link at the target belongs to a previous holder of the address: replaced.
  await Promise.all([
    enr ? db.set(mfaKey(to), enr) : db.del(mfaKey(to)),
    db.del(mfaKeys(to)[1]),
    brand ? db.set(accountKey.activeBrand(to), brand) : db.del(accountKey.activeBrand(to)),
    dropGoogleLinkLocked(to),
  ]);
  await Promise.all([moveGoogleLink(old, to), carryFeedLogin(old, to), carryBookLogin(old, to), pmap(owned, (x) => carryCalendarLogin(acct(x), old, to))]);
}

/** Per-address state nobody may inherit: sessions, codes, a pending address change. */
async function dropLoginState(login: string): Promise<void> {
  await Promise.all([revokeAllDevices(login), dropVerifyCode(login), db.del(accountKey.emailChange(login)), db.del(accountKey.emailChangeTries(login))]);
}

/**
 * Move person `pid` from its sign-in address `from` to `target`, in place. `from` is always the session's acting login
 * (or the revert record's current address), never an address taken from a request.
 */
export async function movePersonLogin(pid: PersonId, from: string, target: string, opts: InPlaceOpts): Promise<InPlaceResult> {
  if (!OPAQUE_IDS) return { result: "not_allowed" };
  const old = normalizeEmail(from);
  const to = normalizeEmail(target);
  if (to === old) return { result: "exists" };
  const [first, second] = old < to ? [old, to] : [to, old];
  return withLoginLock(first, () => withLoginLock(second, () => withMovePersonLock(pid, async (): Promise<InPlaceResult> => {
    const [login, taken, member, blocked, partner] = await Promise.all([getLogin(old), getLogin(to), getMember(to), addressBlocked(to, pid), getPartner(old)]);
    if (!login || login.pid !== pid) return { result: "not_allowed" };
    if (login.kind === "member" && login.member) return { result: "not_allowed" };
    // The target is someone else's login (a stopped run of this very move indexed it to this person: that is a retry).
    if ((taken && taken.pid !== pid) || member || blocked) return { result: "exists" };
    if (partner) return { result: "partner" };
    const person = login.person;
    const owned = await ownedBy(person);
    if (!(await opts.may(person, owned))) return { result: "not_allowed" };
    const now = Date.now();
    const today = utcDay(now);
    const used = Math.max(movesToday((person as { emailMoves?: unknown }).emailMoves, today), ...owned.map((x) => movesToday(x.emailMoves, today)));
    if (opts.limited && used >= VERIFY.movesPerDay) return { result: "limit" };
    const fresh = new Date(now).toISOString();
    const emailMoves = { day: today, n: used + 1 };
    const proof = opts.proved ? { emailVerifiedAt: fresh } : {};

    await claimLogin(to, pid);
    // Each owned account under its own user lock. The id is written explicitly: a legacy record saved before R1 has
    // none, and `acct` would otherwise follow the new address to a new key.
    await pmap(owned, async (x) => {
      try {
        await withUserLock(acct(x), async (cur) => {
          if (ownerOf(cur) !== pid) return;
          await saveUser({ ...cur, id: acct(cur), email: to, sessionsAfter: fresh, emailMoves, ...proof });
        });
      } catch (e) {
        if (!(e instanceof Error && e.message === "user_not_found")) throw e;
      }
    });
    const moved = await movePersonRow(pid, to, { sessionsAfter: fresh, emailMoves, ...(opts.proved ? { emailVerifiedAt: fresh } : {}) });
    if (!moved) return { result: "not_allowed" };
    await carry(owned, old, to);
    await Promise.all([dropLoginState(to), dropOwnHold(to, pid)]);
    const revert = opts.hold ? await holdOldAddress(pid, old, to, fresh) : undefined;
    if (opts.extra) await opts.extra(moved, owned);
    await Promise.all([dropLoginState(old), ...mfaKeys(old).map((k) => db.del(k)), db.del(accountKey.activeBrand(old))]);
    await releaseLogin(old, pid, { locked: true });
    return revert ? { result: "ok", revert } : { result: "ok" };
  })));
}

/** The one-hour reset link `POST /api/auth/reset` reads (the record `/api/auth/forgot` writes), for `email`. */
async function resetTokenFor(email: string, kind: "owner" | "member"): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.set(globalKey.passwordReset(createHash("sha256").update(token).digest("hex")), { email, kind }, 3600);
  return token;
}

export type RevertResult = { ok: true; email: string; reset: string } | { ok: false; error: "bad_token" | "unavailable" };

/**
 * D1 (rule 2744): the link mailed to the OLD address undoes the move. Single use (`takeRevert`). The person moves back
 * in place (not counted against the day's limit, no new hold), and then, under both login locks and the person lock:
 * every session ends (a fresh stamp) and the password becomes random bytes nobody knows, two-step enrolled after the
 * move goes, the Google link goes, passkeys added after the move go, and every MCP token of the accounts the person owns
 * dies. The answer hands a one-hour reset token for the old address, so the person sets a new password at once (the
 * reset itself ends the feed, booking and calendar links as any reset does). `emailreverted:{pid}` makes a token of a
 * move made after this one and before now dead (a hijacker's own move cannot be reverted back to them).
 */
export async function revertEmailMove(token: unknown): Promise<RevertResult> {
  const rec = await takeRevert(token);
  if (!rec) return { ok: false, error: "bad_token" };
  const pid = storedPersonId(rec.pid);
  const person = await getPerson(pid);
  if (!person) return { ok: false, error: "bad_token" };
  const old = normalizeEmail(rec.old);
  const since = Date.parse(rec.at);
  const secure = async (p: Person, owned: User[]) => {
    const enr = await db.get<{ at?: unknown }>(mfaKey(old));
    const addedAfter = !!enr && typeof enr.at === "string" && Date.parse(enr.at) > since;
    const keys = await listPasskeys(pid, p.createdAt);
    const now = new Date().toISOString();
    await Promise.all([
      addedAfter ? Promise.all(mfaKeys(old).map((k) => db.del(k))) : Promise.resolve(),
      dropGoogleLinkLocked(old),
      forgetPassword(pid, now, { personLocked: true }),
      pmap(owned, (x) => revokeAllMcp(acct(x))),
      revokeAllDevices(old),
    ]);
    // One at a time: each removal rewrites the same passkey set under the person lock (a short list, capped per person).
    for (const k of keys.filter((k) => Date.parse(k.createdAt) > since)) await removePasskey(pid, p.createdAt, k.ref, { personLocked: true });
  };
  let done: InPlaceResult;
  if (person.email !== old) {
    done = await movePersonLogin(pid, person.email, old, { may: () => true, proved: true, limited: false, hold: false, extra: secure });
  } else {
    done = await withLoginLock(old, () => withMovePersonLock(pid, async () => {
      const p = await getPerson(pid);
      if (!p) return { result: "not_allowed" } as const;
      await secure(p, await ownedBy(p));
      return { result: "ok" } as const;
    }));
  }
  if (done.result !== "ok") return { ok: false, error: "unavailable" };
  await Promise.all([stampRevert(pid, rec.at, new Date().toISOString()), dropOwnHold(old, pid)]);
  const login = await getLogin(old);
  if (!login) return { ok: false, error: "unavailable" };
  return { ok: true, email: old, reset: await resetTokenFor(old, login.kind) };
}
