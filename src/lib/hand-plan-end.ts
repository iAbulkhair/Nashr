import { saveUser } from "./auth";
import { withUserLock } from "./credits";
import { handPlanEnded } from "./hand-plan";
import { ksaDay } from "./partner-rules";
import { adminAudit } from "./admin-audit";
import { log } from "./log";

/**
 * A plan the founder set by hand moves to the trial state once its paid-through day has passed (founder decision
 * 2026-10-19, rule 2274). Run by the daily job for each account, on its default brand's entry, before the credit renewal.
 *
 * Under the ledger lock and only when it still holds there: a paid plan (not the trial), no online subscription, and a
 * paid-through day (`User.handPlan.paidThrough`) before today in Riyadh (`handPlanEnded`). An account without a
 * paid-through day, an online subscription and a trial are never touched. What changes: `plan` becomes "trial" and
 * `trialEnds` is put a second in the past when it is not already past, so the account is an ended trial (`trialOver`)
 * exactly as after a refund (rule 1300). What does not: no data is deleted. Brands, posts, files, conversations, members
 * and invites stay; so do the balance, the top-up packs, an Agency deal, the seat and chat overrides and `handPlan`
 * itself (the console keeps showing the day it ended, and the account keeps its money history for the address rules of
 * src/lib/email-change.ts). Nothing can be spent meanwhile: every gate reads `trialOver`. Setting a plan again in the
 * console (`POST /api/admin/plan`) restores the plan, its credits and its seats exactly as for any trial account.
 *
 * Stored shape (rule 2275, the expand step of rule 679): no new field. The record keeps the shape it had; only the
 * values of `plan` and `trialEnds` change, to ones every build already reads ("trial", an ISO time). A record written
 * by this code and read by an older build is an ended trial there too.
 *
 * Once: a second run finds the trial and changes nothing. One `hand_plan_ended` row in the founder's log, after the
 * save (a failed log write never undoes the change). Answers whether it changed the account.
 */
export async function endHandPlanIfDue(email: string, now = Date.now()): Promise<boolean> {
  const today = ksaDay(now);
  const change = await withUserLock(email, async (u) => {
    // `handPlanEnded` is false for the trial, an online subscription and a record without a paid-through day.
    if (!handPlanEnded(u, today)) return null;
    const before = { plan: String(u.plan), trialEnds: u.trialEnds, paidThrough: u.handPlan!.paidThrough, credits: Number(u.credits) || 0 };
    u.plan = "trial";
    // A second in the past, as the refund does: `trialOver` compares strictly.
    if (!(new Date(u.trialEnds).getTime() < now)) u.trialEnds = new Date(now - 1000).toISOString();
    await saveUser(u);
    return { before, after: { plan: u.plan, trialEnds: u.trialEnds, paidThrough: before.paidThrough, credits: Number(u.credits) || 0 } };
  });
  if (!change) return false;
  await adminAudit({
    actor: "system", section: "billing", action: "hand_plan_ended", target: email,
    what: `hand_plan_ended plan:${change.before.plan} paid_through:${change.before.paidThrough} credits:${change.before.credits}`,
    before: change.before, after: change.after,
  }).catch((e) => log.error("hand plan end log", e));
  return true;
}
