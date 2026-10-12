import { randomBytes } from "crypto";
import { db } from "./db";
import { getUser, saveUser, trialOver, type OnboardHold, type User } from "./auth";
import type { AgentId } from "./agents";
import { allowanceOf, topupsSold, type Plan } from "./pricing";
import { addMonthly, newLot, returnCredits, setMonthly, spendCredits, MAX_LIVE_TOPUPS, type Receipt, type TopupLot, type TopupRequest } from "./topups";
import { billingLocked } from "./billing-state";
import { handPlanEnded } from "./hand-plan";
import { ksaDay } from "./partner-rules";
import { adminAudit } from "./admin-audit";

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
/**
 * What `refund` needs to lower the counter a metered charge raised, and to put the credits back where they came from
 * (`from`, present when the charge took from a top-up pack, src/lib/topups.ts). A metered charge's result is one.
 */
export type SpendRef = { scope: string; agent: AgentId; month: string; from?: Receipt };

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
  // The month's plan credits first, then top-up packs by earliest expiry; the receipt says which packs (rule 441).
  const from = spendCredits(u, cost);
  if (!meta) return { out: { ok: true, credits: u.credits }, dirty: true };
  const after = spent + cost;
  // A new month starts every counter from zero; only this month's are kept.
  const book = u.agentSpend?.month === month ? u.agentSpend : { month, by: {} };
  book.by[meta.scope] = { ...book.by[meta.scope], [meta.agent]: after };
  u.agentSpend = book;
  const warn80 = cap !== undefined && cap > 0 && spent < cap * 0.8 && after >= cap * 0.8;
  return { out: { ok: true, credits: u.credits, scope: meta.scope, agent: meta.agent, month, spent: after, ...(cap !== undefined ? { cap } : {}), warn80, ...(from ? { from } : {}) }, dirty: true };
}

/**
 * Add (or remove) credits atomically, to the month's plan credits (src/lib/topups.ts `addMonthly`). Balance never goes
 * below zero, and a negative delta never takes a top-up pack's credits. Returns the new balance. Agent counters are
 * untouched.
 */
export async function adjust(email: string, delta: number): Promise<number> {
  if (!Number.isFinite(delta)) throw new Error(`invalid_delta:${String(delta)}`);
  return withUserLock(email, async (u) => {
    addMonthly(u, delta);
    await saveUser(u);
    return u.credits;
  });
}

// ---- Top-up packs: the founder's side (src/lib/topups.ts, rules 446-447; with the payment, rule 454) ----

/**
 * What the founder records when a pack is paid for (`parseTopup`), who activated it, and the request's payment id
 * (src/lib/partners.ts `addPaidTopup` always sends one, so a retried request finds its pack instead of adding another).
 */
export type TopupInput = TopupRequest & { by: string; paymentId?: string };
/** `plan`: the account's plan under the lock, which the pack's payment is recorded with. `already`: a retried request. */
export type TopupChange =
  | { ok: true; lot: TopupLot; before: number; credits: number; removed?: number; plan?: Plan; already?: boolean }
  | { ok: false; error: "topup_needs_paid_plan" | "too_many_topups" | "topup_not_found" };

/**
 * Activate a pack on the account (POST /api/admin/topups, through `addPaidTopup`), under the ledger lock: the pack's
 * credits join the balance at once and stay valid TOPUP_VALID_DAYS from now. A request whose payment id is already on a
 * live pack returns that pack (`already`) and changes nothing. Refused on a trial (top-ups are sold to paid plans only)
 * and past MAX_LIVE_TOPUPS live packs. The caller validates the input (`parseTopup`).
 */
export async function addTopup(email: string, input: TopupInput, now = Date.now()): Promise<TopupChange> {
  return withUserLock(email, async (u): Promise<TopupChange> => {
    const credits = Number.isFinite(u.credits) ? Math.max(0, Math.trunc(u.credits)) : 0;
    const same = input.paymentId ? (u.topups ?? []).find((l) => l.paymentId === input.paymentId) : undefined;
    if (same) return { ok: true, lot: same, before: credits, credits, plan: u.plan, already: true };
    if (!topupsSold(u.plan)) return { ok: false, error: "topup_needs_paid_plan" };
    if ((u.topups?.length ?? 0) >= MAX_LIVE_TOPUPS) return { ok: false, error: "too_many_topups" };
    const before = Number.isFinite(u.credits) ? Math.max(0, Math.trunc(u.credits)) : 0;
    const lot = newLot({ id: randomBytes(8).toString("hex"), ...input }, now);
    u.topups = [...(u.topups ?? []), lot];
    u.credits = before + lot.credits;
    await saveUser(u);
    return { ok: true, lot, before, credits: u.credits, plan: u.plan };
  });
}

/**
 * Void a pack (a payment reversed, a pack recorded by mistake): its unspent credits leave the balance and the pack is
 * removed, so it no longer counts in top-up revenue either. Credits already spent from it stay spent; a later refund of
 * one of those charges finds no pack and goes to the month's plan credits (src/lib/topups.ts `returnCredits`, rule 461).
 */
export async function voidTopup(email: string, id: string): Promise<TopupChange> {
  return withUserLock(email, async (u): Promise<TopupChange> => {
    const lot = (u.topups ?? []).find((l) => l.id === id);
    if (!lot) return { ok: false, error: "topup_not_found" };
    const before = Number.isFinite(u.credits) ? Math.max(0, Math.trunc(u.credits)) : 0;
    const removed = Math.min(Math.max(0, Math.trunc(lot.left) || 0), before);
    u.credits = before - removed;
    const rest = (u.topups ?? []).filter((l) => l.id !== id);
    if (rest.length) u.topups = rest;
    else delete u.topups;
    await saveUser(u);
    return { ok: true, lot, before, credits: u.credits, removed };
  });
}

/**
 * The daily cron's top-up sweep: `getUser` settles packs on every read (an expired pack leaves the balance the moment it
 * expires), and this writes a record whose stored packs were behind (`topupsDirty`) back under the lock, so an account
 * nobody touches does not keep an expired pack in storage. Returns whether it saved.
 */
export async function saveSettledTopups(email: string): Promise<{ saved: boolean; credits: number }> {
  return withUserLock(email, async (u) => {
    if (!u.topupsDirty) return { saved: false, credits: u.credits };
    await saveUser(u);
    return { saved: true, credits: u.credits };
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

/**
 * The body of a metered `refund`, on the record read under the lock. Credits go back where the charge took them from
 * (`spend.from`, src/lib/topups.ts `returnCredits`): the share of a pack that expired, was voided or was refunded since
 * goes to the month's plan credits (founder decision of 2026-10-02, rule 461).
 */
function giveBack(u: User, n: number, spend: SpendRef) {
  const delta = Math.trunc(n);
  if (delta > 0) returnCredits(u, delta, spend.from);
  else addMonthly(u, delta);
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
    const hold: OnboardHold = { scope: meta.scope, agent: meta.agent, month: out.month, credits: cost, at, ...(out.from ? { from: out.from } : {}) };
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
 *
 * By model tier (plan Task 4, review round 1): a hold is reused only when its credits are exactly `cost`. A retry priced
 * differently (the killed run was on another model) gives the old hold back and charges `cost` in the SAME save, so there
 * is no moment with nothing held and the batch never runs on credits priced for another model (`replaced`: the credits
 * given back). When `cost` cannot be paid even with the old hold given back, nothing is saved: the refusal reports the
 * balance as it was, and the old hold stays for the daily sweep (`resolveOnceHolds`, rule 337), never stranded.
 */
export const PAID_ONCE_MS = 8 * 864e5;
export type OnceCharge =
  | (Extract<AgentCharge, { ok: true }> & { reused: false; replaced?: number })
  | { ok: true; reused: true; credits: number; hold: OnboardHold }
  | Exclude<AgentCharge, { ok: true }>;
/** A hold's credits as a refund reads them: a whole number of at least 0. */
const heldCredits = (h: OnboardHold) => (Number.isFinite(h.credits) ? Math.max(0, Math.trunc(h.credits)) : 0);
export async function chargeOnce(email: string, cost: number, meta: SpendMeta, claim: string): Promise<OnceCharge> {
  if (!Number.isFinite(cost) || cost < 0) throw new Error(`invalid_cost:${String(cost)}`);
  return withUserLock(email, async (u): Promise<OnceCharge> => {
    const balance = Number.isFinite(u.credits) ? u.credits : 0;
    const held = u.paidOnce?.[claim];
    if (held && held.credits === cost) return { ok: true, reused: true, credits: balance, hold: held };
    // A hold of another price (or a malformed one, given back as `refundOnce` would): given back in memory first, so the
    // debit below sees its credits and its agent counter lowered; saved together with the new charge, or not at all.
    const replaced = held ? heldCredits(held) : undefined;
    const spentBefore = agentSpendFor(u, meta.scope)[meta.agent] ?? 0;
    if (held) giveBack(u, replaced!, held);
    const { out, dirty } = debit(u, cost, meta);
    if (!out.ok || !("month" in out)) {
      // Nothing is saved, so the refusal reports the record as it is: the balance and, at the agent's cap, the spend with
      // the old hold still in it, not the figures the in-memory give-back left.
      const refused = out as Exclude<AgentCharge, { ok: true }>;
      if (held) return refused.reason === "agent_cap" ? { ...refused, credits: balance, spent: spentBefore } : { ...refused, credits: balance };
      if (dirty) await saveUser(u);
      return refused;
    }
    const now = Date.now();
    // An old hold's charge is spent for good: dropped here, so the record keeps only the live ones. A malformed time
    // (NaN) is not "recent" either.
    const live = Object.entries(u.paidOnce ?? {}).filter(([, h]) => now - new Date(h.at).getTime() < PAID_ONCE_MS);
    // `from`: the top-up packs the charge took from, so a refund puts the credits back there (rule 442).
    u.paidOnce = { ...Object.fromEntries(live), [claim]: { scope: meta.scope, agent: meta.agent, month: out.month, credits: cost, at: new Date(now).toISOString(), ...(out.from ? { from: out.from } : {}) } };
    await saveUser(u);
    return { ...out, reused: false, ...(replaced !== undefined ? { replaced } : {}) };
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
    const n = heldCredits(hold);
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
 * Bill a chat message past the month's allowance (src/lib/chat-allowance.ts), in one save under the user lock. Nothing
 * is taken before the turn: a hold would come out of the balance the turn's own tools spend (a batch asked for in that
 * message), so the gate only checks the balance covers `maxCredits`. After it, the turn's metered cost (`usdMicro`, its
 * model calls in micro-USD) is added to the account's unbilled carry, and every whole credit of it at the floor rate
 * (`creditMicro`, `maxCostPerCreditUsd`) is billed, at most `maxCredits` and at most what the balance still holds. The
 * carry keeps the remainder (always less than one credit), so a run of cheap messages is billed what they cost, not a
 * credit each; cost beyond `maxCredits`, or beyond a balance the turn's tools emptied, is never billed. Returns the
 * balance and what was billed.
 */
export async function settleChatOverflow(email: string, maxCredits: number, usdMicro: number, creditMicro: number): Promise<{ credits: number; charged: number }> {
  if (!Number.isSafeInteger(maxCredits) || maxCredits < 0) throw new Error(`invalid_hold:${String(maxCredits)}`);
  if (!Number.isFinite(creditMicro) || creditMicro < 1) throw new Error(`invalid_rate:${String(creditMicro)}`);
  if (!Number.isFinite(usdMicro) || usdMicro < 0) throw new Error(`invalid_cost:${String(usdMicro)}`);
  return withUserLock(email, async (u) => {
    const price = Math.round(creditMicro);
    const current = Number.isFinite(u.credits) ? Math.max(0, u.credits) : 0;
    const before = typeof u.chatCarryMicro === "number" && Number.isFinite(u.chatCarryMicro) && u.chatCarryMicro > 0 ? u.chatCarryMicro : 0;
    const carry = before + Math.round(usdMicro);
    const owed = Math.min(maxCredits, Math.floor(carry / price));
    const charged = Math.min(owed, current);
    u.chatCarryMicro = Math.min(carry - owed * price, price - 1);
    u.credits = current;
    // Like every charge: the month's plan credits first, then top-up packs by earliest expiry (rule 441).
    spendCredits(u, charged);
    await saveUser(u);
    return { credits: u.credits, charged };
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
 * neither is a stored plan `getUser` could not recognise (it reads as trial). Rule 243, tests/pricing.test.ts. Only the
 * month's plan credits are reset: top-up packs keep what is left in them (`setMonthly`, rule 443).
 */
export async function renewIfDue(email: string): Promise<boolean> {
  const hand = await withUserLock(email, async (u) => {
    if (!renewalDue(u)) return null;
    const before = Number(u.credits) || 0;
    // Only the month's plan credits: live top-up packs keep what is left in them (rule 443).
    setMonthly(u, allowanceOf(u));
    u.renewedAt = monthKey();
    await saveUser(u);
    // A Paymob subscription's month has its payment record; a plan set by hand has none, so its grant is written below.
    return u.billing ? false : { plan: u.plan, before, after: u.credits, month: u.renewedAt, paidThrough: u.handPlan?.paidThrough ?? null };
  });
  if (hand === null) return false;
  // Every month of credits a hand-set plan receives leaves a row in the founder's log (rule 1244, 360 study G-012): who
  // granted (the system, for the founder's plan), the plan, the balance before and after, and the paid-through day (none
  // for a plan set before paid-through days existed). After the save: a failed log write never undoes the month.
  if (hand) {
    await adminAudit({
      actor: "system", section: "billing", action: "hand_refill", target: email,
      what: `hand_refill plan:${hand.plan} month:${hand.month} credits:${hand.after} paid_through:${hand.paidThrough ?? "none"}`,
      before: { credits: hand.before }, after: { credits: hand.after, paidThrough: hand.paidThrough },
    }).catch((e) => console.error("hand refill log", e instanceof Error ? e.name : "error"));
  }
  return true;
}

/**
 * Whether `renewIfDue` would renew this record now: a paid plan whose last renewal (or, before the first, its creation)
 * is not in the current UTC month. A copy read before the lock may only skip the lock: `renewedAt` only moves forward,
 * so a copy that says "not due" is never wrong, and one that says "due" is checked again under the lock. A Paymob
 * subscription locked for an unpaid renewal gets no new month (rule 712): paying again gives it the month's credits.
 * A plan set by hand gets no new month after its paid-through day (Riyadh, `handPlanEnded`, rule 1243); one set before
 * paid-through days existed has none and refills as before (the expand step of rule 679).
 */
export const renewalDue = (u: Pick<User, "plan" | "renewedAt" | "createdAt" | "billing" | "handPlan">, month = monthKey(), today = ksaDay()) =>
  u.plan !== "trial" && !billingLocked(u.billing) && !handPlanEnded(u, today) && (u.renewedAt ?? u.createdAt.slice(0, 7)) !== month;
