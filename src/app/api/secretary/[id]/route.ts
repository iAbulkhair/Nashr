import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { can, forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { getTask } from "@/lib/brand";
import { OWNER_ONLY, SEC_ID, SEC_WRITES_PER_HOUR, calFor, changeItem, parseOwnerChange } from "@/lib/secretary";

/**
 * The owner's change to one item of the active brand: update fields (a reminder `remindAt`, a they-owe contact's
 * `phone` included), complete (a result is required), snooze (presets 2h, tonight, tomorrow, nextweek), reschedule,
 * confirm or reject a proposed "done", delete (soft, 30 days), restore, reopen a done item, add a note, record a
 * follow-up (`chased`: the chase clock restarts, the item stays open). This route is the only way an item becomes done,
 * apart from the linked-approval rule in code. The id must match `SEC_ID` before any key is built and must exist under
 * `sc(u)`: another account's id is 404 and stays untouched. `rev`, when sent, must match. Dates are read in the brand's
 * zone, on its work calendar (read once, `calFor`): "next week" starts on the brand's week start, and a chase clock
 * counts its working days. Roles: any member changes items (`todo.write`); closing, confirming or sending back a claim,
 * deleting, restoring and reopening need the owner or an admin (`todo.close`).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "todo.write");
  if (no) return no;
  const { id } = await ctx.params;
  if (!SEC_ID.test(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return retryLater({ ok: false, error: "too_many" }, 3600);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const b = body as Record<string, unknown>;
  const scope = sc(u);
  // Dates in the body are the brand's local time, read with its work calendar, once, and passed on.
  const now = Date.now();
  const { zone, cal } = await calFor(scope, now);
  const change = parseOwnerChange(b, now, zone, cal);
  if ("ok" in change) return NextResponse.json({ ok: false, error: change.error, ...(change.field ? { field: change.field } : {}) }, { status: change.status });
  if (OWNER_ONLY.has(change.action) && !can(u, "todo.close")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  // A new link must name an inbox item of this same brand.
  if (change.action === "update" && change.fields.taskId && !(await getTask(scope, change.fields.taskId))) return NextResponse.json({ ok: false, error: "unknown_task", field: "taskId" }, { status: 400 });
  const rev = typeof b.rev === "number" && Number.isInteger(b.rev) ? b.rev : undefined;
  const r = await changeItem(scope, id, change, { actor: "owner", via: "web", login: u.actor?.email }, rev, zone, cal);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}), ...(r.error === "conflict" && r.item ? { item: r.item } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true, item: r.item });
}
