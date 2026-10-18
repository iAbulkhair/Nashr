import { cookies, headers } from "next/headers";
import { isSuspended, type StoredSuspension } from "./suspension";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { idleInTime, renewIdle, type IdleLimits } from "./idle-session";
import type { AgentId } from "./agents";
import type { Member } from "./team";
import { PLAN_CREDITS, planFromStore, type AgencyDeal, type Plan } from "./pricing";
import { settleTopups, type Receipt, type TopupLot } from "./topups";
import { billingLocked, type Billing } from "./billing-state";
import { signupConsent, type Consent } from "./consent";
import type { HandPlan } from "./hand-plan";
import type { FoundingSeat, PriceLock } from "./founding";
import { SESSION_COOKIE, dropCookie, dropLegacyCookie, namesOf, readCookie } from "./cookie-names";
import { accountKey, globalKey, storedScope, type Scope } from "./keys";

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
  email: string;
  name: string;
  phone: string;
  passHash: string;
  plan: Plan;
  credits: number;
  trialEnds: string; // ISO
  createdAt: string; // ISO
  lang: "ar" | "en";
  /** YYYY-MM of the last monthly credit renewal (paid plans). */
  renewedAt?: string;
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
export const sc = (u: User): Scope => storedScope(u.scope ?? u.email);

const SESSION_TTL = 60 * 60 * 24 * 30;
// `thakeen_session`, read with the old `nashr_session` as a fallback during the rename (rule 1810, src/lib/cookie-names.ts).
const COOKIE = SESSION_COOKIE;

/** Whole days left in a trial (0 when it has ended). Server-side: the clock is read per request here, never inside a component. */
/**
 * An ended trial may not spend. Written once because it was written five times: the image route and the chat's
 * generate_image tool were the two spending paths that never got a copy, so an expired trial went on paying for
 * fal.ai and Anthropic calls indefinitely. A Paymob subscription locked after its failed renewal's grace (rule 712)
 * stops the same way, through every gate that already reads this.
 */
export const trialOver = (u: Pick<User, "plan" | "trialEnds" | "billing">) => (u.plan === "trial" && new Date(u.trialEnds) < new Date()) || billingLocked(u.billing);

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
 * The only reader of `user:{email}`. The stored plan is mapped on read (src/lib/pricing.ts `planFromStore`): the retired
 * "enterprise" reads as "agency", and any other unknown value as "trial", so no caller ever sees a plan outside `PLANS`.
 * Top-up packs are settled the same way (`settleTopups`: expired packs leave the balance). The next locked save writes
 * the mapped value back.
 */
export async function getUser(email: string): Promise<User | null> {
  const u = await db.get<User>(accountKey.user(normalizeEmail(email)));
  if (u) {
    u.plan = planFromStore(u.plan);
    // An expired top-up pack leaves the balance as it expires, not at the next cron (src/lib/topups.ts, rule 444).
    if (settleTopups(u)) u.topupsDirty = true;
  }
  return u;
}

/** Owner accounts only. Members live at `member:{email}` (src/lib/team.ts) and never pass through here or `users:all`. */
export async function saveUser(u: User) {
  // The runtime-only fields: the active scope and who is acting are per request, never part of the account.
  const { scope: _s, brandId: _b, actor: _a, topupsDirty: _t, ...persist } = u;
  void _s; void _b; void _a; void _t;
  await db.set(accountKey.user(u.email), persist);
  await db.sadd(globalKey.usersAll(), u.email);
}

export async function createUser(input: { email: string; name: string; phone: string; password: string; lang: "ar" | "en" }): Promise<User> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const u: User = {
    email,
    name: input.name.trim().slice(0, 80),
    phone: input.phone.trim() ? normalizePhone(input.phone) : "",
    passHash: await bcrypt.hash(input.password, 10),
    plan: "trial",
    credits: PLAN_CREDITS.trial,
    trialEnds: new Date(now.getTime() + 3 * 864e5).toISOString(),
    createdAt: now.toISOString(),
    lang: input.lang,
    // Sessions cannot be enumerated, so a deleted account's cookies outlive it. Stamping the creation time kills every
    // session issued before this account existed: a re-registered address never inherits an old login.
    sessionsAfter: now.toISOString(),
    gatedSignup: true,
    // What the signup notice under the form named, from the versions in code (rule 1325).
    consent: signupConsent(input.lang, now),
  };
  await saveUser(u);
  return u;
}

export async function verifyPassword(u: User, password: string) {
  return bcrypt.compare(password, u.passHash);
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
export type Session = { email: string; at: number; imp?: string; kp?: string; as?: string; exp?: number; ss?: string };
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
  // An impersonation carries its end (`exp`, rule 1177), the same moment its TTL ends.
  const rec: Session = opts.imp ? { email, at: now, imp: opts.imp, exp: now + ttlSeconds * 1000, ...(opts.kp ? { kp: opts.kp } : {}), ...(opts.as ? { as: opts.as } : {}), ...(opts.ss ? { ss: opts.ss } : {}) } : { email, at: now };
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

export async function currentUser(): Promise<User | null> {
  const s = await readSession();
  return s ? resolveSession(s) : null;
}

/**
 * Like `currentUser`, but an owner who has not verified the address yet resolves too. Only the verify page, the verify
 * routes and the app layout may call it (rule 752, pinned by tests/email-verify-gate.test.ts): every other caller keeps
 * `currentUser`, where such an owner reads as signed out.
 */
export async function currentUserUnverified(): Promise<User | null> {
  const s = await readSession();
  return s ? resolveSession(s, { unverified: true }) : null;
}

/**
 * Turn a session into the ACCOUNT record with `actor` set (docs/superpowers/specs/2026-09-29-teams-design.md §3).
 *
 * The account is always the owner's `User`, so every `sc(u)`, charge and plan check keeps working unchanged. Scope is
 * built from the OWNER email: a member's own address never becomes a workspace key. A member is refused when disabled,
 * when the session predates their own or the team's revocation stamp, when the owner is gone, suspended or has not
 * verified the address (rule 767), when the member is not on the owner's roster (`members:{owner}`), or when the member record predates the owner record (a
 * re-registered owner address never inherits an old team).
 */
async function resolveSession(s: Session, opts: { unverified?: boolean } = {}): Promise<User | null> {
  const email = normalizeEmail(s.email);
  const [{ getMember, onRoster }, { activeBrandId, listBrands, scopeFor }] = await Promise.all([import("./team"), import("./brands")]);
  // The active brand is per login (`activebrand:{login}`), so it is read in the same round as the login records.
  const [u, m, brandId] = await Promise.all([getUser(email), getMember(email), activeBrandId(email)]);
  if (u) {
    if (isSuspended(u)) return null;
    if (issuedBefore(s.at, u.sessionsAfter)) return null; // issued before the last password change (or before the account existed)
    if (issuedBefore(s.at, u.devicesAfter)) return null; // issued before the owner's last "sign out other devices" (rule 1170)
    // The verification gate (rule 751): an owner who has not proved the address is signed out for every caller except
    // `currentUserUnverified`. A founder impersonation passes (support must reach the account). A member login (below)
    // is gated by its owner's state too (rule 767).
    if (!emailVerified(u) && !s.imp && !opts.unverified) return null;
    u.brandId = brandId;
    u.scope = scopeFor(u.email, brandId);
    const base = { email: u.email, name: u.name, lang: u.lang, role: "owner" as const };
    if (s.imp && typeof s.exp === "number" && Date.now() >= s.exp) return null; // the founder's chosen length is over (rule 1177)
    u.actor = s.imp
      ? { ...base, kind: "founder", impersonating: s.imp, since: s.at, until: typeof s.exp === "number" ? s.exp : s.at + IMPERSONATION_LEGACY_MS }
      : { ...base, kind: "owner" };
    return u;
  }
  // Member login. Impersonation sessions are only ever issued for owner accounts.
  if (!m || s.imp || m.disabled) return null;
  if (m.role !== "admin" && m.role !== "member") return null;
  if (typeof m.memberOf !== "string" || !m.memberOf || m.memberOf === email) return null;
  if (issuedBefore(s.at, m.sessionsAfter) || issuedBefore(s.at, m.devicesAfter)) return null;
  // The roster entry too, in the same round: removal deletes both under `lock:member`, and a record that outlived its
  // entry anyway (restored by a racing write, left by a deleted account) is off the owner's Members page, so it must
  // not sign in either.
  const [owner, brands, listed] = await Promise.all([getUser(m.memberOf), listBrands(m.memberOf), onRoster(m.memberOf, email)]);
  if (!owner || isSuspended(owner) || !listed) return null;
  // Rule 767: while the owner has not proved the address, the account spends nothing, so its members are signed out too,
  // in both resolvers. A member has no address of the owner's to prove, so `currentUserUnverified` never hands one to the
  // verify page: they read as signed out, and login answers `owner_unverified`. (Impersonation never reaches this branch.)
  if (!emailVerified(owner)) return null;
  if (issuedBefore(s.at, owner.teamSessionsAfter)) return null;
  // NaN on either side (a malformed date) refuses too.
  if (!(new Date(m.acceptedAt).getTime() >= new Date(owner.createdAt).getTime())) return null;
  // The member's own active brand, but only while it is one of the owner's active brands.
  const bid = brands.some((b) => b.id === brandId && b.status === "active") ? brandId : "default";
  owner.brandId = bid;
  owner.scope = scopeFor(owner.email, bid);
  owner.actor = { kind: "member", email: m.email, name: m.name, lang: m.lang === "en" ? "en" : "ar", role: m.role };
  return owner;
}

/** A login: an owner account, or a member login with the account it belongs to (null when that owner is gone). */
export type Login = { kind: "owner"; user: User } | { kind: "member"; member: Member; owner: User | null };
/**
 * What an email signs in as. Login, forgot, reset and signup use this. An email is unique across `user:` and `member:`
 * (enforced under `lock:login:{email}`); should both ever exist, the owner record wins, as in `currentUser`. A member
 * record that is not on its owner's roster (the owner deleted, or the record outlived a removal) is no login at all:
 * it cannot sign in, and it does not keep the address from signing up.
 */
export async function getLogin(email: string): Promise<Login | null> {
  const e = normalizeEmail(email);
  const { getMember, onRoster } = await import("./team");
  const [u, m] = await Promise.all([getUser(e), getMember(e)]);
  if (u) return { kind: "owner", user: u };
  if (!m) return null;
  const [owner, listed] = await Promise.all([getUser(m.memberOf), onRoster(m.memberOf, e)]);
  return listed ? { kind: "member", member: m, owner } : null;
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
 * Whether the founder's own customer session still opens the console: an expand-only path (rule 1649) that a staff
 * owner can switch off at runtime (rule 1650, `staff:config.customerPathOff`) and the contract release removes.
 */
async function founderSessionConsole(): Promise<{ email: string } | null> {
  const { customerPathOff } = await import("./staff");
  const [off, u] = await Promise.all([customerPathOff(), currentUser()]);
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
