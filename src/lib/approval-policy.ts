import type { User } from "./auth";
import type { Task } from "./brand";
import { brandOfScope } from "./account-id";
import type { PersonId } from "./keys";
import { aidOf, getMembership, membershipHolds, ownerOf, type Membership } from "./membership";
import { pidFrom } from "./team";

/**
 * May this membership approve items of brand `bid` now (rule 3760)? An admin, or an Editor or Viewer the owner or an admin
 * let approve, still holding the account (not paused, not left, not older than the account), with `bid` in its scope.
 */
export function membershipApproves(account: User, m: Membership | null, bid: string): boolean {
  if (!m || !membershipHolds(account, m)) return false;
  if (m.role !== "admin" && m.approves !== true) return false;
  return !m.brands || m.brands.includes(bid);
}

/** May person `pid` approve items of brand `bid` now: the owner always, anyone else through `membershipApproves`. */
export async function mayApprove(account: User, pid: string, bid: string): Promise<boolean> {
  const p: PersonId = pidFrom(pid);
  if (p === ownerOf(account)) return true;
  return membershipApproves(account, await getMembership(aidOf(account), p), bid);
}

/**
 * The approval policy (rule 3762), checked by `publishOnce` on the copy that is sent, under the publish lock. Off (the
 * default) → null. On → the item must be approved by someone who may approve its brand NOW (`approvedBy`; a person
 * paused, removed, narrowed to other brands or no longer allowed to approve since does not count), or be pending and
 * published by such a person (`by`, the session's own person, never a request field): publishing a pending item is its
 * approval. An item approved before the policy was on carries no `approvedBy` and is approved again first.
 */
export async function approvalRefusal(account: User | null, scope: string, t: Pick<Task, "status" | "approvedBy">, by?: string): Promise<"approval_required" | null> {
  if (!account || account.approvalRequired !== true) return null;
  const bid = brandOfScope(scope);
  if (t.status === "approved" && t.approvedBy?.pid && (await mayApprove(account, t.approvedBy.pid, bid))) return null;
  if (t.status === "pending" && by && (await mayApprove(account, by, bid))) return null;
  return "approval_required";
}
