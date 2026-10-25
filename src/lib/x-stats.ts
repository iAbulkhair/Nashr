import { db } from "./db";
import { sc, trialOver, type User } from "./auth";
import { chargeOnce, personOf, refundOnce, renewIfDue, renewalDue, type SpendMeta } from "./credits";
import { getGov } from "./governance";
import { warnAgentCap } from "./notifications";
import { isComposio } from "./connectors/composio-shape";
import type { Connection } from "./connectors/store";
import { X_READ_CREDITS, XUnavailable, readX } from "./connectors/x";
import { SOCIAL_PUB_KEY, XSTATS_KEY, day } from "./social-read/common";
import { upsertHistory, type PlatformPart, type XStats } from "./social-stats";
import { log } from "./log";
import { acct } from "./account-id";

/**
 * The X account's results, read on a click and paid by the account (rules 744, 745, spec
 * docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md C3). No scheduled read: X bills every read, so the
 * daily social sync never reads it and never touches its key. The money is checked here, in code, before X is asked.
 */
export { XSTATS_KEY };
export type { XStats };

/** The wait passed on with a 429 when X gave none: its rate windows are 15 minutes. */
export const X_RETRY_DEFAULT_S = 900;

export type XRefresh =
  | { ok: true; x: XStats; charged: boolean }
  | { ok: false; status: 402 | 409 | 429 | 502; error: string; retryAfter?: number; extra?: Record<string, number> };

/** The workspace's last X read, or null when X was never read (or the account was deleted). */
export async function getXStats(scope: string): Promise<XStats | null> {
  return db.get<XStats>(XSTATS_KEY(scope));
}

/** Drops the workspace's X read and its history, when X is disconnected (rule 747). */
export async function dropXStats(scope: string): Promise<void> {
  await db.del(XSTATS_KEY(scope));
}

/**
 * Whether a new X read is the stored read's account (rule 746): the X user ids decide when both reads carry one, so a
 * renamed handle keeps its history; when either has none (a read stored before the id, the expand step of rule 679), the
 * handles decide, and only when both were read.
 */
function sameAccount(held: XStats | null, part: PlatformPart): boolean {
  if (held?.accountId && part.accountId) return held.accountId === part.accountId;
  return !held?.account || !part.account || held.account === part.account;
}

/** An X read as the browser gets it (the route's answer, the Reports page): without the account's id (rule 746). */
export function xForPage(x: XStats): Omit<XStats, "accountId"> {
  const { accountId: _id, ...shown } = x;
  void _id;
  return shown;
}

/** Whether `x` was read on the UTC day `today` (YYYY-MM-DD). */
const readOn = (x: XStats | null, today: string) => typeof x?.at === "string" && x.at.slice(0, 10) === today;

/**
 * One refresh, in the spec's order: (1) the route already took the fresh connection; (2) a Composio-routed record is
 * refused (409 `x_direct_only`) before any charge; (3) a read dated today (UTC) is returned with no charge and no call;
 * (4) an ended trial is refused; (5) a paid account's month is renewed first, as every charge does (rule 332); (6) one
 * credit is charged to the account record (`u.email`, also for a member) under Dana's monthly cap, held once per
 * workspace per UTC day (`xread:{scope}:{day}`), so two clicks at once debit one credit and the second reads on the
 * first's hold; (7) X is read; (8) the read is saved in one set, its monthly history upserted (rule 746): kept when the
 * stored and the new read carry the same X user id (a renamed handle), dropped when the ids differ, and, when either
 * has none (a read stored before the id, the expand step of rule 679), kept unless both handles were read and differ.
 *
 * Only the click that took the charge gives it back: any failure after the charge (a refused token, X's 402, 403 or
 * 429, a 5xx, a timeout, a malformed answer, the save) refunds once (`refundOnce` drops the hold in the same save),
 * unless a read dated today exists by then (another click's read landed, and the charge stands for it; one landing in
 * the moment between that check and the refund, its own charge a no-op on the hold, stays free). A click that
 * reused the hold never refunds; once its read is saved it takes the charge again when the hold is gone by then (the
 * charging click failed first), so one credit stands for the day's read; a hold still standing makes that a no-op, and a
 * refused charge (no credits, Dana's cap) leaves that read free. A click stopped after its charge with no catch run (the
 * platform's limit), or whose refund fails (logged `x_refund_failed`, the click still answered as X's failure), leaves its
 * hold: a later click that day reads on it, and if none succeeds the credit stands, as no sweep covers `xread:`. A read with no posts is a success (X billed the account read). X's 402, 403 and 429 are the
 * app's state, answered here (429 with X's own wait, rule 680); every other error is thrown to the route, whose
 * `refusedToken` asks the owner to reconnect only on X's 401.
 */
export async function refreshX(u: User, c: Connection, now = new Date()): Promise<XRefresh> {
  if (isComposio(c)) return { ok: false, status: 409, error: "x_direct_only" };
  const scope = sc(u);
  const today = day(now);
  const held = await getXStats(scope);
  if (held && readOn(held, today)) return { ok: true, x: held, charged: false };
  if (trialOver(u)) return { ok: false, status: 402, error: "trial_over" };
  if (renewalDue(u)) await renewIfDue(acct(u));
  const claim = `xread:${scope}:${today}`;
  const spend: SpendMeta = { scope, agent: "dana", cap: (await getGov(scope)).agentCaps.dana, person: personOf(u) };
  const paid = await chargeOnce(acct(u), X_READ_CREDITS, spend, claim);
  if (!paid.ok && paid.reason === "agent_cap") return { ok: false, status: 402, error: "agent_cap", extra: { spent: paid.spent, cap: paid.cap } };
  if (!paid.ok) return { ok: false, status: 402, error: "no_credits", extra: { need: X_READ_CREDITS, credits: paid.credits } };
  // A reused hold was warned about by the click that took it; warnAgentCap never throws.
  if (!paid.reused) await warnAgentCap(u, paid);

  let x: XStats;
  try {
    const [part, mine] = await Promise.all([readX(c, now), db.smembers(SOCIAL_PUB_KEY(scope))]);
    const ours = new Set(mine);
    x = {
      ...part,
      platform: "x",
      posts: part.posts.map((p) => ({ ...p, fromThakeen: ours.has(p.id) })),
      at: now.toISOString(),
      history: upsertHistory(sameAccount(held, part) && Array.isArray(held?.history) ? held.history : [], [part], now),
    };
    await db.set(XSTATS_KEY(scope), x);
  } catch (e) {
    if (!paid.reused) {
      const landed = await getXStats(scope).catch(() => null);
      // A refund that fails (the user lock timed out) must not hide X's own answer: the route still answers this
      // failure, and the hold it leaves is the credit standing for the day, as for a click stopped after its charge.
      if (!readOn(landed, today)) await refundOnce(acct(u), claim).catch(() => log.error("x_refund_failed"));
    }
    if (e instanceof XUnavailable && e.status === 429) return { ok: false, status: 429, error: "x_unavailable", retryAfter: e.retryAfter ?? X_RETRY_DEFAULT_S };
    if (e instanceof XUnavailable) return { ok: false, status: 502, error: "x_unavailable" };
    throw e;
  }
  if (!paid.reused) return { ok: true, x, charged: true };
  // The hold this click read on may have been given back meanwhile (the click that took it failed before this read
  // landed): the read that landed takes the charge again. While the hold stands this debits nothing.
  const again = await chargeOnce(acct(u), X_READ_CREDITS, spend, claim).catch(() => {
    log.error("x_recharge_failed");
    return null;
  });
  const charged = !!again?.ok && !again.reused;
  if (again?.ok && !again.reused) await warnAgentCap(u, again);
  return { ok: true, x, charged };
}
