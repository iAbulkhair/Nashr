import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { BRAND_HEADER, isBrandId } from "./brand-path";
import type { BrandMeta } from "./brands";
import { isPersonSuspended, isSuspended, type StoredSuspension } from "./suspension";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { log } from "./log";
import { idleInTime, renewIdle, type IdleLimits } from "./idle-session";
import type { AgentId } from "./agents";
import type { Member } from "./team";
import { PLAN_CREDITS, planFromStore, type AgencyDeal, type Plan } from "./pricing";
import { settleTopups, type Receipt, type TopupLot } from "./topups";
import { billingLocked, type Billing } from "./billing-state";
import { signupConsent, type Consent } from "./consent";
import { handPlanEnded, type HandPlan } from "./hand-plan";
import { ksaDay } from "./partner-rules";
import type { FoundingSeat, PriceLock } from "./founding";
import { SESSION_COOKIE, dropCookie, dropLegacyCookie, namesOf, readCookie } from "./cookie-names";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, storedScope, type AccountId, type PersonId, type Scope } from "./keys";
import type { Person } from "./person";
import { acct, idForNewAccount, LoginIndex, loginIndexOf, OPAQUE_IDS, type LoginIndexValue } from "./account-id";
import { parseStored } from "./stored";
import { MULTI_ORG } from "./multi-org";
import { WS_HEADER, asHandle } from "./ws-path";
import { handleOf, matchHandle, wsHandle } from "./ws-handle";

export { acct, accountOfScope } from "./account-id";

// The plan table lives in src/lib/pricing.ts (import-free, so client components can read it). Re-exported here so the
// existing `@/lib/auth` imports keep working.
export { PLANS, PLAN_CREDITS, PLAN_SEATS, brandCapFor, isPlan, seatLimit } from "./pricing";
export type { AgencyDeal, Plan } from "./pricing";

/** Who may do what inside an account (src/lib/roles.ts). The owner role belongs to the `user:` record only. */
export type Role = "owner" | "admin" | "member";
/**
 * Who is acting on this request. Runtime only: set by `currentUser` / `userFromBearer`, stripped by `saveUser`, never
 * read from a request body. A `User` with no actor is denied by every role check (fail closed).
 */
export type Actor = {
  /** founder = a founder impersonating this account (the session carries `imp`). */
  kind: "owner" | "member" | "token" | "founder";
  /**
   * The person acting (multi-workspace membership, rule 2115): the session's person for owner, member and founder (the
   * owner's person behind an impersonation), the account's owner (`ownerOf`) for a token. Every resolver sets it.
   */
  pid: PersonId;
  /**
   * The active account is this person's HOME account (a legacy owner's own account, a legacy member's `memberOf`): the
   * legacy per-login keys (`activebrand:{login}`, the feed and booking pointers) belong to it and are read and written
   * beside the per-(person, account) keys. False for any other account and for a `p_` person (rule 2119).
   */
  home: boolean;
  /** The login that is acting: the member's own email for members, the owner email for owner, token and founder. */
  email: string;
  name: string;
  lang: "ar" | "en";
  role: Role;
  /** The founder email (or "key" for the console key) behind an impersonation session. Only for kind "founder". */
  impersonating?: string;
  /**
   * Kind "founder" only (rule 1177): when the impersonation began and when it ends, epoch ms, for the console banner's
   * countdown. `until` is the session's own `exp`, or `at` + 2 hours for a session written before 2026-10-11.
   */
  since?: number;
  until?: number;
};

/**
 * A founder override of what a plan includes, with an end date (`User.grants`, src/lib/entitlements.ts, rule 780).
 * `until` is a YYYY-MM-DD UTC day and the grant holds through the end of that day; `by` is the founder who set it and
 * `at` when (ISO); a grant without both is not honoured (`grantActive`). `note` is the founder's own reason.
 */
export type Grant<T> = { value: T; until: string; by: string; at: string; note?: string };

/**
 * A held onboarding charge (`User.onboardPaid`): the charge's scope, agent and month (what a refund needs to lower the
 * agent's counter), the credits it took, and when a run last charged or reused it (the daily sweep refunds a hold nobody
 * used for a day, src/lib/credits.ts `resolveOnboardHolds`).
 */
export type OnboardHold = { scope: string; agent: AgentId; month: string; credits: number; at: string; from?: Receipt };

export type User = {
  /**
   * The account's storage key (docs/specs/2026-10-17-account-id.md, rules 1980-1999). Never changes for the life of the
   * account. Optional (R1 expand): a record written before R1 has none and its id is its `email` (`acct`). R1 writes
   * `id = email` on every save; the key a record is read from always wins over a stored `id` (`getAccount`). Never sent
   * to the browser (`GET /api/profile` names its fields, rule 1995).
   */
  id?: string;
  /**
   * The person who owns this account (multi-workspace membership, docs/specs/2026-10-18-multi-org.md, rules 2110-2139).
   * Absent on every account in production during M1 (a legacy owner's person id is `acct(u)`); a test fixture may set a
   * `p_...` id. Read only through `ownerOf`, which falls back to `acct(u)`; never compared or keyed directly.
   */
  ownerPid?: string;
  /**
   * The name a person gave a workspace they created (multi-workspace M2, `POST /api/workspaces`). Shown by the switcher
   * when the account has no brand name yet. Optional and new (expand): older code ignores it.
   */
  workspaceName?: string;
  /**
   * When the account last changed owner (ISO, multi-workspace M3 ownership transfer, rule 2757). A saved card
   * whose checkout started before it belongs to the previous owner and is refused (`intentOutdatesOwner`, src/lib/billing-state).
   * Optional and new (expand): older builds ignore it, and an account that never changed hands has none.
   */
  ownerSince?: string;
  /** The sign-in and contact address: mail goes here, display uses it. Never a key: keys go through `acct(u)`. */
  email: string;
  name: string;
  phone: string;
  /**
   * The owner's password hash, a MIRROR of the person's (multi-workspace M1, rule 2132): written only by `createUser`
   * and `updatePerson`, read by nobody in this build (the person is read: `login.person`, `getPerson`). Kept so a build
   * rolled back to R1 still signs the owner in. Absent on an account a `p_` person owns: its password is on the person.
   */
  passHash?: string;
  plan: Plan;
  credits: number;
  trialEnds: string; // ISO
  createdAt: string; // ISO
  lang: "ar" | "en";
  /** YYYY-MM of the last monthly credit renewal (paid plans). Still written beside `renewedOn` (rule 2936, expand). */
  renewedAt?: string;
  /** Riyadh day (YYYY-MM-DD) of the last monthly credit renewal or plan start (rule 2936, src/lib/renewal.ts). */
  renewedOn?: string;
  /** Day of the month (1-31) a plan set by hand renews on: the day it was set (rule 2936). A Paymob subscription uses `billing.anchor`. */
  renewAnchor?: number;
  /**
   * Set by staff: login and all API access blocked. `true` has no end date; `{ until }` (rule 2070, expand) ends at that
   * moment. Read only through `isSuspended` in src/lib/suspension.ts (rule 2071).
   */
  suspended?: StoredSuspension;
  /** ISO time of the last password change: every session issued before it is dead (src/lib/auth.ts `currentUser`). */
  sessionsAfter?: string;
  /**
   * ISO time of the owner's last "sign out other devices" (rule 1170): browser sessions issued before it are dead, and
   * nothing else is. Unlike `sessionsAfter` it never ends the calendar feed or booking links (`loginHolds` does not read
   * it), MCP tokens or connected apps. Optional, added 2026-10-11 (expand): a record without it signs nothing out.
   */
  devicesAfter?: string;
  /**
   * Credits charged this UTC calendar month per brand scope and agent (`charge` in src/lib/credits.ts, under the same
   * lock and in the same save as the balance). A record whose `month` is not the current one counts as empty.
   */
  agentSpend?: { month: string; by: Record<string, Partial<Record<AgentId, number>>> };
  /**
   * Founder-console override of the plan's seat count (`PLAN_SEATS` in src/lib/pricing.ts). An Agency deal's seats live
   * here too: one seat source for every plan (`seatLimit`).
   */
  seats?: number;
  /**
   * Founder-console override of the plan's active-brand count (`PLAN_BRANDS` in src/lib/pricing.ts, `brandCapFor`), a
   * whole number from 1 to 200. Written only by POST /api/admin/brand-cap under `withUserLock`. Optional and new
   * (rule 679 expand, rule 1393): older code ignores it, and a record without it reads as the plan's number.
   */
  brandCap?: number;
  /**
   * The Agency contract: monthly credits and price (src/lib/pricing.ts `allowanceOf`, `priceOf`). Written only by the
   * founder console (POST /api/admin/plan, under `withUserLock`), never taken from any other request, and cleared when
   * the account leaves Agency. A deal below the Business rate is ignored. Its seats are in `seats`.
   */
  deal?: AgencyDeal;
  /**
   * Founder overrides of what the plan includes, each with an end date (`Grant`): today only `video: "all"`, which opens
   * every video model to a trial. Written only by the founder console (POST /api/admin/plan, under `withUserLock`) and
   * read only by `entitlements()` (src/lib/entitlements.ts, rule 780). An expired grant is ignored there, never deleted:
   * the console shows it as expired. Optional, so older code ignores it (expand only, rule 679).
   */
  grants?: { video?: Grant<"all"> };
  /**
   * Partner programme (src/lib/partners.ts, rules 390-402), all written under `withUserLock`. `referredBy`: the partner
   * this account was attributed to, first touch (a link's cookie or a typed code), never rewritten; `at` is the link's click
   * time or the signup, `ref` a random id that is the only source of the label the partner sees. `firstMonthOffer`: the
   * account's one 15% first-month discount, from that partner or the trial's last day; `usedAt` once a recorded payment
   * took it. `firstPaidOn`: the day of the first recorded plan payment that still stands (a top-up pack's payment never sets it). `partnerCode`: this account is a
   * partner (display only: the record is `partner:{email}`).
   */
  referredBy?: { partner: string; code: string; at: string; via: "link" | "code"; ref?: string };
  firstMonthOffer?: { kind: "partner" | "early"; pct: number; at: string; usedAt?: string; paymentId?: string };
  firstPaidOn?: string;
  partnerCode?: string;
  /**
   * An added brand's onboarding charge, held per brand scope until that brand is built (src/lib/credits.ts
   * `chargeOnboard`). Written in the same locked save as the debit, dropped in the same save as its refund (or once the
   * brand is saved), so a run can reuse a charge, refund it, or be swept, but never both reuse and refund one. Rule 246.
   */
  onboardPaid?: Record<string, OnboardHold>;
  /**
   * Charges that may be taken at most once per claim (src/lib/credits.ts `chargeOnce`): the Sunday plan's
   * `weekly:{scope}:{week}`. Written in the same locked save as the debit and dropped in the same save as its refund, so a
   * run killed after its charge leaves the hold for the retry to reuse, and a retry never pays twice. A hold whose `at`
   * is older than PAID_ONCE_MS is dropped by the next `chargeOnce`. Rule 333.
   */
  paidOnce?: Record<string, OnboardHold>;
  /**
   * Founder-console override of the plan's chat messages (`CHAT_ALLOWANCE` in src/lib/pricing.ts, `chatAllowanceOf`). An
   * Agency deal's chat allowance lives here, as its seats live in `seats`. 0 stops chat for the account.
   */
  chatAllowance?: number;
  /**
   * The owner's choice for when the month's chat messages run out: `true` continues on credits (each message charged at
   * its metered cost at the floor rate, src/lib/chat-allowance.ts); absent or false pauses chat until the next month.
   * Written only by POST /api/billing/chat-overflow, owner only. Never on a trial.
   */
  chatOverflow?: boolean;
  /**
   * The owner's one confirmation that a China-hosted model may be picked and run for this account (spec
   * 2026-10-08-straitly-model-routing, section 7): only `true` confirms (`chinaConfirmed`, src/lib/models/overrides.ts).
   * Written only by PUT /api/models `{ confirmChina: true }`, owner only, never while a founder impersonates, under the
   * user lock. Absent on every account before 2026-10-08: not confirmed.
   */
  chinaHostingOk?: boolean;
  /**
   * Metered cost of over-allowance messages not yet billed, in micro-USD: always less than one credit at the floor rate
   * (`settleChatOverflow` in src/lib/credits.ts), carried to the next one so the owner pays the real cost, not a rounded one.
   */
  chatCarryMicro?: number;
  /**
   * Top-up packs (src/lib/topups.ts, rules 440-459): each pack's credits, what is left of it and when it expires. Added
   * and voided only by the founder console (POST /api/admin/topups), spent and refunded only by the ledger
   * (src/lib/credits.ts), all under `withUserLock`. `credits` above is the whole balance, packs included.
   */
  topups?: TopupLot[];
  /**
   * The online subscription (Paymob KSA, src/lib/billing.ts, rules 700-729): the paid-through day, the renewal state and
   * the saved card's brand and last four digits (the card token itself lives in `paymob:card:{email}`, never here).
   * Written only by src/lib/billing.ts under `withUserLock`. Absent for accounts activated by hand.
   */
  billing?: Billing;
  /**
   * A plan set by hand and the Riyadh day it is paid through (src/lib/hand-plan.ts, rules 1302-1305): the monthly refill
   * stops after that day. Written only by POST /api/admin/plan under `withUserLock`; removed by a Paymob plan payment, a
   * Paymob refund that ends the plan, and a change to the trial. Absent on plans set before 2026-10-12 (no end).
   */
  handPlan?: HandPlan;
  /**
   * A founding seat (src/lib/founding.ts, rules 1700-1719): claimed by the Paymob callback for a first plan payment that
   * asked for the founding offer, or granted by the founder console. Kept with `endedAt` once ended, so it is never
   * claimed again automatically. Optional, added 2026-10-13 (expand, rule 679): older code ignores it and keeps it.
   */
  founding?: FoundingSeat;
  /**
   * The price lock (src/lib/founding.ts): the plan's ex-VAT price at the first payment and the first Riyadh day it no
   * longer applies. The Paymob renewal charges it while it applies (never above the list price). Optional, expand step.
   */
  priceLock?: PriceLock;
  /**
   * The founder lifted the fair-use pause for one UTC month (src/lib/fair-use.ts, rules 1720-1739). A lift for another
   * month is ignored, so the pause can come back next month by itself. Written only by POST /api/admin/fair-use under
   * `withUserLock`. Absent on every account until a founder lifts one (expand only: older code ignores it).
   */
  fairUseLift?: { month: string; at: string; by: string };
  /** Runtime only: `getUser` settled the stored packs (one expired); the next locked save writes them. Never persisted. */
  topupsDirty?: boolean;
  /** ISO time: every MEMBER session issued before it is dead (founder reset, owner reset). The owner's own sessions follow `sessionsAfter`. */
  teamSessionsAfter?: string;
  /**
   * ISO time the owner proved the address with an emailed code (rules 751-766). Written only by the verify routes. An owner
   * without a stamp reads as signed out everywhere (`currentUser`): older accounts are not grandfathered, they verify on
   * their next visit.
   */
  emailVerifiedAt?: string;
  /** Set once by `createUser`: this account was created under the gate, so its address was never trusted. Only these accounts may change the address on the verify page. Never cleared. */
  gatedSignup?: true;
  /** Change-email budget carried across address moves (3 per account per UTC day): the day (YYYY-MM-DD) and moves made on it. */
  emailMoves?: { day: string; n: number };
  /**
   * The terms and privacy versions the owner agreed to at signup, and when (src/lib/consent.ts, rule 1325). Optional,
   * added 2026-10-12 (expand, rule 679): older accounts have none and read through `consentOf` as not recorded.
   */
  consent?: Consent;
  /** Runtime only: storage scope of the active brand (email for the default brand). Never persisted. Read it through `sc(u)`. */
  scope?: string;
  brandId?: string;
  /** Runtime only: who is acting (owner, a member of this account, an MCP token, a founder impersonating). Never persisted. */
  actor?: Actor;
};
/**
 * The caller's workspace scope (rule 2031): how a request reaches a `wsKey` builder in src/lib/keys.ts. `u.scope` is set
 * only by `currentUser` (`scopeFor` over the account's own brand list) and the founder's impersonation, never from input.
 */
export const sc = (u: User): Scope => storedScope(u.scope ?? acct(u));

const SESSION_TTL = 60 * 60 * 24 * 30;
// `thakeen_session`, read with the old `nashr_session` as a fallback during the rename (rule 1810, src/lib/cookie-names.ts).
const COOKIE = SESSION_COOKIE;

/** Whole days left in a trial (0 when it has ended). Server-side: the clock is read per request here, never inside a component. */
/**
 * An ended trial may not spend. Written once because it was written five times: the image route and the chat's
 * generate_image tool were the two spending paths that never got a copy, so an expired trial went on paying for
 * fal.ai and Anthropic calls indefinitely. A Paymob subscription locked after its failed renewal's grace (rule 712)
 * stops the same way, through every gate that already reads this. So does a plan the founder set by hand once its
 * paid-through day has passed (Riyadh, `handPlanEnded`, rule 2273): the account is in the trial state from then on,
 * before the daily job writes the trial onto the record (rule 2274). Once the record says "trial", its `trialEnds`
 * alone decides, so a trial the founder extends afterwards (`extendTrial`) works. A record without `handPlan` is read as before.
 */
export const trialOver = (u: Pick<User, "plan" | "trialEnds" | "billing" | "handPlan">) =>
  (u.plan === "trial" && new Date(u.trialEnds) < new Date()) || billingLocked(u.billing) || handPlanEnded(u, ksaDay());

export const trialDaysLeft = (trialEnds: string) => Math.max(0, Math.ceil((new Date(trialEnds).getTime() - Date.now()) / 864e5));

/** One password rule for signup, change and reset: 8+ characters with a letter and a digit. */
export const strongPassword = (pw: string) => pw.length >= 8 && /\p{L}/u.test(pw) && /\d/.test(pw);
/** Emails become part of Redis keys (prefix:{scope}[:id], extra brands are email#brandId), so ":" and "#" could make two accounts share keys. */
export const validEmail = (e: string) => /^[^\s@:#]+@[^\s@:#]+\.[^\s@:#]+$/.test(e) && e.length <= 120;

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}

export function normalizePhone(p: string) {
  // Keep digits and leading +. Saudi numbers like 05xxxxxxxx become +9665xxxxxxxx.
  let d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^05\d{8}$/.test(d)) d = "+966" + d.slice(1);
  if (/^5\d{8}$/.test(d)) d = "+966" + d;
  if (!d.startsWith("+")) d = "+" + d;
  return d;
}

/**
 * The only reader of `user:{id}` (rule 1982): resolves an ACCOUNT from a pointer that already names one (`memberOf`, an
 * invite's owner, an MCP token, an OAuth code, a Paymob intent, a feed or booking record, a scope prefix, a member of
 * `users:all`, a referral code). It never checks an address: a sign-in address goes through `getLogin`, never here.
 *
 * The key the record was read from is its id: a stored `id` that differs (a record a rolled-back build copied to a new
 * address with the old `id` inside) is ignored and logged, so the account is always keyed where it lives.
 *
 * The stored plan is mapped on read (src/lib/pricing.ts `planFromStore`): the retired "enterprise" reads as "agency",
 * and any other unknown value as "trial", so no caller ever sees a plan outside `PLANS`. Top-up packs are settled the
 * same way (`settleTopups`: expired packs leave the balance). The next locked save writes the mapped value back.
 */
export async function getAccount(id: string): Promise<User | null> {
  const key = normalizeEmail(id);
  const u = await db.get<User>(accountKey.user(key));
  if (u) {
    if (u.id !== undefined && u.id !== key) log.warn("account id differs from its key", { shape: "user.id" });
    // A legacy record (no `id`) keeps reading as one, so `acct(u)` is its address; a record with an id is keyed where it lives.
    if (u.id !== undefined) u.id = key;
    u.plan = planFromStore(u.plan);
    // An expired top-up pack leaves the balance as it expires, not at the next cron (src/lib/topups.ts, rule 444).
    if (settleTopups(u)) u.topupsDirty = true;
  }
  return u;
}
/** The account behind a stored pointer: the same function as `getAccount`, kept under its old name for its callers. */
export const getUser = getAccount;

/**
 * Owner accounts only. Members live at `member:{email}` (src/lib/team.ts) and never pass through here or `users:all`.
 * Keyed by `acct(u)` (rule 1980), and R1 writes the id into every record it saves (`id = email` for a legacy account),
 * which builds before R1 ignore (rule 1995).
 */
export async function saveUser(u: User) {
  // The runtime-only fields: the active scope and who is acting are per request, never part of the account.
  const { scope: _s, brandId: _b, actor: _a, topupsDirty: _t, ...persist } = u;
  void _s; void _b; void _a; void _t;
  const id = acct(u);
  await db.set(accountKey.user(id), { ...persist, id });
  await db.sadd(globalKey.usersAll(), id);
}

/** `login:{email}`, checked (a value of an unknown shape reads as no index). */
export async function readLoginIndex(email: string): Promise<LoginIndexValue | null> {
  return parseStored("login", LoginIndex, await db.get<unknown>(accountKey.login(normalizeEmail(email))), null);
}
/**
 * Point the sign-in address `email` at the person `pid` (rule 1983). Callers hold `lock:login:{email}` and have just seen
 * `getLogin(email)` answer null under it, so a value already there names nobody who still signs in (left by a deletion
 * in a build before R1): it is replaced. Two signups or accepts racing for one address cannot both get here.
 */
export async function claimLogin(email: string, pid: string): Promise<void> {
  await db.set(accountKey.login(normalizeEmail(email)), loginIndexOf(pid));
}
/**
 * Drop the index of a sign-in address, but only while it still names `pid` (a later owner of the address keeps theirs).
 * The read and the delete run under `lock:login:{email}`, so a signup or accept claiming the address in between is never
 * undone (security review L1). A caller that already holds that lock (an address move) passes `locked`: the lock is not
 * reentrant. Order: `lock:team` and `lock:member` first, `lock:login` last, as `acceptInvite` and `dropMember` take them.
 */
export async function releaseLogin(email: string, pid: string, opts: { locked?: boolean } = {}): Promise<void> {
  const drop = async () => {
    const cur = await readLoginIndex(email);
    if (cur && cur.pid === pid) await db.del(accountKey.login(normalizeEmail(email)));
  };
  if (opts.locked) return drop();
  const { withLoginLock } = await import("./team");
  await withLoginLock(email, drop);
}

/**
 * A new owner account. Callers hold `lock:login:{email}` and have checked `getLogin(email)` is null under it. The id is
 * the address while `OPAQUE_IDS` is off (rule 1996); `opaque` is for tests that need id ≠ email (rule 1985). The login
 * index is written with the record: the person is the account's owner, whose person id is the account id.
 *
 * Multi-workspace M1 (rule 2132): the person row `person:{id}` is written fresh beside the account (plan reconciliation
 * 6: a leftover row of a deleted account at this id lends nothing), with the same hash, birth and session stamp, and
 * `orgs:{id}` names the account. Without a password (a Google sign-up) the person has no hash, and the account keeps a
 * hash of random bytes only so a build rolled back to R1, which compares `user.passHash`, never meets a record without
 * one. `emailVerifiedAt` (a Google sign-up, which proved the address) is written on the person and the account in the
 * same locked write (reconciliation 11: the only account the new person owns). `person: "p"` (tests only, rule 2132; a source scan pins that no route passes it) makes the M2 shape: a `p_`
 * person holding the credentials, and an account without them that names it in `ownerPid`.
 *
 * Multi-workspace M2 (rule 2117, sign-up half; spec section 10, decision 11): with `MULTI_ORG` on every sign-up, the
 * password form and Google alike, makes that shape with an opaque `a_` account id, and the person's one trial is
 * spent on it (`trialUsedAt`, read by `createWorkspace`). With it off nothing changes.
 *
 * Account id R2 (rule 2740): with `OPAQUE_IDS` on every new account gets an `a_` id, whatever the shape, so an address
 * whose old `user:{e}` or `person:{e}` still holds an account that moved in place never meets a new account at that key.
 */
export async function createUser(input: { email: string; name: string; phone: string; password?: string; lang: "ar" | "en"; emailVerifiedAt?: string }, opts: { opaque?: boolean; person?: "p" | "legacy" } = {}): Promise<User> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const stamp = now.toISOString();
  const passHash = input.password ? await bcrypt.hash(input.password, 10) : undefined;
  const [{ createPersonRecord, withPersonLock }, { newPersonId }, { addressBlocked }] = await Promise.all([import("./person"), import("./multi-org"), import("./email-hold")]);
  // Tests may pick the shape (`"p"`, or `"legacy"` for a legacy owner while `MULTI_ORG` is mocked on); a route never does.
  const split = opts.person ? opts.person === "p" : MULTI_ORG;
  // L3 (account-id R2, rule 2740): an account that moved in place keeps `user:{old}` holding its new address. An id
  // derived from this address would overwrite it, so such an address gets an opaque id whatever `OPAQUE_IDS` says.
  const moved = !(opts.opaque || OPAQUE_IDS || (split && MULTI_ORG)) && (await addressBlocked(email)) === "moved";
  const account: User = {
    id: idForNewAccount(email, opts.opaque || OPAQUE_IDS || (split && MULTI_ORG) || moved),
    email,
    name: input.name.trim().slice(0, 80),
    phone: input.phone.trim() ? normalizePhone(input.phone) : "",
    plan: "trial",
    credits: PLAN_CREDITS.trial,
    trialEnds: new Date(now.getTime() + 3 * 864e5).toISOString(),
    createdAt: stamp,
    lang: input.lang,
    gatedSignup: true,
    // What the signup notice under the form named, from the versions in code (rule 1325).
    consent: signupConsent(input.lang, now),
  };
  const pid = storedPersonId(split ? newPersonId() : acct(account));
  // Sessions cannot be enumerated, so a deleted account's cookies outlive it. Stamping the creation time kills every
  // session issued before this person existed: a re-registered address never inherits an old login.
  const proved = input.emailVerifiedAt ? { emailVerifiedAt: input.emailVerifiedAt } : {};
  const person = { pid, email, name: account.name, lang: account.lang, passHash, createdAt: stamp, sessionsAfter: stamp, ...proved, ...(split ? { trialUsedAt: stamp } : {}) };
  const u: User =
    split
      ? { ...account, ...proved, ownerPid: pid }
      : { ...account, ...proved, passHash: passHash ?? (await bcrypt.hash(randomBytes(32).toString("base64url"), 10)), sessionsAfter: stamp };
  // `lock:login` (the caller's) → `lock:person` (rule 2139), taken before the first write: a held person lock throws
  // `person_lock_timeout` with nothing written, and the signup routes answer it 409 `busy`.
  await withPersonLock(pid, async () => {
    await saveUser(u);
    await Promise.all([createPersonRecord(person, { loginLocked: true, personLocked: true }), db.sadd(personKey.orgs(pid), acct(u))]);
    await claimLogin(email, pid);
  });
  return u;
}

/**
 * Check a typed password against the PERSON's hash (multi-workspace M1, rule 2134): `login.person` from `getLogin`, so a
 * stale `person:` row never beats a provably newer legacy record (plan reconciliation 5). A person without a hash (a
 * Google-only person, or a record missing it) never matches.
 */
export async function verifyPassword(p: Pick<Person, "passHash">, password: string): Promise<boolean> {
  return typeof p.passHash === "string" && p.passHash.length > 0 && bcrypt.compare(password, p.passHash);
}

/**
 * A session record: the LOGIN email (an owner's or a member's), when it was issued, and on an impersonation session the
 * founder behind it (`imp`, "key" for the console key). Membership is never cached here: it is re-resolved from
 * `member:{email}` on every request. Sessions written before 2026-09-18 are a bare email with no issue time, which counts
 * as "issued at 0".
 */
/**
 * A stored session. `exp` (epoch ms, since 2026-10-11, rule 1177) is the end of an impersonation the founder chose in the
 * console (15, 60 or 120 minutes); the record's TTL ends at the same moment. Optional (expand): a session without it
 * reads as before, and an impersonation without it shows `at` + 2 hours, the TTL every one had until then.
 * `ss` (rule 1648, new and optional: old code ignores it) is the hash of the staff session an impersonation was opened
 * from: the customer view lives only as long as that staff session, and a request through it renews it.
 */
/**
 * `pid` and `acct` (account-id R1, rule 1984, with multi-org forced change 3): the person signed in and the ACTIVE
 * account, written by `createSession` from the resolved login. Optional (expand): a session without them (written before
 * R1) resolves exactly as before. With them, `resolveSession` checks that the login still names `pid` and that `pid`
 * owns `acct` or is on its roster, so a session never follows an address that moved to someone else.
 */
export type Session = { email: string; at: number; imp?: string; kp?: string; as?: string; exp?: number; ss?: string; pid?: string; acct?: string };
/** The impersonation length every session had before the founder could choose it (2 hours). */
export const IMPERSONATION_LEGACY_MS = 2 * 60 * 60 * 1000;
type SessionRec = string | Session;
const sessionOf = (rec: SessionRec | null): Session | null => (!rec ? null : typeof rec === "string" ? { email: rec, at: 0 } : rec);
/**
 * Where a session record lives (rule 1345, expand step of rule 679, started 2026-10-12). New records are stored under
 * the SHA-256 (hex) of the cookie's token, `session:h:{sha256}`, so a read of the store (a leaked dump, a support query,
 * a log of keys) yields nothing that signs anyone in. Records written before this release live under the raw token,
 * `session:{token}`: they are still read (`sessionKeys`, raw last) and deleted with the hashed one, so nobody is signed
 * out by the release, and they end on their own within 30 days (`SESSION_TTL`). The contract step (a later release,
 * once every raw record has expired) drops the raw read and delete.
 *
 * The raw key is tried only for a token of the shape `createSession` mints (64 hex characters): a cookie set to
 * `h:{hash}` must never read the hashed record through the raw path, or a leaked hash would sign in after all.
 */
export const sessionKey = (token: string) => globalKey.session(createHash("sha256").update(token).digest("hex"));
const RAW_TOKEN = /^[0-9a-f]{64}$/;
/** Every key a cookie's session may live under: the hashed one first, then the raw one written before rule 1345. */
export const sessionKeys = (token: string) => (RAW_TOKEN.test(token) ? [sessionKey(token), globalKey.sessionLegacy(token)] : [sessionKey(token)]);
/** Read the record behind a cookie token: hashed first, then the raw key of a session written before rule 1345. */
export async function sessionRecord(token: string): Promise<SessionRec | null> {
  const [hashed, raw] = await Promise.all(sessionKeys(token).map((k) => db.get<SessionRec>(k)));
  return hashed ?? raw ?? null;
}
/** Delete a cookie token's session record under both keys. */
export async function dropSession(token: string): Promise<void> {
  await Promise.all(sessionKeys(token).map((k) => db.del(k)));
}

/** True when a session issued at `at` predates the revocation stamp `iso`. */
const issuedBefore = (at: number, iso?: string) => !!iso && at < new Date(iso).getTime();

/**
 * Sign every device out: sessions issued before this moment stop working at their next request. Called whenever the
 * password changes, so a stolen cookie does not outlive the password it was obtained with. Only marks the record: the
 * caller saves it, inside the user lock.
 */
export function revokeSessions(u: User) {
  u.sessionsAfter = new Date().toISOString();
}
/**
 * Sign every MEMBER of the account out (founder reset, owner reset). The owner's own sessions follow `revokeSessions`.
 * Only marks the record: the caller saves it, inside the user lock.
 */
export function revokeTeamSessions(u: User) {
  u.teamSessionsAfter = new Date().toISOString();
}

/**
 * Cookie options every session-bearing cookie shares.
 *
 * `Secure` describes the TRANSPORT, not the build. It used to be `process.env.NODE_ENV === "production"`, which says
 * nothing about how the response travels: a production build served over plain http marks the cookie Secure, every
 * conforming client throws it away, and nobody can log in — with no error anywhere, because the request simply
 * arrives without a cookie. That is what happened to the end-to-end suite on WebKit, which (unlike Chromium, and
 * unlike WebKit on macOS) does not treat http://localhost as a trustworthy origin.
 *
 * So: Secure unless this is plain http to the loopback interface, which is the only case where no real traffic is at
 * risk. A deployment on a real host over http still gets Secure and still refuses to work, which is the right way for
 * that mistake to fail — loudly and locally, never by quietly dropping the flag on live traffic.
 */
export async function sessionCookie(maxAge: number) {
  return { httpOnly: true, sameSite: "lax", secure: !(await loopbackHttp()), path: "/", maxAge } as const;
}

/** Plain http to the loopback interface (local development): the one case a cookie may go without Secure. */
export async function loopbackHttp(): Promise<boolean> {
  const h = await headers();
  const host = (h.get("host") ?? "").toLowerCase();
  const plainHttp = (h.get("x-forwarded-proto") ?? "http") === "http";
  return plainHttp && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/**
 * Sign this login in. `email` is the login's own address (owner or member), never an account email chosen for a member.
 * `imp` marks a founder impersonation session (admin console only): it resolves to actor kind "founder". One opened
 * with the console key also carries `kp` and `as` from `keyImpBinding` (rule 429).
 */
export async function createSession(email: string, ttlSeconds: number = SESSION_TTL, opts: { imp?: string; kp?: string; as?: string; ss?: string } = {}) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  // The person and the active account (rule 1984), from the login as it resolves now. No login: neither is written, and
  // the session resolves to nothing anyway.
  const ids = await sessionIds(email, { imp: !!opts.imp });
  // An impersonation carries its end (`exp`, rule 1177), the same moment its TTL ends.
  const rec: Session = opts.imp ? { email, at: now, imp: opts.imp, exp: now + ttlSeconds * 1000, ...(opts.kp ? { kp: opts.kp } : {}), ...(opts.as ? { as: opts.as } : {}), ...(opts.ss ? { ss: opts.ss } : {}), ...ids } : { email, at: now, ...ids };
  // Hashed key only (rule 1345): the raw token is in the cookie and nowhere else.
  await db.set(sessionKey(token), rec satisfies SessionRec, ttlSeconds);
  const jar = await cookies();
  jar.set(COOKIE, token, await sessionCookie(ttlSeconds));
  dropLegacyCookie(jar, COOKIE);
  // The device list (rule 1938): the login's own sessions, never a founder's impersonation. Best effort: a failure here
  // never blocks a sign-in.
  if (!opts.imp) {
    const { recordDevice } = await import("./devices");
    await recordDevice(email, sessionKey(token)).catch(() => {});
  }
}

/**
 * The person and the active account a new session of this login carries (rule 1984, multi-workspace spec section 7):
 * `pid` from `getLogin`, `acct` from `pickAccount` (`lastorg:` while it holds, else the owned account, else the oldest
 * live membership; a legacy person's home account). With `MULTI_ORG` off the pick is always the home account, the value
 * R1 wrote: the owner's own account, or the member's `memberOf`. No account: `acct` is absent. An impersonation keeps
 * R1's shape: the account the address owns and its owner (`ownerOf`, the same person for a legacy owner).
 */
export async function sessionIds(email: string, opts: { imp?: boolean } = {}): Promise<{ pid?: string; acct?: string }> {
  try {
    const l = await getLogin(email);
    if (!l) return {};
    const { ownerOf, pickAccount } = await import("./membership");
    if (opts.imp) return l.kind === "owner" ? { pid: ownerOf(l.user), acct: l.acct } : { pid: l.pid, ...(l.acct ? { acct: l.acct } : {}) };
    const a = await pickAccount(l.person);
    return a ? { pid: l.pid, acct: a } : { pid: l.pid };
  } catch {
    return {};
  }
}

/**
 * Point this device's session at account `aid` (multi-workspace M2, spec section 7 "Switching"): the switch, create and
 * accept routes call it after checking that `pid` holds `aid`. `SET XX` on the record's own key with its TTL kept, so a
 * session signed out meanwhile stays gone. An impersonation, or a session of another person, is never moved. False when
 * nothing was written. Reads the record and its TTL in one round.
 */
export async function setSessionAccount(pid: string, aid: string): Promise<boolean> {
  const token = readCookie(await cookies(), COOKIE);
  if (!token) return false;
  const rows = await Promise.all(sessionKeys(token).map(async (k) => {
    const [rec, ttl] = await Promise.all([db.get<SessionRec>(k), db.ttl(k)]);
    return { k, rec, ttl };
  }));
  const hit = rows.find((r) => r.rec);
  const s = sessionOf(hit?.rec ?? null);
  if (!hit || !s || s.imp || hit.ttl <= 0 || (s.pid !== undefined && s.pid !== pid)) return false;
  return db.setXx(hit.k, { ...s, pid, acct: aid } satisfies Session, hit.ttl);
}

/** The hashed session key behind this request's cookie (the device list marks it as "this device"), or null. */
export async function currentSessionKey(): Promise<string | null> {
  const token = readCookie(await cookies(), COOKIE);
  return token ? sessionKey(token) : null;
}

/**
 * Give this device a fresh session for `email`, then run `revoke(stamp)`, then drop the old session record (rule 1171).
 * The new session is written first and issued at or after `stamp`, so a revocation stamped `stamp` never ends it, and
 * a failure at any step leaves the device signed in: before `revoke` the old session still holds, after it the new one
 * does. When `revoke` answers false (nothing was revoked) the new session is removed and the old cookie put back.
 */
export async function rotateSession(email: string, revoke: (stamp: string) => Promise<boolean>): Promise<boolean> {
  const jar = await cookies();
  const old = readCookie(jar, COOKIE);
  const stamp = new Date().toISOString();
  await createSession(email);
  const fresh = jar.get(COOKIE)?.value;
  if (!(await revoke(stamp))) {
    if (fresh && fresh !== old) await dropSession(fresh);
    if (old) jar.set(COOKIE, old, await sessionCookie(SESSION_TTL));
    return false;
  }
  if (old && old !== fresh) await dropSession(old).catch(() => {});
  return true;
}

export async function destroySession() {
  const jar = await cookies();
  // Both names (rule 1811): a browser may still hold an old `nashr_session` beside the new one; both records go.
  const tokens = [...new Set(namesOf(COOKIE).map((n) => jar.get(n)?.value).filter((v): v is string => !!v))];
  // This device leaves the login's device list too (rule 1938); the list drops any entry this misses on its next read.
  const { forgetDevice } = await import("./devices");
  await Promise.all(tokens.map(async (t) => {
    const s = sessionOf(await sessionRecord(t).catch(() => null));
    await dropSession(t);
    if (s && !s.imp) await forgetDevice(s.email, sessionKey(t)).catch(() => {});
  }));
  dropCookie(jar, COOKIE);
}

/** An owner is verified when the address was proved with an emailed code (`User.emailVerifiedAt`). */
export const emailVerified = (u: Pick<User, "emailVerifiedAt">): boolean => !!u.emailVerifiedAt;

/** The session behind the cookie, or null (no cookie, expired, a key impersonation whose key changed). */
async function readSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = readCookie(jar, COOKIE);
  if (!token) return null;
  const s = sessionOf(await sessionRecord(token));
  if (!s) return null;
  if (s.imp === "key" && !(await keyImpLive(s))) return null;
  if (s.imp && s.ss !== undefined && !(await staffImpLive(s))) return null;
  return s;
}

/**
 * The page's brand selector (rule 886, brand id in the URL): the `x-thakeen-brand` request header, set by the browser's
 * fetch wrapper (src/lib/brand-fetch.ts) from the page's `/b/{id}` segment and by the proxy from a page path. Undefined when absent
 * or empty (an empty value is no header, as in the proxy and the brand guard). A value that is not
 * a brand id (`isBrandId`: no `/`, `%`, `.`, `#`, `:`, at most 64 characters) is Next's 404 here, before any store read.
 * It is only a SELECTOR: `resolveSession` accepts it when it is one of the session account's own active brands, and
 * builds the scope from that brand list, never from the header.
 */
async function brandSelector(): Promise<string | undefined> {
  const v = (await headers()).get(BRAND_HEADER);
  if (!v) return undefined;
  if (!isBrandId(v)) notFound();
  return v;
}

/**
 * The signed-in account for this request, or null. With a brand selector (`brandSelector`) the account's brand is that
 * one, or the request is Next's 404 (R-C3): a page renders the not-found page, a route answers 404. Callers that wrap
 * this in a `try` put `unstable_rethrow(e)` first in the `catch`.
 */
export async function currentUser(): Promise<User | null> {
  const brand = await brandSelector();
  const s = await readSession();
  return s ? resolveSession(s, { brand, handle: await requestHandle() }) : null;
}

/**
 * The request's workspace handle (`x-thakeen-ws`, src/lib/ws-path.ts), read only while `MULTI_ORG` is on: undefined
 * when the request names no workspace, the raw value otherwise (a malformed one answers 404 in `resolveSession`). The
 * proxy sets it for pages from their own path and strips any value the browser sent; the client sends it for APIs.
 */
async function requestHandle(): Promise<string | undefined> {
  if (!MULTI_ORG) return undefined;
  return (await headers()).get(WS_HEADER) ?? undefined;
}

/**
 * Like `currentUser`, but an owner who has not verified the address yet resolves too. Only the verify page, the verify
 * routes and the app layout may call it (rule 752, pinned by tests/email-verify-gate.test.ts): every other caller keeps
 * `currentUser`, where such an owner reads as signed out. The brand selector is honoured the same way (rule 886).
 */
export async function currentUserUnverified(): Promise<User | null> {
  const brand = await brandSelector();
  const s = await readSession();
  return s ? resolveSession(s, { unverified: true, brand, handle: await requestHandle() }) : null;
}

/**
 * The brand a selector names in this account (rule 886): "default" always (the account's own scope, every resolver's
 * fallback), otherwise the id of the ACTIVE row of `rows` that equals `want`. Undefined when there is none, or when the
 * list could not be read (`rows` null): a selector fails closed, the caller answers 404. The id returned comes from
 * the account's stored list, so the scope is never built from the request.
 */
function selectedBrand(want: string, rows: BrandMeta[] | null): string | undefined {
  if (want === "default") return "default";
  return rows?.find((b) => b.id === want && b.status === "active")?.id;
}

/**
 * The PERSON behind this request's session (multi-workspace membership, spec section 7, "no workspace" state): a valid
 * session with a valid person, with or without a valid account. `acct` is the session's active account when it still
 * resolves for this person (`resolveSession`), else null. The person checks are `resolveSession`'s: the login index still
 * names the person, the person holds the address, is not suspended, and the session is not older than its stamps. A
 * session written before R1 finds its person through `getLogin`. An impersonation never resolves a person (the founder
 * is not that person). Only the M2 workspace pages and routes, the join flow, the person's own security settings and
 * sign-out may call it (pinned like rule 752 by tests/multi-org-session.test.ts; no caller under src/app in M1).
 */
export async function currentPerson(): Promise<{ person: Person; acct: AccountId | null } | null> {
  const s = await readSession();
  if (!s || s.imp) return null;
  const [person, u, { aidOf }] = await Promise.all([sessionPerson(s), resolveSession(s), import("./membership")]);
  if (!person) return null;
  return { person, acct: u && u.actor?.pid === person.pid ? aidOf(u) : null };
}

/** The session's person, checked as `resolveSession` checks it; null when the session names nobody who still signs in. */
async function sessionPerson(s: Session): Promise<Person | null> {
  const email = normalizeEmail(s.email);
  let person: Person | null;
  if (typeof s.pid === "string" && s.pid) {
    const pid = storedPersonId(s.pid);
    const { getPerson } = await import("./person");
    const [idx, p] = await Promise.all([readLoginIndex(email), getPerson(pid)]);
    if (idx ? idx.pid !== pid : pid !== email) return null;
    person = p;
  } else {
    person = (await getLogin(email))?.person ?? null;
  }
  if (!person || normalizeEmail(person.email) !== email || isPersonSuspended(person)) return null;
  if (issuedBefore(s.at, person.sessionsAfter) || issuedBefore(s.at, person.devicesAfter)) return null;
  return person;
}

/**
 * Turn a session into the ACCOUNT record with `actor` set (docs/superpowers/specs/2026-09-29-teams-design.md §3,
 * docs/specs/2026-10-18-multi-org.md section 7).
 *
 * The account is always the owner's `User`, so every `sc(u)`, charge and plan check keeps working unchanged. Scope is
 * built from the ACCOUNT id: a member's own address never becomes a workspace key.
 *
 * A session with `pid` and `acct` (written from R1 on) resolves on the person and the membership (`resolveIds`): one
 * parallel round after the session read, for owners and members alike (rule 2135). A session without them (written
 * before R1) resolves exactly as before (`resolveLegacy`) and is never rewritten on read.
 *
 * `brand` (rule 886) is the page's selector (`brandSelector`): when set, the account's brand is that brand if it is one
 * of the RESOLVED account's active brands (`selectedBrand`; for an impersonation, the impersonated account's), else
 * `notFound()`. The stored choice (`activebrand`) is then neither used nor written. Without it, today's behaviour.
 * The checks run after the session and the account have resolved, so a session that resolves to nobody stays null.
 * With a workspace `handle` too (M2, `/w/{handle}/b/{id}`), the handle picks the account first (`resolveInHandle`) and
 * the brand is then one of THAT account's active brands.
 */
type ResolveOpts = { unverified?: boolean; brand?: string; handle?: string };
async function resolveSession(s: Session, opts: ResolveOpts = {}): Promise<User | null> {
  const ids = typeof s.pid === "string" && !!s.pid && typeof s.acct === "string" && !!s.acct;
  const h = opts.handle;
  if (h === undefined) return ids ? resolveIds(s, s.pid!, s.acct!, opts) : resolveLegacy(s, opts);
  return resolveInHandle(s, ids, h, opts);
}

/**
 * The account a request names by its workspace handle (multi-workspace release M2, spec section 7 "Workspace in the
 * link", rules 2112, 2135). The handle is only a selector among the person's own accounts, re-checked on every request:
 *
 * - the handle of the session's `acct`, computed locally: the same two rounds as without a handle;
 * - any other handle: ONE round reads `orgs:{pid}` (a hint) and the legacy `user:`/`member:` of `pid` (a legacy owner's
 *   or member's home has no `orgs:` entry), each candidate's handle is computed and the match goes through `resolveIds`,
 *   every forward check included (three rounds in all);
 * - a session without `pid`/`acct` (written before R1) and an impersonation reach only their own account's handle.
 *
 * Any miss (a malformed, made-up, foreign or stale handle, a membership gone since) answers 404 through `notFound()`,
 * the same answer for every case, so a handle never tells whether an account exists. Nothing is written: visiting a link
 * moves neither the session's `acct` nor `lastorg:`.
 */
async function resolveInHandle(s: Session, ids: boolean, h: string, opts: ResolveOpts): Promise<User | null> {
  if (!asHandle(h)) notFound();
  if (ids && wsHandle(s.acct!) === h) return resolveIds(s, s.pid!, s.acct!, opts);
  if (!ids) {
    const u = await resolveLegacy(s, opts);
    if (!u) return null;
    if (handleOf(u) !== h) notFound();
    return u;
  }
  if (s.imp) notFound();
  const pid = storedPersonId(s.pid!);
  const [{ legacyHomeFrom }, entries, rawUser, rawMember] = await Promise.all([
    import("./membership"),
    db.smembers(personKey.orgs(pid)),
    db.get<unknown>(accountKey.user(pid)),
    db.get<unknown>(accountKey.member(pid)),
  ]);
  const home = legacyHomeFrom(pid, rawUser, rawMember);
  const aid = matchHandle(h, [...new Set([...entries, pid as string, ...(home ? [home as string] : [])])]);
  if (!aid) notFound();
  const u = await resolveIds(s, pid, aid, opts);
  if (!u) notFound();
  return u;
}

/** `resolveIds`'s marker for a brand list the store failed to answer. */
const BRANDS_UNREAD = Symbol("brands unread");

/**
 * A session that names its person and its ACTIVE account (rules 1984, 2111, 2131, 2135). ONE parallel round reads the
 * person (`person:`, `user:` and `member:` of `pid`, for `personFromRaw`), the login index, the account (`user:{acct}`,
 * the same command when `acct` is `pid`), the membership (`mbr:{acct}:{pid}`, the legacy `member:{pid}`, the roster
 * entry; the row and the roster not when `acct` is `pid`, the person's own account), the account's brands and the active brand (`activebrand:{pid}:{acct}`, the legacy `activebrand:{email}`).
 *
 * It resolves only when: the index still names `pid` (no index: `pid` is the address, a legacy person); the person
 * exists, holds this address, is not suspended, and the session is not older than its `sessionsAfter`/`devicesAfter`;
 * the account exists under `acct`, is not suspended, and is verified (rule 751: an owner passes through
 * `currentUserUnverified` and an impersonation; rule 767: a member never does); `roleIn` gives a role on these records,
 * and for a membership `membershipHolds` (accepted no earlier than the account was created) and the session is not
 * older than the account's `teamSessionsAfter`. An impersonation resolves only as the owner, and only until its `exp`.
 * Nothing is taken from the request: `acct` is the session's, re-checked here on every request.
 */
async function resolveIds(s: Session, rawPid: string, rawAcct: string, opts: ResolveOpts): Promise<User | null> {
  const email = normalizeEmail(s.email);
  const pid = storedPersonId(rawPid);
  const aid = storedAccountId(rawAcct);
  const [{ personFromRaw }, { membershipFromRaw, roleIn, membershipHolds, legacyHomeFrom }, { brandsFromRaw, activeBrandFrom, scopeFor }] = await Promise.all([import("./person"), import("./membership"), import("./brands")]);
  const same = (aid as string) === (pid as string);
  const [rawPerson, rawUser, rawMember, idx, account, rawMbr, listed, rawBrands, rawActive, rawLegacyActive] = await Promise.all([
    db.get<unknown>(personKey.person(pid)),
    same ? Promise.resolve(null) : db.get<unknown>(accountKey.user(pid)),
    db.get<unknown>(accountKey.member(pid)),
    readLoginIndex(email),
    getAccount(aid),
    // `acct` equal to `pid` is the person's own account (a legacy owner, an opaque owner): it can only be held as its
    // owner, so the membership and the roster are not read (`roleIn` refuses should `ownerOf` disagree).
    same ? Promise.resolve(null) : db.get<unknown>(accountKey.membership(aid, pid)),
    same ? Promise.resolve(false) : db.sismember(accountKey.members(aid), pid),
    // A store error on the brand list alone does not end the request: the stored choice is used unchecked, as an
    // owner's always was before R1 (the scope stays inside this account either way).
    db.get<unknown>(accountKey.brands(aid)).catch((e: unknown) => { log.error("session brand list read failed", e); return BRANDS_UNREAD; }),
    db.get<unknown>(personKey.activeBrand(pid, aid)),
    db.get<unknown>(accountKey.activeBrand(email)),
  ]);
  // The login must still name the session's person: an address that moved on, or was taken by someone else, ends it.
  if (idx ? idx.pid !== pid : pid !== email) return null;
  const legacyRecord = same ? account : rawUser;
  const person = personFromRaw(pid, rawPerson, legacyRecord, rawMember);
  if (!person || normalizeEmail(person.email) !== email) return null;
  if (isPersonSuspended(person)) return null; // person suspension (rule 2131): every account, every resolver
  if (issuedBefore(s.at, person.sessionsAfter)) return null; // issued before the last password change (or before the person existed)
  if (issuedBefore(s.at, person.devicesAfter)) return null; // issued before the last "sign out other devices" (rule 1170)
  if (!account || acct(account) !== aid || isSuspended(account)) return null; // account suspension: this account only
  const membership = membershipFromRaw(aid, pid, rawMbr, rawMember, listed);
  const role = roleIn(account, pid, membership);
  if (!role) return null;
  if (role === "owner") {
    if (s.imp && typeof s.exp === "number" && Date.now() >= s.exp) return null; // the founder's chosen length is over (rule 1177)
    // The verification gate (rule 751): an owner who has not proved the address is signed out for every caller except
    // `currentUserUnverified`. A founder impersonation passes (support must reach the account).
    if (!emailVerified(account) && !s.imp && !opts.unverified) return null;
  } else {
    // Impersonation sessions are only ever issued for owner accounts.
    if (s.imp || !membership || !membershipHolds(account, membership)) return null;
    // Rule 767: while the owner has not proved the address the account spends nothing, so its members are signed out
    // too, in both resolvers (a member has no address of the owner's to prove).
    if (!emailVerified(account)) return null;
    if (issuedBefore(s.at, account.teamSessionsAfter)) return null;
  }
  // The person's active brand in THIS account (rule 2119), the legacy per-login key only for their home account, and
  // only while it is one of this account's active brands.
  const home = legacyHomeFrom(pid, legacyRecord, rawMember) === aid;
  let bid: string;
  if (opts.brand !== undefined) {
    // Rule 886: the page's selector, only among this account's active brands; an unreadable list refuses it.
    const picked = selectedBrand(opts.brand, rawBrands === BRANDS_UNREAD ? null : brandsFromRaw(rawBrands));
    if (picked === undefined) notFound();
    bid = picked;
  } else {
    const chosen = activeBrandFrom(rawActive, rawLegacyActive, home);
    bid = rawBrands === BRANDS_UNREAD || brandsFromRaw(rawBrands).some((b) => b.id === chosen && b.status === "active") ? chosen : "default";
  }
  account.brandId = bid;
  account.scope = scopeFor(acct(account), bid);
  const base = { pid, home, email: person.email, name: person.name, lang: person.lang === "en" ? ("en" as const) : ("ar" as const), role };
  account.actor =
    role !== "owner"
      ? { ...base, kind: "member" }
      : s.imp
        ? { ...base, kind: "founder", impersonating: s.imp, since: s.at, until: typeof s.exp === "number" ? s.exp : s.at + IMPERSONATION_LEGACY_MS }
        : { ...base, kind: "owner" };
  return account;
}

/**
 * A session written before R1 (no `pid` or no `acct`): today's rounds and checks, unchanged (rules 2132, 2135). An owner
 * resolves in one round after the session read, a member in two. A member is refused when disabled, when the session
 * predates their own or the team's revocation stamp, when the owner is gone, suspended or has not verified the address
 * (rule 767), when the member is not on the owner's roster (`members:{owner}`), or when the member record predates the
 * owner record (a re-registered owner address never inherits an old team). The person and the account it stands for are
 * derived from the legacy records (an owner: `acct(u)`; a member: its `memberOf`), both the person's home; the active
 * brand is the legacy per-login `activebrand:{email}`, which `setActiveBrandIn` keeps writing for the home account.
 */
async function resolveLegacy(s: Session, opts: ResolveOpts): Promise<User | null> {
  const email = normalizeEmail(s.email);
  const [{ getMember, onRoster, memberPid }, { activeBrandId, listBrands, scopeFor }, { ownerOf }] = await Promise.all([import("./team"), import("./brands"), import("./membership")]);
  // The active brand is per login (`activebrand:{login}`), so it is read in the same round as the login records, and so
  // is the login index (rule 1984): one more command, no more rounds. A session without `acct` (written before R1) reads
  // the account at its own address, exactly the record it read before. So is the person row of the session's person (its
  // `pid`, else the address, a legacy person's id): person suspension (rule 2131, pre-R1 half, multi-workspace M3)
  // refuses this path too, as it refuses `resolveIds`.
  const sessionPid = storedPersonId(typeof s.pid === "string" && s.pid ? s.pid : email);
  const [idx, first, m, brandId, rawPerson] = await Promise.all([
    readLoginIndex(email), getAccount(typeof s.acct === "string" && s.acct ? s.acct : email), getMember(email), activeBrandId(email), db.get<unknown>(personKey.person(sessionPid)),
  ]);
  /** The person `pid` is suspended (its `person:` row, failing closed like the account field); another pid costs one more read. */
  const personBlocked = async (pid: PersonId): Promise<boolean> => {
    const raw = pid === sessionPid ? rawPerson : await db.get<unknown>(personKey.person(pid));
    return isSuspended(raw && typeof raw === "object" ? (raw as { suspended?: unknown }) : null);
  };
  // The login must still name the session's person: an address that moved on, or was taken by someone else, ends it.
  if (idx && typeof s.pid === "string" && s.pid && idx.pid !== s.pid) return null;
  // A session without `acct` whose index names an account stored under another id (none exists while `OPAQUE_IDS` is
  // off): one more round, never taken by a legacy account.
  const stored = first ?? (!s.acct && idx && idx.pid !== email ? await getAccount(idx.pid) : null);
  const u = stored && ownsLogin(stored, email, idx) && (!s.acct || s.acct === acct(stored)) ? stored : null;
  if (u) {
    if (isSuspended(u)) return null;
    if (await personBlocked(ownerOf(u))) return null; // person suspension (rule 2131): every account, every resolver
    if (issuedBefore(s.at, u.sessionsAfter)) return null; // issued before the last password change (or before the account existed)
    if (issuedBefore(s.at, u.devicesAfter)) return null; // issued before the owner's last "sign out other devices" (rule 1170)
    // The verification gate (rule 751): an owner who has not proved the address is signed out for every caller except
    // `currentUserUnverified`. A founder impersonation passes (support must reach the account). A member login (below)
    // is gated by its owner's state too (rule 767).
    if (!emailVerified(u) && !s.imp && !opts.unverified) return null;
    if (s.imp && typeof s.exp === "number" && Date.now() >= s.exp) return null; // the founder's chosen length is over (rule 1177)
    let bid = brandId;
    if (opts.brand !== undefined) {
      // Rule 886 (R-C7): this branch never listed the brands, so a selector costs one more round; a store error refuses it.
      const rows = opts.brand === "default" ? null : await listBrands(acct(u)).catch((e: unknown) => { log.error("session brand list read failed", e); return null; });
      const picked = selectedBrand(opts.brand, rows);
      if (picked === undefined) notFound();
      bid = picked;
    }
    u.brandId = bid;
    u.scope = scopeFor(acct(u), bid);
    // A legacy owner's person is the account's owner, and the account is their home.
    const base = { pid: ownerOf(u), home: true, email: u.email, name: u.name, lang: u.lang, role: "owner" as const };
    u.actor = s.imp
      ? { ...base, kind: "founder", impersonating: s.imp, since: s.at, until: typeof s.exp === "number" ? s.exp : s.at + IMPERSONATION_LEGACY_MS }
      : { ...base, kind: "owner" };
    return u;
  }
  // Member login. Impersonation sessions are only ever issued for owner accounts.
  if (!m || s.imp || m.disabled) return null;
  if (m.role !== "admin" && m.role !== "member") return null;
  if (typeof m.memberOf !== "string" || !m.memberOf || m.memberOf === email) return null;
  // The member record must be this login's (its own address, its frozen person id matching the index), and a session
  // that names an account names this member's team (multi-org forced change 3: `pid` is on the roster of `acct`).
  if (normalizeEmail(m.email) !== email || !memberHolds(memberPid(m), email, idx)) return null;
  if (typeof s.acct === "string" && s.acct && s.acct !== m.memberOf) return null;
  if (issuedBefore(s.at, m.sessionsAfter) || issuedBefore(s.at, m.devicesAfter)) return null;
  const mPid = storedPersonId(memberPid(m));
  if (await personBlocked(mPid)) return null; // person suspension (rule 2131): every account, every resolver
  // The roster entry too, in the same round: removal deletes both under `lock:member`, and a record that outlived its
  // entry anyway (restored by a racing write, left by a deleted account) is off the owner's Members page, so it must
  // not sign in either.
  const [owner, brands, listed] = await Promise.all([getAccount(m.memberOf), listBrands(m.memberOf), onRoster(m.memberOf, email)]);
  if (!owner || isSuspended(owner) || !listed) return null;
  // Rule 767: while the owner has not proved the address, the account spends nothing, so its members are signed out too,
  // in both resolvers. A member has no address of the owner's to prove, so `currentUserUnverified` never hands one to the
  // verify page: they read as signed out, and login answers `owner_unverified`. (Impersonation never reaches this branch.)
  if (!emailVerified(owner)) return null;
  if (issuedBefore(s.at, owner.teamSessionsAfter)) return null;
  // NaN on either side (a malformed date) refuses too.
  if (!(new Date(m.acceptedAt).getTime() >= new Date(owner.createdAt).getTime())) return null;
  // The member's own active brand, but only while it is one of the owner's active brands.
  let bid: string;
  if (opts.brand !== undefined) {
    // Rule 886: the page's selector, only among the owner's active brands (already listed in this round).
    const picked = selectedBrand(opts.brand, brands);
    if (picked === undefined) notFound();
    bid = picked;
  } else bid = brands.some((b) => b.id === brandId && b.status === "active") ? brandId : "default";
  owner.brandId = bid;
  owner.scope = scopeFor(acct(owner), bid);
  // A legacy member's person id is its frozen address (`memberPid`), and `memberOf` is its home account.
  owner.actor = { kind: "member", pid: mPid, home: true, email: m.email, name: m.name, lang: m.lang === "en" ? "en" : "ar", role: m.role };
  return owner;
}

/**
 * An owner record signs in with the address `email` (rule 1981): the record's own address is `email`, and its id is the
 * person the index names. Without an index (an account from before R1, before the conversion script) the record counts
 * only when it has no id or its id is `email`: after an address move in R2 the record stays at `user:{old}` holding the
 * new address, and the old address must resolve to nothing, so a forgot-password or a signup there never reaches it.
 */
function ownsLogin(u: User, email: string, idx: LoginIndexValue | null): boolean {
  if (normalizeEmail(u.email) !== email) return false;
  return idx ? acct(u) === idx.pid : u.id === undefined || u.id === email;
}
/** The same guard for a member record (multi-org forced change 2): its frozen person id is the one the index names. */
function memberHolds(pid: string, email: string, idx: LoginIndexValue | null): boolean {
  return idx ? pid === idx.pid : pid === email;
}

/**
 * A login: an owner account, or a member login with the account it belongs to (null when that owner is gone). `pid` is
 * the person (multi-org forced change 1): an owner's person id is its account id, a member's its frozen address, a person
 * known only through `person:` and membership rows its `p_` id. `person` is the person as `getPerson` reads it (rule 2134):
 * the password, the stamps and the address are checked there. `acct` is the account the login stands for: the owned
 * account, the legacy member's `memberOf`, or the oldest live membership. `member` is the legacy member record, null for
 * a person known only through `mbr:` rows (test persons in M1, real ones from M2).
 */
export type Login =
  | { kind: "owner"; user: User; pid: PersonId; person: Person; acct: AccountId }
  | { kind: "member"; member: Member | null; owner: User | null; pid: PersonId; person: Person; acct: AccountId | null };
/**
 * What a SIGN-IN ADDRESS signs in as (rule 1982): only sign-in, signup, forgot/reset password, Google sign-in, the
 * address-change "is it taken" check and the console's lookup by address use this. A pointer that already names an
 * account goes through `getAccount`, never here.
 *
 * In this order: the login index `login:{e}` names a person; else (no index yet) the address's own records. Either way
 * the owner record must hold the address as its own (`ownsLogin`, rule 1981) and the member record too, its person id
 * matching. An email is unique across `user:` and `member:` (enforced under `lock:login:{email}`); should both ever
 * exist, the owner record wins, as in `currentUser`. A member record that is not on its owner's roster (the owner
 * deleted, or the record outlived a removal) is no login at all: it cannot sign in, and it does not keep the address
 * from signing up.
 *
 * Multi-workspace M1 (plan reconciliation 4): the person is read with the records (`person:` in the same rounds, the
 * precedence and stale guard of `personFromRaw`), and its address must be this one. When neither legacy record holds,
 * a person with a `person:` row is an owner when `orgs:{pid}` names an account `ownerOf` gives to them, else a member of
 * their oldest live membership (`listOrgs`, re-checked on the forward records); with none of them the address is nobody's
 * (reconciliation 7: exactly today's answer for a removed member).
 *
 * Rounds: round 1 as R1 (`login:`, `user:{e}`, `member:{e}`) plus `person:{e}`, one more command in the same round. An
 * index naming another id costs the one more round R1 already paid, now reading `user:`, `person:` and `member:` of that
 * id together. A legacy member pays R1's roster round; only a person no legacy record backs pays the `orgs:` rounds.
 */
export async function getLogin(email: string): Promise<Login | null> {
  const e = normalizeEmail(email);
  const [{ getMember, onRoster, memberPid }, { personFromRaw }, { legacyHomeFrom, listOrgs, ownerOf }] = await Promise.all([import("./team"), import("./person"), import("./membership")]);
  // The address as a person id (a legacy owner's or member's, while `OPAQUE_IDS` is off), and the id the index names.
  const self = storedPersonId(e);
  const [idx, own, m, ownRow] = await Promise.all([readLoginIndex(e), getAccount(e), getMember(e), db.get<unknown>(personKey.person(self))]);
  const far = idx && idx.pid !== e ? storedPersonId(idx.pid) : null;
  const [u, row, farMember] = far ? await Promise.all([getAccount(far), db.get<unknown>(personKey.person(far)), db.get<unknown>(accountKey.member(far))]) : [own, ownRow, null];
  const pid = far ?? self;
  // The person must hold THIS address: a person row or record that names another one signs nobody in here.
  const here = (p: Person | null): p is Person => !!p && normalizeEmail(p.email) === e;
  if (u && ownsLogin(u, e, idx)) {
    // The owner's own record backs the person (never the member record at the same address).
    const person = personFromRaw(pid, row, u, null);
    if (here(person)) return { kind: "owner", user: u, pid, person, acct: storedAccountId(acct(u)) };
  }
  if (m && normalizeEmail(m.email) === e && memberHolds(memberPid(m), e, idx)) {
    const [owner, listed] = await Promise.all([getAccount(m.memberOf), onRoster(m.memberOf, e)]);
    const person = listed ? personFromRaw(pid, row, null, m) : null;
    if (here(person)) return { kind: "member", member: m, owner, pid, person, acct: m.memberOf ? storedAccountId(m.memberOf) : null };
  }
  // Neither legacy record holds: a person read as `getPerson` reads it, through its forward records only. Only a person
  // no legacy record backs (a `p_` person) signs in this way: a legacy owner or member whose own record no longer holds
  // the address (an account that moved, a member removed from the roster) gets nothing, as in R1, even though its
  // credentials are mirrored on a `person:` row (rule 2132).
  const legacyRec = far ? farMember : m;
  const person = personFromRaw(pid, row, u, legacyRec);
  if (!here(person) || person.source !== "person" || legacyHomeFrom(pid, u, legacyRec)) return null;
  const orgs = await listOrgs(pid);
  const owned = orgs.find((o) => o.role === "owner");
  const first = owned ?? orgs[0];
  // Multi-workspace M2 (rules 2124, 2126; spec section 7 "no workspace"): a `p_` person whose last workspace was left,
  // removed or deleted still signs in, with no account, and picks or creates one on the workspaces page; the address
  // stays taken, so a sign-up or an invite accept cannot claim it again. With `MULTI_ORG` off such a person was deleted
  // with its last membership (plan reconciliation 7) and nothing reaches here.
  if (!first) return MULTI_ORG ? { kind: "member", member: null, owner: null, pid, person, acct: null } : null;
  const account = await getAccount(first.aid);
  if (!account || acct(account) !== first.aid) return null;
  if (owned) return ownerOf(account) === pid ? { kind: "owner", user: account, pid, person, acct: first.aid } : null;
  return { kind: "member", member: null, owner: account, pid, person, acct: first.aid };
}
/**
 * The account a sign-in address owns, or null (a member's address, or nobody's). For the founder console's routes that
 * name an account by its address in the URL or body (rule 1982): the address is resolved, never used as the key.
 */
export async function accountByLogin(email: string): Promise<User | null> {
  const l = await getLogin(email);
  return l?.kind === "owner" ? l.user : null;
}

/**
 * Founder accounts: ADMIN_EMAILS (comma-separated). Fails closed: with the variable unset or empty no email is a
 * founder, and only the console key (WAITLIST_ADMIN_KEY) opens the console. There is no default address in the code,
 * so a fresh or restored database, a preview or a fork never hands the console to whoever registers a listed email.
 * Rule 425, tests/launch-security.test.ts.
 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => normalizeEmail(e)).filter(Boolean);
}
export const isFounder = (email: string | undefined | null) => !!email && adminEmails().includes(normalizeEmail(email));
/**
 * The founder console follows the ACTOR, not the account: the owner login itself, in ADMIN_EMAILS. A member of the
 * founder's own account (whose `u.email` is the founder's) and a founder impersonating someone never pass.
 */
export const isFounderActor = (u: User | null | undefined) => !!u?.actor && u.actor.kind === "owner" && u.actor.email === u.email && isFounder(u.actor.email);

/**
 * The founder console's key session (rules 420-424, 435, tests/launch-security.test.ts).
 *
 * The key form (POST /api/admin/login) used to put WAITLIST_ADMIN_KEY itself in this cookie for 30 days, so anyone who
 * copied the cookie held the master key, and "log out" only deleted it in one browser. Now the cookie holds a random
 * 32-byte id; the server keeps `adminsession:{sha256(id)}` with a fingerprint of the key it was opened with. Logging out
 * deletes the record, so a copied cookie dies with it; rotating the key changes the fingerprint and ends every key
 * session at once; removing the key disables the path. The raw key in the cookie is no longer accepted. The record is
 * stored under a hash of the id, so a read of the database does not hand out live cookies.
 *
 * Lifetime (founder decision 2026-10-01): the session ends after 15 minutes of inactivity (`ADMIN_SESSION_IDLE`) and
 * never lives past 12 hours from the key entry (`ADMIN_SESSION_MAX`). Every admin request that finds the session live,
 * and every request through a customer impersonation it opened (`keyImpLive`), renews it, at most once a minute per
 * session (`ADMIN_SESSION_RENEW`), with one
 * `SET XX EX` that rewrites `seen` and the record's TTL; a request inside that minute writes nothing. The idle window
 * therefore counts from the last renewal: between 14 and 15 minutes after the last request, never longer. The record's
 * TTL never runs past the 12-hour cap, and both limits are also checked in code against `at` and `seen`, so a record
 * written before this change (12-hour TTL, no `seen`) is held to them too. The cookie carries the absolute cap only
 * (12 hours, not renewed: a server component cannot set cookies); the record is what enforces the idle limit.
 */
export const ADMIN_COOKIE = "nashr_admin";
/** Idle limit: the key session ends after this many seconds without an admin request. */
export const ADMIN_SESSION_IDLE = 60 * 15;
/** Absolute limit: no key session outlives this many seconds from the key entry, however busy. */
export const ADMIN_SESSION_MAX = 60 * 60 * 12;
/** A live session is renewed at most once per this many seconds, so a burst of console calls costs one write. */
export const ADMIN_SESSION_RENEW = 60;
type AdminSession = { kp: string; at: number; seen?: number };
const adminKeyPrint = (key: string) => createHash("sha256").update(`nashr-admin-key:${key}`).digest("hex");
const adminSessionKey = (id: string) => `adminsession:${createHash("sha256").update(id).digest("hex")}`;
/** The key session's limits, kept by the shared idle-session logic (src/lib/idle-session.ts) the staff session uses too. */
const ADMIN_LIMITS: IdleLimits = { idle: ADMIN_SESSION_IDLE, max: ADMIN_SESSION_MAX, renew: ADMIN_SESSION_RENEW };
/** Both limits checked in code, whatever TTL the record was stored with. */
const adminSessionInTime = (rec: AdminSession, now: number) => idleInTime(rec, now, ADMIN_LIMITS);

/** Open a key session for the current key and set its cookie. The caller has already checked the key. */
export async function createAdminSession(): Promise<string> {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (!key) throw new Error("WAITLIST_ADMIN_KEY is not set");
  const id = randomBytes(32).toString("hex");
  const now = Date.now();
  await db.set(adminSessionKey(id), { kp: adminKeyPrint(key), at: now, seen: now } satisfies AdminSession, ADMIN_SESSION_IDLE);
  const jar = await cookies();
  jar.set(ADMIN_COOKIE, id, await sessionCookie(ADMIN_SESSION_MAX));
  return id;
}

/**
 * True when the caller's `nashr_admin` cookie names a live key session opened with the CURRENT key, inside both the
 * idle and the absolute limit. A live session is renewed here (every admin request passes through this check), at
 * most once per `ADMIN_SESSION_RENEW` seconds, with one `setXx`: it rewrites only a record that still exists, so a
 * renewal racing a logout never brings the session back.
 */
export async function adminKeySession(): Promise<boolean> {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (!key) return false;
  const id = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return false;
  const k = adminSessionKey(id);
  const rec = await db.get<AdminSession>(k);
  if (!rec || typeof rec.kp !== "string") return false;
  const { sameSecret } = await import("./rate");
  if (!sameSecret(rec.kp, adminKeyPrint(key))) return false;
  const now = Date.now();
  if (!adminSessionInTime(rec, now)) return false;
  await renewAdminSession(k, rec, now);
  return true;
}

/**
 * Renew a live key session record: at most once per `ADMIN_SESSION_RENEW` seconds (a request inside that minute writes
 * nothing), one `setXx` that rewrites `seen` and the TTL (the idle window cut at the 12-hour cap) only while the record
 * still exists, so a renewal racing a logout never brings it back. A failed renewal only shortens the session; it never
 * fails the request it rode on.
 */
async function renewAdminSession(k: string, rec: AdminSession, now: number): Promise<void> {
  await renewIdle(k, { kp: rec.kp, at: rec.at, ...(typeof rec.seen === "number" ? { seen: rec.seen } : {}) } satisfies AdminSession, now, ADMIN_LIMITS);
}

/**
 * What ties an impersonation session opened with the console key to that key (rule 429): `kp`, the key's fingerprint,
 * and, when the console's key session opened it, `as`, the hash its server record is stored under. Without this the
 * 2-hour customer session outlived both "End key session" and a key rotation. Null when no key is set.
 */
export async function keyImpBinding(): Promise<{ kp: string; as?: string } | null> {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (!key) return null;
  const id = (await cookies()).get(ADMIN_COOKIE)?.value;
  const as = id && /^[0-9a-f]{64}$/.test(id) && (await adminKeySession()) ? createHash("sha256").update(id).digest("hex") : null;
  return as ? { kp: adminKeyPrint(key), as } : { kp: adminKeyPrint(key) };
}

/**
 * An `imp: "key"` session works only while the key that opened it is still the current key and, when a key session
 * opened it, while that key session is still live. A record without `kp` (written before this check) is refused.
 *
 * The founder working in the customer view is not idle (founder decision 2026-10-01: the key session ends after 15
 * minutes of INACTIVITY), so a request through an impersonation opened from a key session renews that key session the
 * same way an admin request does (`renewAdminSession`: at most once a minute, `SET XX`, never past the 12-hour cap).
 * The impersonation itself still ends 2 hours after it began, at "End key session", at a key rotation, and 15 minutes
 * after the founder's last request on either side (rules 429, 435).
 */
async function keyImpLive(s: Session): Promise<boolean> {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (!key || typeof s.kp !== "string") return false;
  const { sameSecret } = await import("./rate");
  if (!sameSecret(s.kp, adminKeyPrint(key))) return false;
  if (typeof s.as !== "string") return true;
  if (!/^[0-9a-f]{64}$/.test(s.as)) return false;
  const k = `adminsession:${s.as}`;
  const rec = await db.get<AdminSession>(k);
  if (!rec || typeof rec.kp !== "string" || !sameSecret(rec.kp, s.kp)) return false;
  const now = Date.now();
  if (!adminSessionInTime(rec, now)) return false;
  await renewAdminSession(k, rec, now);
  return true;
}

/**
 * A customer view opened from a staff session (rule 1648): live only while that staff session is, for the same person.
 * Checking it renews the staff session, so working in the customer view keeps it from going idle.
 */
async function staffImpLive(s: Session): Promise<boolean> {
  if (typeof s.ss !== "string" || typeof s.imp !== "string") return false;
  const { staffSessionLive } = await import("./staff-session");
  return staffSessionLive(s.ss, s.imp);
}

/** Log the key session out: the server record goes, so the same cookie value never works again. */
export async function destroyAdminSession(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(ADMIN_COOKIE)?.value;
  if (id && /^[0-9a-f]{64}$/.test(id)) await db.del(adminSessionKey(id));
  jar.delete(ADMIN_COOKIE);
}

/**
 * How the console actor of a request was resolved (rule 1638): a staff session, the key session, the `x-admin-key`
 * header, or the founder's customer session (expand only, rule 1649). Runtime only, never stored.
 */
export type ConsoleVia = "staff" | "key" | "header" | "founder-session";
/** `role` and `staffCookie` for a staff actor only: what the write gate's role check and the staff step-up read. */
export type ActorInfo = { who: string; via: ConsoleVia; role?: string; staffCookie?: string; fresh?: boolean };
const actors = new WeakMap<Request, ActorInfo>();
/** What `adminActor` found for this request, or null when it was not called or found nobody. */
export const actorInfo = (req: Request): ActorInfo | null => actors.get(req) ?? null;
/** The `via` of this request's console actor, for `adminAudit`. */
export const viaOf = (req: Request): ConsoleVia | null => actors.get(req)?.via ?? null;
/**
 * The console role of this request's actor, for `staffMay` in src/lib/roles.ts (rule 2078): a staff session's stored
 * role (none stored: null, refused); the key, the key header and the founder's customer session are the founder, "owner".
 * Null when `adminActor` was not called or found nobody.
 */
export function consoleRole(req: Request): string | null {
  const i = actors.get(req);
  if (!i) return null;
  return i.via === "staff" ? (typeof i.role === "string" ? i.role : null) : "owner";
}
/**
 * The write gate accepted a code typed for THIS request (`x-admin-otp`): the request already carries a fresh code, which
 * is what staff management, the customer-path switch and own credential changes need (rule 1636). The code's step is
 * burned by then, so the route must not ask for it a second time.
 */
export function markFreshCode(req: Request): void {
  const i = actors.get(req);
  if (i) i.fresh = true;
}

/**
 * The session's account for the console checks only: `currentUser` WITHOUT the page's brand selector (rule 886). Who
 * holds the console is a property of the session, not of a brand, so a stale or forged `x-thakeen-brand` on an admin
 * request (a wrong value is Next's 404 in `currentUser`) must not turn a staff, key or founder session away. The brand
 * is not read from the result: only `isFounderActor` is.
 */
export async function sessionAccountForConsole(): Promise<User | null> {
  const s = await readSession();
  return s ? resolveSession(s) : null;
}

/**
 * Whether the founder's own customer session still opens the console: an expand-only path (rule 1649) that a staff
 * owner can switch off at runtime (rule 1650, `staff:config.customerPathOff`) and the contract release removes.
 */
async function founderSessionConsole(): Promise<{ email: string } | null> {
  const { customerPathOff } = await import("./staff");
  const [off, u] = await Promise.all([customerPathOff(), sessionAccountForConsole()]);
  return !off && isFounderActor(u) ? { email: u!.actor!.email } : null;
}

/**
 * Who is acting in the founder console, in this order: "key" for the `x-admin-key` header (scripts, never the URL:
 * query strings end up in logs and history); the staff email for a live staff session (rules 1630-1636); "key" for a
 * key session; the founder's email for a founder's own customer session while that path is open (rule 1649); null for
 * anyone else. The signature stays a string, so the callers do not change; the details for the request (how, the
 * staff role, the staff cookie) are kept in a WeakMap that `secondFactorRefusal` and `adminAudit` callers read
 * (`actorInfo`, `viaOf`). No MCP token, OAuth grant or agent tool is ever a console actor (rule 1653): only these
 * cookies and the header are read.
 */
export async function adminActor(req: Request): Promise<string | null> {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (key) {
    const { sameSecret, allow, clientIp } = await import("./rate");
    const given = req.headers.get("x-admin-key");
    if (given !== null) {
      // Key guesses sent as a header are throttled like the login form.
      if (!(await allow(`adminhdr:${clientIp(req)}`, 30, 900))) return null;
      if (sameSecret(given, key)) {
        actors.set(req, { who: "key", via: "header" });
        return "key";
      }
    }
  }
  const { readStaffSession } = await import("./staff-session");
  const staff = await readStaffSession();
  if (staff) {
    actors.set(req, { who: staff.email, via: "staff", role: staff.staff.role, staffCookie: staff.cookie });
    return staff.email;
  }
  if (key && (await adminKeySession())) {
    actors.set(req, { who: "key", via: "key" });
    return "key";
  }
  const founder = await founderSessionConsole();
  if (founder) {
    actors.set(req, { who: founder.email, via: "founder-session" });
    return founder.email;
  }
  return null;
}

/** API access: the header key, a staff session, a key session, or the founder's own session (`adminActor`). */
export async function isAdmin(req: Request) {
  return (await adminActor(req)) !== null;
}

/** Who holds the console in this browser (pages): a staff session, a key session, the founder's customer session. */
export type ConsoleIdentity = { staff: { email: string; name: string; role: string } | null; keySession: boolean; founder: boolean };
export async function consoleIdentity(): Promise<ConsoleIdentity> {
  const { readStaffSession } = await import("./staff-session");
  const [s, keySession, founder] = await Promise.all([readStaffSession(), adminKeySession(), founderSessionConsole()]);
  return { staff: s ? { email: s.email, name: s.staff.name, role: s.staff.role } : null, keySession, founder: !!founder };
}

/** Page access: a staff session, a key session, or the founder's own session while that path is open. */
export async function isAdminCookie() {
  const id = await consoleIdentity();
  return !!id.staff || id.keySession || id.founder;
}
