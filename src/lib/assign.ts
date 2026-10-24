import { db } from "./db";
import { log } from "./log";
import { accountOfScope, brandOfScope } from "./account-id";
import { getAccount, type User } from "./auth";
import { membershipApproves } from "./approval-policy";
import { wsKey, type PersonId, type Scope } from "./keys";
import { aidOf, ownerOf, type Membership } from "./membership";
import { getPerson } from "./person";
import { pushNotif } from "./notifications";
import { rosterMemberships } from "./team";
import type { Task } from "./brand";

/**
 * Who may approve an item of brand `bid` (rules 3760, 3764): the owner, then every member `membershipApproves` lets
 * approve that brand now. Ordered by person id so the turn counter walks the same list on every call.
 */
export function approversFor(account: User, members: readonly Membership[], bid: string): PersonId[] {
  const owner = ownerOf(account);
  const ok = members.filter((m) => m.pid !== owner && membershipApproves(account, m, bid)).map((m) => m.pid).sort();
  return [owner, ...ok];
}

/**
 * Give a fresh agent draft an assignee (rule 3764): one approver of its brand, in turn, and one bell entry naming them.
 * Called by `saveTask` for a new pending task with no assignee, before the task is written. An account with no team (the
 * roster is empty) is left alone after two reads: the owner is the only approver and an assignee would say nothing. Best
 * effort: a failed read leaves the draft unassigned and never stops the save. The scope is the task's own, from our
 * records, never a request.
 */
export async function autoAssign(scope: Scope, t: Task): Promise<void> {
  try {
    const account = await getAccount(accountOfScope(scope));
    if (!account) return;
    const rows = await rosterMemberships(aidOf(account));
    if (!rows.length) return;
    const list = approversFor(account, rows, brandOfScope(scope));
    const turn = await db.incrby(wsKey.assignTurn(scope), 1);
    const pid = list[(Math.max(1, turn) - 1) % list.length];
    t.assignee = { pid, at: new Date().toISOString() };
    const person = await getPerson(pid);
    const ar = (person?.lang ?? account.lang) !== "en";
    const name = person?.name || (ar ? "صاحب الحساب" : "the owner");
    await pushNotif(aidOf(account), {
      kind: "pending",
      title: ar ? `مسودة جديدة بانتظار ${name}` : `A new draft waits for ${name}`,
      body: ar ? "أُسندت للمراجعة والاعتماد، وتجدها في صندوق الموافقة." : "Assigned for review and approval. It is in the inbox.",
      href: "",
      // A bell label (who it was assigned to), not a Redis key.
      about: "assign:" + pid,
    }, undefined, 3, scope);
  } catch (e) {
    log.warn("auto-assign failed", { err: e instanceof Error ? e.message : "unknown" });
  }
}
