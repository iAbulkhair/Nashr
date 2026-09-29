import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { getTask } from "@/lib/brand";
import { SEC_ID, SEC_WRITES_PER_HOUR, changeItem, parseOwnerChange } from "@/lib/secretary";

/**
 * The owner's change to one item of the active brand: update fields, complete (a result is required), snooze,
 * reschedule, confirm or reject a proposed "done", delete (soft, 30 days), restore, add a note. This route is the only
 * way an item becomes done, apart from the linked-approval rule in code. The id must match `SEC_ID` before any key is
 * built and must exist under `sc(u)`: another account's id is 404 and stays untouched. `rev`, when sent, must match.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!SEC_ID.test(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const b = body as Record<string, unknown>;
  const scope = sc(u);
  const change = parseOwnerChange(b, Date.now());
  if ("ok" in change) return NextResponse.json({ ok: false, error: change.error, ...(change.field ? { field: change.field } : {}) }, { status: change.status });
  // A new link must name an inbox item of this same brand.
  if (change.action === "update" && change.fields.taskId && !(await getTask(scope, change.fields.taskId))) return NextResponse.json({ ok: false, error: "unknown_task", field: "taskId" }, { status: 400 });
  const rev = typeof b.rev === "number" && Number.isInteger(b.rev) ? b.rev : undefined;
  const r = await changeItem(scope, id, change, { actor: "owner", via: "web" }, rev);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}), ...(r.error === "conflict" && r.item ? { item: r.item } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true, item: r.item });
}
