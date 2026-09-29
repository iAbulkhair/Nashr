import { db } from "./db";
import { PLAN_CREDITS, getUser, saveUser, type User } from "./auth";
import type { AgentId } from "./agents";

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
    // Repair a record damaged before this guard existed — and write the repair back. The insufficient-credits path
    // returns without saving, so correcting the balance only in memory left NaN in the record for ever: every later
    // charge re-read NaN, repaired it again, refused again, and the account could never spend or be topped up past
    // a number it could not compare. The in-memory store used to hand out the stored object itself, which made the
    // missing save invisible to the test that covers this.
    const damaged = !Number.isFinite(u.credits);
    if (damaged) u.credits = 0;
    const month = monthKey();
    const cap = capOf(meta?.cap);
    const spent = meta ? (agentSpendFor(u, meta.scope, month)[meta.agent] ?? 0) : 0;
    if (meta && cap !== undefined && spent + cost > cap) {
      if (damaged) await saveUser(u);
      return { ok: false, reason: "agent_cap", credits: u.credits, agent: meta.agent, spent, cap };
    }
    if (u.credits < cost) {
      if (damaged) await saveUser(u);
      return { ok: false, reason: "no_credits", credits: u.credits, need: cost };
    }
    u.credits -= cost;
    if (!meta) {
      await saveUser(u);
      return { ok: true, credits: u.credits };
    }
    const after = spent + cost;
    // A new month starts every counter from zero; only this month's are kept.
    const book = u.agentSpend?.month === month ? u.agentSpend : { month, by: {} };
    book.by[meta.scope] = { ...book.by[meta.scope], [meta.agent]: after };
    u.agentSpend = book;
    await saveUser(u);
    const warn80 = cap !== undefined && cap > 0 && spent < cap * 0.8 && after >= cap * 0.8;
    return { ok: true, credits: u.credits, scope: meta.scope, agent: meta.agent, month, spent: after, ...(cap !== undefined ? { cap } : {}), warn80 };
  });
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
    const current = Number.isFinite(u.credits) ? u.credits : 0;
    const delta = Math.trunc(n);
    u.credits = Math.max(0, current + delta);
    const mine = u.agentSpend?.month === spend.month ? u.agentSpend.by[spend.scope] : undefined;
    if (mine && typeof mine[spend.agent] === "number") mine[spend.agent] = Math.max(0, mine[spend.agent]! - Math.max(0, delta));
    await saveUser(u);
    return u.credits;
  });
}

/** The UTC calendar month, YYYY-MM. Agent counters roll at 00:00 UTC on the 1st; `renewIfDue` runs later, at the 05:00 UTC daily cron. */
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Monthly renewal for paid plans: on the first cron run of a new month the
 * balance is reset to the plan allowance (unused credits do not roll over,
 * same as Enrich). Trial users are never renewed.
 */
export async function renewIfDue(email: string): Promise<boolean> {
  return withUserLock(email, async (u) => {
    if (u.plan === "trial") return false;
    const m = monthKey();
    if ((u.renewedAt ?? u.createdAt.slice(0, 7)) === m) return false;
    u.credits = PLAN_CREDITS[u.plan];
    u.renewedAt = m;
    await saveUser(u);
    return true;
  });
}
