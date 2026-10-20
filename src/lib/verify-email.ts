import { createHash, randomInt } from "crypto";
import { db } from "./db";
import { NextResponse } from "next/server";
import { acct, claimLogin, getLogin, normalizeEmail, saveUser, type User } from "./auth";
import { wipeAccount } from "./account";
import { withUserLock } from "./credits";
import { movePartnerRef } from "./partners";
import { moveReferral, registerCode } from "./referral";
import { allow, clientIp, retryLater, sameSecret } from "./rate";
import { isProductionDeploy } from "./deploy-env";
import { mailReady, sendEmail } from "./notify";
import { withLoginLock, withMoveTeamLock } from "./team";
import { createPersonRecord, getPerson, laterStamp, updatePerson } from "./person";
import { ownerOf } from "./membership";
import { accountKey, personKey, storedPersonId } from "./keys";

/**
 * Email verification codes (rules 757-758). A new owner proves the address with a 6-digit code mailed to it; until then
 * the account reads as signed out (rule 751).
 *
 * Only a SHA-256 hash of the code is stored (`verify:code:{email}`), which keeps the plain code out of storage and logs,
 * and the hash is salted with the address so one guess does not match two accounts. It is not secret against a Redis
 * reader: there are only 10^6 codes and the salt is the address, so anyone who can read Redis reverses it offline at
 * once. That is why the record expires with the code (900 s) and attempts are capped.
 *
 * Wrong guesses are counted in their own key (`verify:tries:{email}`) with an atomic INCRBY BEFORE the comparison, not
 * read-modify-written inside the code record: twelve parallel guesses each get a distinct count, so no more than five
 * ever reach the comparison. The fifth wrong answer deletes the code. Callers pass the session's normalized email,
 * never an address taken from the request.
 */
export const VERIFY = { ttl: 900, attempts: 5, gap: 60, perHour: 5, perDay: 10, perIpHour: 20, movesPerDay: 3 } as const;

const codeKey = (email: string) => `verify:code:${email}`;
const triesKey = (email: string) => `verify:tries:${email}`;
const hashOf = (email: string, code: string) => createHash("sha256").update(`nashr-verify:${email}:${code}`).digest("hex");

type CodeRecord = { hash: string; sentAt: number };
export type CheckResult = { ok: true } | { ok: false; reason: "expired" | "wrong" | "locked"; attemptsLeft?: number };

/** Turn what the owner typed into digits: Arabic-Indic and Persian digits become Latin, everything else is dropped. */
export function normalizeCode(typed: string): string {
  return String(typed ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, "");
}

/** A fresh code replaces any older one and resets the attempts. Returns the code for the mail; it is stored only hashed. */
export async function issueVerifyCode(email: string): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const rec: CodeRecord = { hash: hashOf(email, code), sentAt: Date.now() };
  await Promise.all([db.set(codeKey(email), rec, VERIFY.ttl), db.del(triesKey(email))]);
  return code;
}

/**
 * Compare what was typed with the stored hash. Does not consume the code: the verify route calls `markVerified` after
 * an `ok`, which is what deletes it.
 */
export async function checkVerifyCode(email: string, typed: string): Promise<CheckResult> {
  const rec = await db.get<CodeRecord>(codeKey(email));
  if (!rec) return { ok: false, reason: "expired" };
  const n = await db.incrby(triesKey(email), 1);
  await db.expireNx(triesKey(email), VERIFY.ttl);
  if (n > VERIFY.attempts) {
    await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
    return { ok: false, reason: "locked" };
  }
  if (sameSecret(rec.hash, hashOf(email, normalizeCode(typed)))) return { ok: true };
  if (n >= VERIFY.attempts) {
    await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
    return { ok: false, reason: "locked" };
  }
  return { ok: false, reason: "wrong", attemptsLeft: VERIFY.attempts - n };
}

/** Whether a code is waiting for this address (issued, not expired, not consumed or locked). */
export async function hasPendingCode(email: string): Promise<boolean> {
  return (await db.get(codeKey(email))) !== null;
}

/** Stamp the address as proved (kept if it already is, so a repeat never moves the date) and drop the code and its counter. */
export async function markVerified(email: string): Promise<void> {
  // The proof is the PERSON's (multi-workspace M1, reconciliation 11): `updatePerson` stamps `person:`, mirrors a legacy
  // owner's account and stamps every account the person owns, each only when unset. Only an owner proves an address here.
  const login = await getLogin(email);
  if (login?.kind !== "owner") throw new Error("user_not_found");
  await updatePerson(login.pid, { emailVerifiedAt: new Date().toISOString() });
  await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
}

/** The plain-text mail carrying the code, in the owner's language. */
export function verifyMail(u: Pick<User, "lang">, code: string): { subject: string; text: string } {
  return u.lang === "en"
    ? {
        subject: `Your Thakeen code: ${code}`,
        text: `Your verification code: ${code}\nIt works for 15 minutes.\nIf you did not ask for it, ignore this email.`,
      }
    : {
        subject: `رمز التحقق في ذكين: ${code}`,
        text: `رمز التحقق: ${code}\nصالح لمدة 15 دقيقة.\nإذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.`,
      };
}

/** Drop a pending code and its attempt counter (a code nobody received must not be left to guess against). */
export async function dropVerifyCode(email: string): Promise<void> {
  await Promise.all([db.del(codeKey(email)), db.del(triesKey(email))]);
}

/**
 * Rule 766: a test deploy (`APP_ENV=test`, never a production deploy) hands the code back in the response, so the e2e
 * suite can verify an account without a mailbox. Nothing else ever returns a code.
 */
export const devCodeExposed = (): boolean => process.env.APP_ENV === "test" && !isProductionDeploy();

/**
 * Issue a fresh code and mail it in the owner's language. `sent` is whether the mail went out (false when mail is off, the
 * provider refused it or the call threw). A code nobody received is dropped, except on a test deploy (`devCodeExposed`),
 * where the caller hands it back as `devCode`. The address is the session's `u.email`, never one from a request.
 */
export async function sendVerifyCode(u: Pick<User, "email" | "lang">): Promise<{ sent: boolean; code: string }> {
  const code = await issueVerifyCode(u.email);
  let sent = false;
  if (mailReady()) {
    const m = verifyMail(u, code);
    // The text part is unchanged byte for byte; the HTML part carries the same code in the shared layout (rule 1960).
    sent = await sendEmail({ to: u.email, subject: m.subject, text: m.text, template: "verifyCode", context: { code }, locale: u.lang === "en" ? "en" : "ar" }).catch(() => false);
  }
  if (!sent && !devCodeExposed()) await dropVerifyCode(u.email);
  return { sent, code };
}

const gapBucket = (email: string) => allow(`verify:gap:${email}`, 1, VERIFY.gap);
const hourBucket = (email: string) => allow(`verify:hour:${email}`, VERIFY.perHour, 3600);
// Rule 768: ten codes a day per address. Without it the hour bucket allowed 120 mails a day to one inbox and 600 guesses a
// day against an address the account does not own.
const dayBucket = (email: string) => allow(`verify:day:${email}`, VERIFY.perDay, 86400);

/**
 * Count a send that did not go through `verifySendRefusal` (signup's first code, once its mail went out) in the
 * per-address buckets, so a resend a moment later is refused honestly instead of replacing the code that was just mailed. The IP bucket is the send
 * route's own and is left alone: signup has its own per-IP limit.
 */
export async function countVerifySend(email: string): Promise<void> {
  await Promise.all([gapBucket(email), hourBucket(email), dayBucket(email)]);
}

/**
 * The refusals every code send goes through, in order (rules 759-760, 766, 768): mail is off (503, unless a test deploy
 * hands the code back), then four buckets, the refusing one names the wait: one send a minute, five an hour and ten a day
 * per address, twenty an hour per IP. `email` is the session's (or, after a move, the new) address, never one taken from a request as a source
 * account. Null when the send may go ahead.
 */
export async function verifySendRefusal(email: string, req: Request): Promise<NextResponse | null> {
  if (!devCodeExposed() && !mailReady()) return NextResponse.json({ ok: false, error: "mail_unavailable" }, { status: 503 });
  if (!(await gapBucket(email))) return retryLater({ ok: false, error: "slow_down" }, VERIFY.gap);
  if (!(await hourBucket(email))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  if (!(await dayBucket(email))) return retryLater({ ok: false, error: "slow_down" }, 86400);
  if (!(await allow(`verify:ip:${clientIp(req)}`, VERIFY.perIpHour, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  return null;
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
/** Seconds until the next UTC midnight, when the day's address moves are counted again. */
export const secondsToUtcMidnight = (now: number = Date.now()) => Math.max(1, Math.ceil((Date.parse(`${utcDay(now)}T00:00:00Z`) + 864e5 - now) / 1000));

export type MoveResult = "ok" | "exists" | "not_allowed" | "limit";

/**
 * Rules 763-765: an owner who signed up through the gate and has not proved the address may correct a mistyped one, so a
 * typo never strands the account. Only `from` itself is moved (the caller passes the session's user, never a request's
 * address as the source) and only to an address no owner or member login holds. Three moves per account per UTC day, the
 * counter carried to the new record.
 *
 * Locks, in a fixed order: the login locks of both addresses (the alphabetically smaller first, so two moves crossing
 * each other cannot deadlock; src/lib/team.ts keeps its own order), then the old account's user lock, re-reading the
 * record inside it, so two moves from one account cannot both succeed, then the account's `lock:team` (`moveOwnerLogin`,
 * so no invite or accept runs during the move). Inside: write the new record, register its
 * referral code, carry the referral and the partner attribution, and only then wipe the old account. A stop before the
 * wipe leaves two records; the retry finds the copy (same createdAt, same password hash, still gated and unverified) and
 * finishes the wipe instead of answering `exists`. Rare residue after a stop: the referrer's list and the partner's set
 * may name both addresses until that retry.
 */
export async function moveUnverifiedAccount(from: User, target: string): Promise<MoveResult> {
  const gated = (x: User) => x.gatedSignup === true && !x.emailVerifiedAt;
  return moveOwnerLogin(from, target, { may: gated, isCopy: gated });
}

/** Does the account have a member or a pending invite (`members:{id}`, `invites:{id}`)? */
async function hasTeam(id: string): Promise<boolean> {
  const counts = await db.scardMany([accountKey.members(id), accountKey.invites(id)]);
  return counts.some((n) => n > 0);
}

/**
 * The owner move both callers share: `moveUnverifiedAccount` above (a gated owner correcting a typo) and the self-serve
 * change of a proved address (rules 1942-1945, src/lib/email-change.ts, `proved: true`). `may` is re-checked on the
 * record read under the user lock; `isCopy` tells a copy an earlier stopped run already wrote at the target (same
 * createdAt and password hash) from someone else's login. `proved` stamps the new address as verified now, since its
 * code was just checked. `carry` moves what other modules keep per login (two-step sign-in) before the old account is
 * wiped.
 */
export async function moveOwnerLogin(from: User, target: string, opts: { may: (cur: User) => boolean | Promise<boolean>; isCopy: (copy: User) => boolean; proved?: boolean; carry?: (from: string, to: string) => Promise<void> }): Promise<MoveResult> {
  const old = from.email;
  // R1 (OPAQUE_IDS off): the move is still a copy to a new record at the new address, so the new account's id is `to`.
  // The move in place that keeps the id is release R2 (docs/specs/2026-10-17-account-id.md section 6).
  const id = acct(from);
  const to = normalizeEmail(target);
  if (!(await opts.may(from))) return "not_allowed";
  if (to === old) return "exists";
  const [first, second] = old < to ? [old, to] : [to, old];
  try {
    // Rule 2139: `lock:team:{id}` is taken right inside `lock:user`, before the first read that decides and before any
    // write, and held until the old account is wiped. This path takes it after `lock:user` (the out-of-order step it
    // always had through `wipeAccount` → `wipeMemberships`, now taken at the start). Under it no invite and no accept of this
    // account can run, so the one team check below is final: the wipe meets no member and never takes a member's locks
    // under `lock:user`. A `lock:team` that cannot be had throws `team_lock_timeout` with nothing written (a 409 `busy`
    // in both routes). `withMoveTeamLock` gives this holder a 60 s expiry (no renewal exists); the login and user locks
    // keep their 10 s, the bound this move always had.
    return await withLoginLock(first, () => withLoginLock(second, () => withUserLock(id, (cur) => withMoveTeamLock(id, async (): Promise<MoveResult> => {
      if (!(await opts.may(cur))) return "not_allowed";
      // An account with a team never moves (both callers refuse one before this): checked again here, under
      // `lock:team`, before the first write. A member or an invite refuses.
      if (await hasTeam(id)) return "not_allowed";
      const now = Date.now();
      const today = utcDay(now);
      const used = cur.emailMoves && cur.emailMoves.day === today ? cur.emailMoves.n : 0;
      if (used >= VERIFY.movesPerDay) return "limit";
      // The owner's credentials are the PERSON's (rule 2132). The move copies a legacy owner's account to the new address;
      // an account a `p_` person owns moves with the person (release M2), never here.
      const pid = ownerOf(cur);
      if (pid !== storedPersonId(id)) return "not_allowed";
      const [login, me] = await Promise.all([getLogin(to), getPerson(pid)]);
      if (!me) return "not_allowed";
      const unfinished = login?.kind === "owner" && opts.isCopy(login.user) && login.user.createdAt === cur.createdAt && login.person.passHash === me.passHash;
      if (login && !unfinished) return "exists";
      // A fresh session window (as `createUser` stamps): a session issued earlier for the TARGET address (a deleted former
      // owner, a removed member, this owner's own devices after A to B to A) must never resolve to the moved account. The
      // session the route opens right after has `at >= sessionsAfter` (the check is a strict `<`), so it still resolves.
      const fresh = new Date(now).toISOString();
      // The device stamp is the later of the moved person's and the record written (a stamp never moves backwards), the
      // same on both records.
      const dev = laterStamp(me.devicesAfter, (unfinished ? login.user : cur).devicesAfter);
      const devices = dev ? { devicesAfter: dev } : {};
      if (unfinished) await saveUser({ ...login.user, sessionsAfter: fresh, ...devices });
      else await saveUser({ ...cur, id: to, email: to, sessionsAfter: fresh, ...devices, emailMoves: { day: today, n: used + 1 }, ...(opts.proved ? { emailVerifiedAt: fresh } : {}) });
      // The person at the new address (multi-workspace M1, rule 2132), written whole (reconciliation 6: a leftover row at
      // `person:{to}` lends nothing): the moved owner's password, the account's birth, the fresh session stamp, and the
      // proof only when this move proved the address (or a stopped run's copy already carried one). Under both login
      // locks, without `lock:person` (`userLockHeld`: this runs inside `lock:user`, which comes after it in rule 2139's
      // order); the address is claimed only below, so nothing else can write this person.
      const copy = unfinished ? login.user : null;
      const toPid = storedPersonId(to);
      await Promise.all([
        createPersonRecord(
          { pid: toPid, email: to, name: me.name, lang: me.lang, passHash: me.passHash, createdAt: cur.createdAt, sessionsAfter: fresh, devicesAfter: dev, emailVerifiedAt: copy ? copy.emailVerifiedAt : opts.proved ? fresh : undefined },
          { loginLocked: true, userLockHeld: true },
        ),
        db.sadd(personKey.orgs(toPid), to),
      ]);
      // The new address's login index (rule 1983: under both login locks, after `getLogin(to)` found nothing or this copy).
      await claimLogin(to, to);
      if (opts.carry) await opts.carry(old, to);
      await registerCode(to);
      await moveReferral(old, to);
      if (cur.referredBy?.partner) await movePartnerRef(cur.referredBy.partner, old, to);
      await dropVerifyCode(old);
      await wipeAccount(id, { userLocked: true, loginLocked: true, teamLocked: true });
      return "ok";
    }))));
  } catch (e) {
    // The account vanished under the lock (a parallel move or a deletion won): nothing here to move.
    if (e instanceof Error && e.message === "user_not_found") return "not_allowed";
    throw e;
  }
}
