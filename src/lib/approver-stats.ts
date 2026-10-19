import { acct } from "./account-id";
import { CAPS } from "./db";
import { pmap } from "./parallel";
import { listBrands, scopeFor } from "./brands";
import { listDecisions, type Decision } from "./decisions";

/**
 * Who approved what, per person on the team (rules 1479, 1480): from the decision records (`decisions:{scope}`, each with
 * its `by` since 2026-09-29), never rebuilt from the tasks. For the team page, owner and admin only (`team.approvals.view`).
 *
 * `approved` counts approvals and publishes (a publish of an item not yet approved is that person's approval), `rejected`
 * rejections, `edited` saved edits. `rate`: approved out of approved plus rejected, 0..100, or null with neither. A record
 * without `by` is the owner's, as in the activity log. The founder's support access, a connected app (token) and the
 * system are nobody on the team and are left out.
 */
export type ApproverStat = { approved: number; rejected: number; edited: number; rate: number | null };
export const APPROVER_DAYS = 30;

/** Pure: the last `APPROVER_DAYS` of `ds`, keyed by the person's email (`owner` for the owner's own records). */
export function approverStats(ds: Decision[], owner: string, now: number): Record<string, ApproverStat> {
  const from = now - APPROVER_DAYS * 864e5;
  const out = new Map<string, ApproverStat>();
  for (const d of ds) {
    if (!(Date.parse(d.at) >= from)) continue;
    const kind = d.by?.kind ?? "owner";
    const who = kind === "owner" ? owner : kind === "member" ? d.by?.email : undefined;
    if (!who) continue;
    const s = out.get(who) ?? { approved: 0, rejected: 0, edited: 0, rate: null };
    if (d.action === "approve" || d.action === "publish") s.approved++;
    else if (d.action === "reject") s.rejected++;
    else if (d.action === "edit") s.edited++;
    out.set(who, s);
  }
  for (const s of out.values()) s.rate = s.approved + s.rejected ? Math.round((s.approved / (s.approved + s.rejected)) * 100) : null;
  return Object.fromEntries(out);
}

/**
 * The owner's team, across every brand of the account: one read per brand, in parallel. The account comes from the owner
 * record (`acct`, rule 1980), never a request's; the owner's own records are keyed by its sign-in address for the page.
 */
export async function teamApprovals(owner: { id?: string; email: string }, now: number = Date.now()): Promise<Record<string, ApproverStat>> {
  const id = acct(owner);
  const brands = await listBrands(id);
  const lists = await pmap(brands, (b) => listDecisions(scopeFor(id, b.id), CAPS.decisions));
  return approverStats(lists.flat(), owner.email, now);
}
