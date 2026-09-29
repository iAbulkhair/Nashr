import { db } from "./db";
import { PLAN_CREDITS, getUser, saveUser, type User } from "./auth";

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

export type ChargeResult = { ok: true; credits: number } | { ok: false; credits: number; need: number };

/**
 * Atomically reserve `cost` credits. Fails without changing the balance when insufficient.
 *
 * The balance and the cost are both checked for being real numbers first. Every comparison against NaN is false, so a
 * single non-numeric cost would otherwise pass the "enough credits" test at a zero balance AND write NaN into the
 * record, after which the account can never be charged correctly again. The callers validate their input, and this is
 * the ledger refusing to be the place where that ever matters.
 */
export async function charge(email: string, cost: number): Promise<ChargeResult> {
  if (!Number.isFinite(cost) || cost < 0) throw new Error(`invalid_cost:${String(cost)}`);
  return withUserLock(email, async (u) => {
    // Repair a record damaged before this guard existed — and write the repair back. The insufficient-credits path
    // returns without saving, so correcting the balance only in memory left NaN in the record for ever: every later
    // charge re-read NaN, repaired it again, refused again, and the account could never spend or be topped up past
    // a number it could not compare. The in-memory store used to hand out the stored object itself, which made the
    // missing save invisible to the test that covers this.
    const damaged = !Number.isFinite(u.credits);
    if (damaged) u.credits = 0;
    if (u.credits < cost) {
      if (damaged) await saveUser(u);
      return { ok: false, credits: u.credits, need: cost };
    }
    u.credits -= cost;
    await saveUser(u);
    return { ok: true, credits: u.credits };
  });
}

/** Add (or remove) credits atomically. Balance never goes below zero. Returns the new balance. */
export async function adjust(email: string, delta: number): Promise<number> {
  if (!Number.isFinite(delta)) throw new Error(`invalid_delta:${String(delta)}`);
  return withUserLock(email, async (u) => {
    const current = Number.isFinite(u.credits) ? u.credits : 0;
    u.credits = Math.max(0, current + Math.trunc(delta));
    await saveUser(u);
    return u.credits;
  });
}

export const refund = (email: string, n: number) => adjust(email, n);

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
