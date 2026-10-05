import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { SEC_WRITES_PER_HOUR } from "@/lib/secretary";
import { approveMeeting, liveBooking } from "@/lib/secretary-meeting";

/**
 * The owner approves some of the tasks proposed for a meeting (Reem phase 3 B2b): the one path that makes items out of
 * them, so it is `todo.write`, any signed-in member, and the model is never the approval. Body `{ kept: [{ ref, title?,
 * agent?, dueAt? }] }`: each ref must be in the item's stored pending set, and the owner's edits are checked by the same
 * limits as a proposal (refused, not trimmed): at most 10 entries, a title of at most 120 characters, an agent id or
 * "owner", a local day within 366 days. Authenticates first; the id is format-checked and must be a live `booking` item
 * of the caller's active brand (`sc(u)`), else 404; the body is read only after that and over 64 KB is refused unread.
 * The account and the scope are the session's, never the body's; who approved is the session's login. 200 `{ ok, created }`
 * with the new item ids; on a refusal `{ ok: false, error, field?, created? }` (`created` names the items made before an
 * allowance ran out). Nothing is charged. `sec:write:{email}`, like the other Reem writes.
 */
const MAX_BODY = 64_000;
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const { id } = await ctx.params;
  const scope = sc(u);
  if (!(await liveBooking(scope, id))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return NextResponse.json({ ok: false, error: "too_long" }, { status: 413 });
  let b: unknown = null;
  try { b = JSON.parse(text); } catch { /* a body that is not JSON is a bad request below */ }
  const kept = b && typeof b === "object" && !Array.isArray(b) ? (b as { kept?: unknown }).kept : undefined;
  const r = await approveMeeting(u, id, kept, { actor: "owner", via: "web", login: u.actor?.email });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}), ...(r.created?.length ? { created: r.created } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true, created: r.created });
}
