import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { entitlements } from "@/lib/entitlements";
import { forbid } from "@/lib/roles";
import { allow, INSTRUCTION_IMPORTS_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";
import { importRef, REF_ID, REF_TITLE_MAX, type RefError } from "@/lib/instruction-refs";

/**
 * POST `{ kind: "doc" | "sheet", id, title? }` -> `{ ok, name, title }`: read one Google Doc or Sheet through the
 * Composio login stored for this workspace and keep it as the workspace file `ref-<slug>.md` (at most 20,000 characters;
 * a Sheet as CSV), plus a record of where it came from so it can be refreshed (rules 955-956). Importing the same
 * source again overwrites its own file. Admin and owner (`instructions.write`) on a plan that allows reference files (403 `refs_plan`); 30 imports per workspace per hour
 * (429 + Retry-After). The id must match `[A-Za-z0-9_-]{10,100}` (400) and goes to Google only as a tool argument.
 * 409 `not_connected` / `files_full`, 404 `not_found`, 400 `empty`, 502 `upstream` with none of Composio's or
 * Google's text.
 */
const STATUS: Record<RefError, number> = { not_connected: 409, files_full: 409, not_found: 404, empty: 400, upstream: 502 };

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  // Attaching a reference file is a plan feature (`refs`): importing one for a plan that cannot attach it is no use.
  if (!entitlements(u).instructions.refs) return NextResponse.json({ ok: false, error: "refs_plan" }, { status: 403 });
  if (!(await allow(`instr:imp:${sc(u)}`, INSTRUCTION_IMPORTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => null)) as { kind?: unknown; id?: unknown; title?: unknown } | null;
  const bad = () => NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad();
  if ((b.kind !== "doc" && b.kind !== "sheet") || typeof b.id !== "string" || !REF_ID.test(b.id)) return bad();
  const title = typeof b.title === "string" ? b.title.slice(0, REF_TITLE_MAX) : undefined;
  const r = await importRef(sc(u), { kind: b.kind, id: b.id, title });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: STATUS[r.error] });
  return NextResponse.json({ ok: true, name: r.name, title: r.title });
}
