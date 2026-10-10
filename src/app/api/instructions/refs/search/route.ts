import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, INSTRUCTION_IMPORTS_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";
import { REF_QUERY_MAX, RefFail, searchRefs } from "@/lib/instruction-refs";

/**
 * POST `{ q? }` -> `{ ok, results: [{ id, title, kind: "doc" | "sheet", modified? }] }` (at most 10): the workspace's own
 * Google Docs and Sheets that match, found through the Composio login stored for this workspace (rules 955-956). Admin
 * and owner (`instructions.write`). The query is at most 100 characters and goes to Google only as a search argument;
 * no key is built from it. Its own hourly bucket, 30 searches per workspace (429 + Retry-After), apart from the imports
 * so that browsing the list never uses up the imports. 409 `not_connected` when Composio or the Google login is off,
 * 502 `upstream` for any failure at Composio or Google, with none of their text.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  if (!(await allow(`instr:srch:${sc(u)}`, INSTRUCTION_IMPORTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => null)) as { q?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if (b.q !== undefined && (typeof b.q !== "string" || b.q.length > REF_QUERY_MAX)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, results: await searchRefs(sc(u), typeof b.q === "string" ? b.q : "") });
  } catch (e) {
    const code = e instanceof RefFail ? e.code : "upstream";
    return NextResponse.json({ ok: false, error: code }, { status: code === "not_connected" ? 409 : 502 });
  }
}
