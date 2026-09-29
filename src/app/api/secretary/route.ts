import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { SEC_READS_PER_HOUR, agendaFor, createItem, listDeleted, listDone } from "@/lib/secretary";

/**
 * Reem's list for the signed-in owner's active brand (`sc(u)`).
 * GET: the agenda (computed now, with the approvals count), or `?view=done` / `?view=deleted`.
 * POST: add one item. The body's fields are validated in `createItem`; an `id`, `scope`, `email` or `source` in it is
 * ignored. 200 new items a day per account, 500 open items per brand.
 */
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const scope = sc(u);
  const view = new URL(req.url).searchParams.get("view");
  if (view === "done") return NextResponse.json({ ok: true, items: await listDone(scope) });
  if (view === "deleted") return NextResponse.json({ ok: true, items: await listDeleted(scope) });
  const agenda = await agendaFor(scope, Date.now(), { actor: "rule", via: "web" });
  return NextResponse.json({ ok: true, agenda });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const r = await createItem(u, body as Record<string, unknown>, { actor: "owner", via: "web", source: "owner" });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true, item: r.item });
}
