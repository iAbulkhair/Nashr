import { db } from "./db";
import { getUser, saveUser, trialOver, type OnboardHold, type User } from "./auth";
import type { AgentId } from "./agents";
import { allowanceOf } from "./pricing";

/**
 * Credit ledger. Every balance change goes through a per-user lock so two
 * parallel requests cannot both pass the "enough credits" check (double spend).
 * Callers charge BEFORE the model call and refund if generation fails.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withUserLock<T>(email: string, fn: (u: User) => Promise<T>): Promise<T> {
  const key = `lock:user:${email}`;
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await sleep(50);
  }
  if (!got) throw new Error("user_lock_timeout");
  try {
    const u = await getUser(email);
    if (!u) throw new Error("user_not_found");
    return await fn(u);
  } finally {
    // A failed release must not turn a balance change that was saved into a throw: callers read a throw as "nothing
    // changed" (a charge answered busy while kept, a refund released for a second time). The 10 s TTL frees the lock.
    await db.unlock(key).catch((e) => console.error("user lock release failed", e instanceof Error ? e.name : "error"));
  }
}

/**
 * Who a charge is for: the brand scope it is spent in and the agent that owns the work (`agentForTask(type)`, computed in
 * code), plus the owner's monthly cap for that agent in that scope (`gov.agentCaps`), read by the caller before charging.
 */
export type SpendMeta = { scope: string; agent: AgentId; cap?: number };
/** What `refund` needs to lower the counter a metered charge raised. A metered charge's result is one. */
export type SpendRef = { scope: string; agent: AgentId; month: string };

type NoCredits = { ok: false; reason: "no_credits"; credits: number; need: number };
export type ChargeResult = { ok: true; credits: number } | NoCredits;
/** `spent` is this agent's total in this scope this month, after the charge; `warn80` is true on the charge that crossed 80% of the cap. */
export type AgentCharge =
  | (SpendRef & { ok: true; credits: number; spent: number; cap?: number; warn80: boolean })
  | NoCredits
  | { ok: false; reason: "agent_cap"; credits: number; agent: AgentId; spent: number; cap: number };

/** A cap is a finite number of at least 0; anything else (none set, NaN, negative) is no cap. */
export const capOf = (cap: number | undefined) => (typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : undefined);

/** This month's credits per agent in one brand scope. A record written in an earlier month counts as empty. */
export function agentSpendFor(u: Pick<User, "agentSpend">, scope: string, month = monthKey()): Partial<Record<AgentId, number>> {
  return u.agentSpend?.month === month ? { ...(u.agentSpend.by[scope] ?? {}) } : {};
}

/**
 * Atomically reserve `cost` credits. Fails without changing the balance when insufficient.
 *
 * The balance and the cost are both checked for being real numbers first. Every comparison against NaN is false, so a
 * single non-numeric cost would otherwise pass the "enough credits" test at a zero balance AND write NaN into the
 * record, after which the account can never be charged correctly again. The callers validate their input, and this is
 * the ledger refusing to be the place where that ever matters.
 *
 * With `meta`, the charge is also counted against the agent that owns the work in that brand scope, on the User record
 * itself (`agentSpend`), so the debit and the counter are one save under one lock: N parallel charges can never take an
 * agent past the owner's cap, and a crash cannot leave the two apart. Over the cap it refuses before the balance is
 * touched. Without `meta` (nothing calls it that way today) the counters are left alone.
 */
export function charge(email: string, cost: number): Promise<ChargeResult>;
export function charge(email: string, cost: number, meta: SpendMeta): Promise<AgentCharge>;
export async function charge(email: string, cost: number, meta?: SpendMeta): Promise<ChargeResult | AgentCharge> {
  if (!Number.isFinite(cost) || cost < 0) throw new Error(`invalid_cost:${String(cost)}`);
  return withUserLock(email, async (u): Promise<ChargeResult | AgentCharge> => {
    const { out, dirty } = debit(u, cost, meta);
    if (dirty) await saveUser(u);
    return out;
  });
}

/**
 * The body of `charge`, on the record read under the lock: changes it in memory and says whether it must be saved.
 *
 * Repair a record damaged before the guard in `charge` existed, and have it written back. The insufficient-credits path
 * returns without spending, so correcting the balance only in memory left NaN in the record for ever: every later charge
 * re-read NaN, repaired it again, refused again, and the account could never spend or be topped up past a number it could
 * not compare. The in-memory store used to hand out the stored object itself, which made the missing save invisible to
 * the test that covers this.
 */
function debit(u: User, cost: number, meta?: SpendMeta): { out: ChargeResult | AgentCharge; dirty: boolean } {
  const damaged = !Number.isFinite(u.credits);
  if (damaged) u.credits = 0;
  const month = monthKey();
  const cap = capOf(meta?.cap);
  const spent = meta ? (agentSpendFor(u, meta.scope, month)[meta.agent] ?? 0) : 0;
  if (meta && cap !== undefined && spent + cost > cap) {
    return { out: { ok: false, reason: "agent_cap", credits: u.credits, agent: meta.agent, spent, cap }, dirty: damaged };
  }
  if (u.credits < cost) return { out: { ok: false, reason: "no_credits", credits: u.credits, need: cost }, dirty: damaged };
  u.credits -= cost;
  if (!meta) return { out: { ok: true, credits: u.credits }, dirty: true };
  const after = spent + cost;
  // A new month starts every counter from zero; only this month's are kept.
  const book = u.agentSpend?.month === month ? u.agentSpend : { month, by: {} };
  book.by[meta.scope] = { ...book.by[meta.scope], [meta.agent]: after };
  u.agentSpend = book;
  const warn80 = cap !== undefined && cap > 0 && spent < cap * 0.8 && after >= cap * 0.8;
  return { out: { ok: true, credits: u.credits, scope: meta.scope, agent: meta.agent, month, spent: after, ...(cap !== undefined ? { cap } : {}), warn80 }, dirty: true };
}

/** Add (or remove) credits atomically. Balance never goes below zero. Returns the new balance. Agent counters are untouched. */
export async function adjust(email: string, delta: number): Promise<number> {
  if (!Number.isFinite(delta)) throw new Error(`invalid_delta:${String(delta)}`);
  return withUserLock(email, async (u) => {
    const current = Number.isFinite(u.credits) ? u.credits : 0;
    u.credits = Math.max(0, current + Math.trunc(delta));
    await saveUser(u);
    return u.credits;
  });
}

/**
 * Give credits back after a failed or placeholder result. After a metered charge pass its result as `spend`: the agent's
 * counter goes down by the same amount (never below 0) in the same save, but only while the record is still in the month
 * the charge was made in. A refund that lands after the month rolled over must not eat into the new month's counter.
 */
export async function refund(email: string, n: number, spend?: SpendRef): Promise<number> {
  if (!spend) return adjust(email, n);
  if (!Number.isFinite(n)) throw new Error(`invalid_delta:${String(n)}`);
  return withUserLock(email, async (u) => {
    giveBack(u, n, spend);
    await saveUser(u);
    return u.credits;
  });
}

/** The body of a metered `refund`, on the record read under the lock. */
function giveBack(u: User, n: number, spend: SpendRef) {
  const current = Number.isFinite(u.credits) ? u.credits : 0;
  const delta = Math.trunc(n);
  u.credits = Math.max(0, current + delta);
  const mine = u.agentSpend?.month === spend.month ? u.agentSpend.by[spend.scope] : undefined;
  if (mine && typeof mine[spend.agent] === "number") mine[spend.agent] = Math.max(0, mine[spend.agent]! - Math.max(0, delta));
}

/**
 * An added brand's onboarding charge (src/app/api/onboard/route.ts, ONBOARD_EXTRA_BRAND_COST) and its hold, as ONE save.
 *
 * The hold (`User.onboardPaid[scope]`) lives on the account record, next to the balance it was taken from: the debit and
 * the hold are written together, and `refundOnboard` gives the credits back and drops the hold together. A run that finds
 * a hold reuses it instead of charging (a run the platform killed at maxDuration runs no catch, and the chat page starts
 * the build again by itself while a confirmation exists), and restarts its clock, so the daily sweep never refunds a
 * charge a run is using. Only a run that charged or reused a hold can refund it, and only once: a second refund finds no
 * hold and gives back nothing. With no hold, an ended trial is refused here, in the same lock as the charge. Rule 246.
 */
export type OnboardCharge =
  | { ok: true; reused: true; credits: number; hold: OnboardHold }
  | (Extract<AgentCharge, { ok: true }> & { reused: false; hold: OnboardHold })
  | Exclude<AgentCharge, { ok: true }>
  | { ok: false; reason: "trial_over"; credits: number };
export async function chargeOnboard(email: string, cost: number, meta: SpendMeta): Promise<OnboardCharge> {
  if (!Number.isFinite(cost) || cost < 0) throw new Error(`invalid_cost:${String(cost)}`);
  return withUserLock(email, async (u): Promise<OnboardCharge> => {
    const at = new Date().toISOString();
    const held = u.onboardPaid?.[meta.scope];
    if (held) {
      u.onboardPaid = { ...u.onboardPaid, [meta.scope]: { ...held, at } };
      await saveUser(u);
      return { ok: true, reused: true, credits: u.credits, hold: u.onboardPaid[meta.scope] };
    }
    if (trialOver(u)) return { ok: false, reason: "trial_over", credits: Number.isFinite(u.credits) ? u.credits : 0 };
    const { out, dirty } = debit(u, cost, meta);
    if (!out.ok || !("month" in out)) {
      if (dirty) await saveUser(u);
      return out as Exclude<AgentCharge, { ok: true }>;
    }
    const hold: OnboardHold = { scope: meta.scope, agent: meta.agent, month: out.month, credits: cost, at };
    u.onboardPaid = { ...u.onboardPaid, [meta.scope]: hold };
    await saveUser(u);
    return { ...out, reused: false, hold };
  });
}

/** Drop the hold of `scope` from the record read under the lock, without a refund. */
function dropHold(u: User, scope: string) {
  if (!u.onboardPaid?.[scope]) return;
  const { [scope]: _gone, ...rest } = u.onboardPaid;
  void _gone;
  if (Object.keys(rest).length) u.onboardPaid = rest;
  else delete u.onboardPaid;
}

/**
 * Give back the held onboarding charge of `scope` and drop the hold, in one save. Null when there is no hold: nothing was
 * held, or another run already refunded it, so nothing is given back twice.
 */
export async function refundOnboard(email: string, scope: string): Promise<{ credits: number; refunded: number } | null> {
  return withUserLock(email, async (u) => {
    const hold = u.onboardPaid?.[scope];
    if (!hold) return null;
    const n = Number.isFinite(hold.credits) ? Math.max(0, Math.trunc(hold.credits)) : 0;
    giveBack(u, n, hold);
    dropHold(u, scope);
    await saveUser(u);
    return { credits: u.credits, refunded: n };
  });
}

/** The brand was built: the hold's charge is spent for good, so drop the hold (no refund). Nothing held: nothing written. */
export async function settleOnboard(email: string, scope: string): Promise<void> {
  await withUserLock(email, async (u) => {
    if (!u.onboardPaid?.[scope]) return;
    dropHold(u, scope);
    await saveUser(u);
  });
}

/**
 * A charge taken at most once per claim (rule 333): the Sunday plan's `weekly:{scope}:{week}`. The debit and the hold
 * (`User.paidOnce[claim]`) are one save under the ledger's lock, like `chargeOnboard`. A run that finds the hold reuses
 * it instead of charging: the platform kills a function at maxDuration without running any catch, so the weekly job
 * charged again on its retry and an owner paid twice for one plan. Only the run's own failure gives it back
 * (`refundOnce`), and only once. A hold stays after a success, so a retry that gets past the week's marker reuses it
 * rather than paying again; it is dropped once older than PAID_ONCE_MS, by the next `chargeOnce` of the account.
 */
export const PAID_ONCE_MS = 8 * 864e5;
export type OnceCharge =
  | (Extract<AgentCharge, { ok: true }> & { reused: false })
  | { ok: true; reused: true; credits: number; hold: OnboardHold }
  | Exclude<AgentCharge, { ok: true }>;
export async function chargeOnce(email: string, cost: number, meta: SpendMeta, claim: string): Promise<OnceCharge> {
  if (!Number.isFinite(cost) || cost < 0) throw new Error(`invalid_cost:${String(cost)}`);
  return withUserLock(email, async (u): Promise<OnceCharge> => {
    const held = u.paidOnce?.[claim];
    if (held) return { ok: true, reused: true, credits: Number.isFinite(u.credits) ? u.credits : 0, hold: held };
    const { out, dirty } = debit(u, cost, meta);
    if (!out.ok || !("month" in out)) {
      if (dirty) await saveUser(u);
      return out as Exclude<AgentCharge, { ok: true }>;
    }
    const now = Date.now();
    // An old hold's charge is spent for good: dropped here, so the record keeps only the live ones. A malformed time
    // (NaN) is not "recent" either.
    const live = Object.entries(u.paidOnce ?? {}).filter(([, h]) => now - new Date(h.at).getTime() < PAID_ONCE_MS);
    u.paidOnce = { ...Object.fromEntries(live), [claim]: { scope: meta.scope, agent: meta.agent, month: out.month, credits: cost, at: new Date(now).toISOString() } };
    await saveUser(u);
    return { ...out, reused: false };
  });
}

/**
 * Give back the charge held for `claim` and drop the hold, in one save. A second call finds no hold and gives back
 * nothing (`refunded: 0`), so a failure is refunded once however many paths report it.
 */
export async function refundOnce(email: string, claim: string): Promise<{ credits: number; refunded: number }> {
  return withUserLock(email, async (u) => {
    const hold = u.paidOnce?.[claim];
    if (!hold) return { credits: Number.isFinite(u.credits) ? u.credits : 0, refunded: 0 };
    const n = Number.isFinite(hold.credits) ? Math.max(0, Math.trunc(hold.credits)) : 0;
    giveBack(u, n, hold);
    const { [claim]: _gone, ...rest } = u.paidOnce!;
    void _gone;
    if (Object.keys(rest).length) u.paidOnce = rest;
    else delete u.paidOnce;
    await saveUser(u);
    return { credits: u.credits, refunded: n };
  });
}

/**
 * The daily sweep of the account's paid-once holds (rule 337, src/lib/schedule.ts `sweepWeeklyHolds`): `kept[claim]` says
 * whether the claim's work exists. A kept claim's hold is dropped (its charge stands); any other is refunded, a run killed
 * after its charge that no later run retried (the last catch-up, a "Run now" nobody pressed again). One save under the
 * ledger's lock; a hold already gone (refunded by its own run's failure, or reused and refunded since) is skipped, so
 * nothing is given back twice.
 */
export async function resolveOnceHolds(email: string, kept: Readonly<Record<string, boolean>>): Promise<{ refunded: HoldRefund[]; dropped: string[]; credits: number }> {
  return withUserLock(email, async (u) => {
    const done = { refunded: [] as HoldRefund[], dropped: [] as string[] };
    const left = { ...(u.paidOnce ?? {}) };
    for (const [claim, keep] of Object.entries(kept)) {
      const hold = left[claim];
      if (!hold) continue;
      if (keep) done.dropped.push(claim);
      else {
        const n = Number.isFinite(hold.credits) ? Math.max(0, Math.trunc(hold.credits)) : 0;
        giveBack(u, n, hold);
        done.refunded.push({ scope: hold.scope, agent: hold.agent, credits: n });
      }
      delete left[claim];
    }
    if (done.refunded.length || done.dropped.length) {
      if (Object.keys(left).length) u.paidOnce = left;
      else delete u.paidOnce;
      await saveUser(u);
    }
    return { ...done, credits: Number.isFinite(u.credits) ? u.credits : 0 };
  });
}

/** A hold nobody charged or reused for this long is resolved by the daily sweep: the confirmation's day. */
export const ONBOARD_HOLD_MS = 864e5;

/**
 * The daily sweep (src/app/api/cron/daily/route.ts): every hold of the account that no run charged or reused for
 * ONBOARD_HOLD_MS is resolved, in one save. `built[scope]` says whether that brand exists: a built brand's hold is dropped
 * (a success whose own drop failed), any other is refunded (a run killed before the brand was saved, whose owner never
 * came back). Returns each refund as the ledger made it (scope, agent, credits given back: the sweep's activity row), the
 * dropped scopes, and the balance after.
 */
export type HoldRefund = { scope: string; agent: AgentId; credits: number };
export async function resolveOnboardHolds(email: string, built: Readonly<Record<string, boolean>>, now = Date.now()): Promise<{ refunded: HoldRefund[]; dropped: string[]; credits: number }> {
  return withUserLock(email, async (u) => {
    const done = { refunded: [] as HoldRefund[], dropped: [] as string[] };
    for (const [scope, hold] of Object.entries(u.onboardPaid ?? {})) {
      const age = now - new Date(hold.at).getTime();
      if (age < ONBOARD_HOLD_MS) continue; // NaN (a malformed time) is not "recent": it is resolved
      if (built[scope]) done.dropped.push(scope);
      else {
        const n = Number.isFinite(hold.credits) ? Math.max(0, Math.trunc(hold.credits)) : 0;
        giveBack(u, n, hold);
        done.refunded.push({ scope, agent: hold.agent, credits: n });
      }
      dropHold(u, scope);
    }
    if (done.refunded.length || done.dropped.length) await saveUser(u);
    return { ...done, credits: u.credits };
  });
}

/**
 * The UTC calendar month, YYYY-MM. Agent counters roll at 00:00 UTC on the 1st; `renewIfDue` runs at the 05:00 UTC daily
 * cron and, since 2026-10-01, before the charge of every paid text batch (src/lib/generate-batch.ts, rule 332).
 */
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Monthly renewal for paid plans: on the first cron run or paid text batch of a new month, whichever comes first (rule
 * 332), the balance is reset to the account's allowance
 * (src/lib/pricing.ts `allowanceOf`: the plan's credits; for Agency, the deal's credits, or Business's when there is no
 * deal at or above the floor). Unused credits do not roll over, same as Enrich. Trial users are never renewed, and
 * neither is a stored plan `getUser` could not recognise (it reads as trial). Rule 243, tests/pricing.test.ts.
 */
export async function renewIfDue(email: string): Promise<boolean> {
  return withUserLock(email, async (u) => {
    if (!renewalDue(u)) return false;
    u.credits = allowanceOf(u);
    u.renewedAt = monthKey();
    await saveUser(u);
    return true;
  });
}

/**
 * Whether `renewIfDue` would renew this record now: a paid plan whose last renewal (or, before the first, its creation)
 * is not in the current UTC month. A copy read before the lock may only skip the lock: `renewedAt` only moves forward,
 * so a copy that says "not due" is never wrong, and one that says "due" is checked again under the lock.
 */
export const renewalDue = (u: Pick<User, "plan" | "renewedAt" | "createdAt">, month = monthKey()) => u.plan !== "trial" && (u.renewedAt ?? u.createdAt.slice(0, 7)) !== month;
