import { adjust } from "./credits";
import { createHash } from "crypto";
import { db } from "./db";
import { getUser } from "./auth";
import { ksaDay } from "./partner-rules";

/** Credits each side of a referral gets: the new account at signup, the referrer at the friend's first payment. */
export const REFERRAL_CREDITS = 50;
/** At most this many referrer bonuses are paid to one referrer per calendar month (Riyadh time, rules 557-558). */
export const REFERRAL_MONTHLY_CAP = 10;
/** One-time credits for sharing Thakeen on a social platform, once per platform per account (/api/referral/share). */
export const SHARE_CREDITS = 20;
/** How long a month's counter lives: past the end of its month, then it goes on its own. */
const MONTH_COUNTER_TTL = 62 * 86400;

/**
 * Keys (all built from the referrer's own normalized email, never from request text):
 * - `ref:{CODE}` → the referrer's email. `referredBy:{email}` → who referred this account (written once, at signup).
 * - `referrals:{referrer}` the sign-ups the referrer brought in (shown on their page).
 * - `referral:pending:{referrer}` hash: field = a hash of the referred address (no address stored), value = its state:
 *   `pending` from signup, then `paid` or `capped` once its first payment is recorded.
 * - `referral:paid:{referrer}` set of referred hashes whose bonus was decided: SADD is the one atomic claim, so a bonus is
 *   decided once per referred account, however many payments are recorded or voided, and in whatever order.
 * - `referral:month:{referrer}:{YYYY-MM}` the bonuses paid that Riyadh month (INCRBY, so two at once cannot both be the 10th).
 */
const pendingKey = (ref: string) => `referral:pending:${ref}`;
const paidKey = (ref: string) => `referral:paid:${ref}`;
const monthKeyOf = (ref: string, month: string) => `referral:month:${ref}:${month}`;
const who = (email: string) => createHash("sha256").update("nashr-referred:" + email).digest("hex").slice(0, 32);
/** The month a bonus counts in: the calendar month in Riyadh. */
const riyadhMonth = (now: number) => ksaDay(now).slice(0, 7);

/** The referrer-side keys of an account, for account deletion (src/lib/account.ts `wipeAccount`). */
export const referralKeys = (email: string, now: number = Date.now()) => [pendingKey(email), paidKey(email), monthKeyOf(email, riyadhMonth(now))];

/** `at`: the signup (on the pending record); `decidedAt`: when the first payment decided the bonus. */
export type PendingReferral = { at?: string; status: "pending" | "paid" | "capped"; decidedAt?: string };

export function codeFor(email: string) {
  return createHash("sha256").update("nashr-ref:" + email).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
}
export async function registerCode(email: string) {
  const code = codeFor(email);
  await db.set(`ref:${code}`, email);
  return code;
}
export async function ownerOf(code: string) {
  return db.get<string>(`ref:${code.toUpperCase()}`);
}
/**
 * Called once on signup (rule 556). The new account gets its bonus now; the referrer's is only recorded as pending and
 * paid by `rewardReferrer` when this account's first payment is recorded, so throwaway sign-ups earn the referrer nothing.
 */
export async function applyReferral(newEmail: string, code: string) {
  const refEmail = await ownerOf(code);
  if (!refEmail || refEmail === newEmail) return false;
  const [ref, nu] = await Promise.all([getUser(refEmail), getUser(newEmail)]);
  if (!ref || !nu) return false;
  const at = new Date().toISOString();
  await adjust(newEmail, REFERRAL_CREDITS);
  await Promise.all([
    db.lpush(`referrals:${refEmail}`, JSON.stringify({ email: newEmail, at })),
    db.set(`referredBy:${newEmail}`, refEmail),
    db.hset(pendingKey(refEmail), who(newEmail), { at, status: "pending" } satisfies PendingReferral),
  ]);
  return true;
}

export type ReferrerReward = "paid" | "capped" | "already" | "none";
/**
 * The referred account's first payment was recorded (src/lib/partners.ts `recordPayment`, rules 557-558): pay its
 * referrer REFERRAL_CREDITS once. The claim (SADD) comes first, so a second or concurrent payment, a retried request, or a
 * payment recorded after the first was voided finds it taken and pays nothing. Then the referrer's month counter: past
 * REFERRAL_MONTHLY_CAP the bonus is decided as `capped` and never paid. The credits go through the ledger (`adjust`).
 */
export async function rewardReferrer(payerEmail: string, now: number = Date.now()): Promise<ReferrerReward> {
  const refEmail = await db.get<string>(`referredBy:${payerEmail}`);
  if (!refEmail || refEmail === payerEmail || !(await getUser(refEmail))) return "none";
  const id = who(payerEmail);
  if ((await db.sadd(paidKey(refEmail), id)) !== 1) return "already";
  const month = monthKeyOf(refEmail, riyadhMonth(now));
  const n = await db.incrby(month, 1);
  await db.expireNx(month, MONTH_COUNTER_TTL);
  const base = { decidedAt: new Date(now).toISOString() };
  if (n > REFERRAL_MONTHLY_CAP) {
    await db.hset(pendingKey(refEmail), id, { ...base, status: "capped" } satisfies PendingReferral);
    return "capped";
  }
  await adjust(refEmail, REFERRAL_CREDITS);
  await db.hset(pendingKey(refEmail), id, { ...base, status: "paid" } satisfies PendingReferral);
  return "paid";
}

export async function referralStats(email: string) {
  const [rows, states] = await Promise.all([db.lrange(`referrals:${email}`, 0, 99), db.hgetall<PendingReferral>(pendingKey(email))]);
  const all = Object.values(states);
  const paid = all.filter((s) => s.status === "paid").length;
  const pending = all.filter((s) => s.status === "pending").length;
  // Referrals from before rule 556 were paid at signup and have no pending record.
  const legacy = Math.max(0, rows.length - all.length);
  return {
    code: codeFor(email), count: rows.length, pending, earned: (paid + legacy) * REFERRAL_CREDITS,
    rows: rows.map((r) => JSON.parse(r) as { email: string; at: string }),
  };
}
