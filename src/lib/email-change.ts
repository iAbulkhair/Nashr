import { createHash, randomInt } from "crypto";
import { db } from "./db";
import { activityKey } from "./activity";
import { getUser, normalizeEmail, validEmail, type User } from "./auth";
import { listBrands } from "./brands";
import { cardKey } from "./billing";
import { moveGoogleLink } from "./google-signin";
import { layerKey } from "./instructions-store";
import { profileKey } from "./notify-prefs";
import { SEC_KEYS } from "./secretary";
import { chatTrialKey } from "./usage";
import { mfaKey } from "./mfa";
import { mailReady, sendEmail } from "./notify";
import { sameSecret } from "./rate";
import { getMember, membersKey, moveMemberLogin } from "./team";
import { devCodeExposed, moveOwnerLogin, normalizeCode, VERIFY } from "./verify-email";

/**
 * Self-serve change of the sign-in address (rules 1942-1945, docs/system/flows.md "Changing the sign-in address").
 *
 * The acting login (owner or member, `actingLogin` in src/lib/own-password.ts) asks with its password and the new
 * address; a 6-digit code goes to the NEW address and nothing changes until it comes back. Then the login moves: a
 * member's record through `moveMemberLogin` (src/lib/team.ts), an owner's through `moveOwnerLogin`
 * (src/lib/verify-email.ts, the same core as the typo fix of rules 763-765). Every session of the login ends (fresh
 * `sessionsAfter`) and the route opens a new one for this device; the OLD address gets a notice naming the new one.
 *
 * An owner's account is keyed by its address today (`sc(u)` falls back to the email, and every brand scope starts with
 * it), so an owner whose account already holds work can not move it here without moving every key it owns. Until the
 * account id is separate from the address, only an account with nothing in it yet may move (`ownerHasData`); any other
 * answers `owner_has_data` and the page sends the owner to support.
 *
 * Stored: `emailchange:{login}` = {to, hash, at} for 15 minutes (only a hash of the code, salted with both addresses),
 * and `emailchange:tries:{login}`, counted with an atomic INCRBY before the comparison (as rule 758). The login key is
 * always the session's acting login, never an address from the request; the target address is only ever a value.
 */
export const EMAIL_CHANGE = { ttl: VERIFY.ttl, attempts: VERIFY.attempts } as const;

type Pending = { to: string; hash: string; at: number };
const pendingKey = (login: string) => `emailchange:${normalizeEmail(login)}`;
const triesKey = (login: string) => `emailchange:tries:${normalizeEmail(login)}`;
const hashOf = (login: string, to: string, code: string) => createHash("sha256").update(`nashr-emailchange:${login}:${to}:${code}`).digest("hex");

export type Acting = { kind: "owner" | "member"; email: string };
export type StartRefusal = "invalid_email" | "same_email" | "taken" | "owner_has_data" | "limit";

/**
 * Whether an owner's account already holds anything an address change here could not carry. Read in one round: the
 * account record's paid and partner fields, then the brand record, the work lists and sets, the MCP token, a saved card
 * and the trial's chat count (an account that used its trial chat may not start it again under a new address). The
 * move deletes the old address's keys (`wipeAccount`), so anything the owner made counts too: Reem's items, the agent
 * instructions, the settings, notification choices and working days, and the activity, decision, handoff and note
 * lists. A key the system writes by itself on an empty account (the daily run's `schedule:`) does not.
 */
export async function ownerHasData(u: User): Promise<boolean> {
  const e = u.email;
  if (u.plan !== "trial" || u.paidOnce || u.firstPaidOn || u.billing || u.partnerCode || u.founding || u.priceLock || u.onboardPaid || u.handPlan || (u.topups?.length ?? 0) > 0) return true;
  const lists = [`tasks:${e}`, `convs:${e}`, activityKey(e), `decisions:${e}`, `handoffs:${e}`, SEC_KEYS.notes(e)];
  const [brands, strings, counts, ...heads] = await Promise.all([
    listBrands(e),
    db.mget<unknown>([`brand:${e}`, `mcptoken-of:${e}`, cardKey(e), chatTrialKey(e), layerKey(e), `gov:${e}`, profileKey(e), SEC_KEYS.cal(e)]),
    db.scardMany([`files:${e}`, `conns:${e}`, membersKey(e), `invites:${e}`, SEC_KEYS.all(e)]),
    ...lists.map((k) => db.lrange(k, 0, 0)),
  ]);
  return brands.length > 1 || strings.some((v) => v !== null && v !== undefined) || counts.some((n) => n > 0) || heads.some((h) => h.length > 0);
}

/**
 * The move's per-login carry, run under both login locks: two-step sign-in follows the login (the enrolment record only;
 * a setup in progress does not), and so does the Google link, both ways (`moveGoogleLink`).
 */
async function carryLogin(from: string, to: string): Promise<void> {
  const enr = await db.get<unknown>(mfaKey(from));
  await Promise.all([enr ? db.set(mfaKey(to), enr) : Promise.resolve(), moveGoogleLink(from, to)]);
}

const mail = (lang: "ar" | "en") => ({
  code: (code: string) => lang === "en"
    ? { subject: `Your Thakeen code: ${code}`, text: `Your code to make this your Thakeen sign-in email: ${code}\nIt works for 15 minutes.\nIf you did not ask for it, ignore this email: nothing changes without it.` }
    : { subject: `رمز ذكين: ${code}`, text: `هذا رمزك عشان يصير هذا البريد بريد دخولك في ذكين: ${code}\nيشتغل 15 دقيقة.\nإذا ما طلبته أنت، تجاهل الرسالة: ما يتغيّر شي بدونه.` },
  notice: (to: string) => lang === "en"
    ? { subject: "Your Thakeen sign-in email changed", text: `The sign-in email of your Thakeen login was changed to ${to}, and every device was signed out.\nIf this was not you, reply to this email right away so we can lock the account.` }
    : { subject: "تغيّر بريد دخولك في ذكين", text: `تغيّر بريد الدخول لحسابك في ذكين إلى ${to}، وطلعت كل الأجهزة من الحساب.\nإذا ما كنت أنت، رد على هذي الرسالة على طول عشان نقفل الحساب.` },
});

/**
 * Check the new address and send its code. The caller has already checked the password and the rate limits, and passes
 * the acting login from the session. `sent` is false when the mail did not go out; the code is then dropped, except on a
 * test deploy, which hands it back (`devCode`, rule 766).
 */
export async function startEmailChange(u: User, me: Acting, target: unknown, lang: "ar" | "en"): Promise<{ ok: false; error: StartRefusal } | { ok: true; sent: boolean; to: string; devCode?: string }> {
  const to = normalizeEmail(typeof target === "string" ? target : "");
  if (!validEmail(to)) return { ok: false, error: "invalid_email" };
  if (to === me.email) return { ok: false, error: "same_email" };
  const [owner, member] = await Promise.all([getUser(to), getMember(to)]);
  if (owner || member) return { ok: false, error: "taken" };
  if (me.kind === "owner") {
    const today = new Date().toISOString().slice(0, 10);
    if (u.emailMoves?.day === today && u.emailMoves.n >= VERIFY.movesPerDay) return { ok: false, error: "limit" };
    if (await ownerHasData(u)) return { ok: false, error: "owner_has_data" };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await Promise.all([db.set(pendingKey(me.email), { to, hash: hashOf(me.email, to, code), at: Date.now() } satisfies Pending, EMAIL_CHANGE.ttl), db.del(triesKey(me.email))]);
  let sent = false;
  if (mailReady()) {
    const m = mail(lang).code(code);
    sent = await sendEmail(to, m.subject, m.text).catch(() => false);
  }
  if (sent) return { ok: true, sent, to };
  if (devCodeExposed()) return { ok: true, sent, to, devCode: code };
  await dropEmailChange(me.email);
  return { ok: true, sent, to };
}

export async function dropEmailChange(login: string): Promise<void> {
  await Promise.all([db.del(pendingKey(login)), db.del(triesKey(login))]);
}

/** The address waiting for its code, if any (the settings page shows it after a reload). */
export async function pendingEmailChange(login: string): Promise<string | null> {
  return (await db.get<Pending>(pendingKey(login)))?.to ?? null;
}

export type ConfirmResult =
  | { ok: true; to: string }
  | { ok: false; error: "expired" | "wrong" | "locked" | "taken" | "owner_has_data" | "limit" | "not_found"; attemptsLeft?: number };

/**
 * Check the code, then move the login. A right code is consumed before the move (one code, one move); a move refused
 * after it (the address was taken meanwhile, the account gained work) needs a fresh code. The notice to the old
 * address goes out once the move is done.
 */
export async function confirmEmailChange(u: User, me: Acting, typed: unknown, lang: "ar" | "en"): Promise<ConfirmResult> {
  const p = await db.get<Pending>(pendingKey(me.email));
  if (!p) return { ok: false, error: "expired" };
  const n = await db.incrby(triesKey(me.email), 1);
  await db.expireNx(triesKey(me.email), EMAIL_CHANGE.ttl);
  if (n > EMAIL_CHANGE.attempts) {
    await dropEmailChange(me.email);
    return { ok: false, error: "locked" };
  }
  if (!sameSecret(p.hash, hashOf(me.email, p.to, normalizeCode(typeof typed === "string" ? typed : "")))) {
    if (n >= EMAIL_CHANGE.attempts) {
      await dropEmailChange(me.email);
      return { ok: false, error: "locked" };
    }
    return { ok: false, error: "wrong", attemptsLeft: EMAIL_CHANGE.attempts - n };
  }
  // Consume the code first: `getdel` lets exactly one of two parallel right answers through.
  if (!(await db.getdel<Pending>(pendingKey(me.email)))) return { ok: false, error: "expired" };
  await db.del(triesKey(me.email));
  const to = p.to;
  if (me.kind === "member") {
    const r = await moveMemberLogin(u.email, me.email, to, carryLogin);
    if (r === "exists") return { ok: false, error: "taken" };
    if (r === "not_found") return { ok: false, error: "not_found" };
  } else {
    const r = await moveOwnerLogin(u, to, {
      may: async (cur) => !!cur.emailVerifiedAt && !(await ownerHasData(cur)),
      isCopy: (copy) => !!copy.emailVerifiedAt,
      proved: true,
      carry: carryLogin,
    });
    if (r === "exists") return { ok: false, error: "taken" };
    if (r === "limit") return { ok: false, error: "limit" };
    if (r === "not_allowed") return { ok: false, error: (await getUser(me.email)) ? "owner_has_data" : "not_found" };
  }
  if (mailReady()) {
    const m = mail(lang).notice(to);
    await sendEmail(me.email, m.subject, m.text).catch(() => false);
  }
  return { ok: true, to };
}
