import { NextResponse } from "next/server";
import { publicBy } from "./actor";
import type { Layer, Revision, StoreError } from "./instructions-store";

/**
 * The status of a refused store call. `busy` (the workspace's lock was not taken), `no_draft` (nothing to activate: the
 * state moved) and a plan limit met at activation or restore are 409, as spec 9 says; an id that is not in this
 * workspace's own history is 404; everything else is a refused value (length, count, target, screen) and is 400.
 * A plan limit cannot come back from a draft save (a draft is not checked against the plan); it is the answer of activate and restore.
 */
export const PLAN_ERRORS: ReadonlySet<StoreError> = new Set<StoreError>(["instructions_limit", "per_agent_plan", "refs_plan"]);
export function statusOf(error: StoreError): number {
  if (error === "busy" || error === "no_draft" || PLAN_ERRORS.has(error)) return 409;
  if (error === "not_found") return 404;
  return 400;
}

/** The JSON answer of a refused store call: `{ ok: false, error, index? }` with the status above. */
export const refused = (r: { error: StoreError; index?: number }) =>
  NextResponse.json({ ok: false, error: r.error, ...(r.index !== undefined ? { index: r.index } : {}) }, { status: statusOf(r.error) });

/**
 * A stored `by` keeps `imp` (who impersonated: the founder's console login, or "key"), which a member must never read.
 * Everything these routes send goes through these, as governance's `historyView` and `publicActivity` do: a support
 * session shows as "founder" with the account's email and nothing else. `before`/`after`/`diff` hold items, which carry
 * no `by`, so they pass as they are.
 */
export const publicLayer = (l: Layer): Layer => ({ ...l, by: l.by ? publicBy(l.by) : null });
export const publicRevision = (r: Revision): Revision => ({ ...r, by: publicBy(r.by) });
